/**
 * Cross Device Cart
 */
(function () {
  const CART_SYNC_URL = '/apps/cart-sync';
  const SAVE_DEBOUNCE_MS = 1200;
  const MIN_VARIANT_ID = 1000000000;
  const SESSION_CUSTOMER_KEY = 'cartSyncCustomerId';
  const LEGACY_RESTORE_KEY = 'cartSyncRestored';

  const nativeFetch = window.fetch.bind(window);

  let saveTimer = null;
  let saveInFlight = false;
  let restoreInFlight = false;
  let pendingSave = false;
  let pendingSaveOptions = null;
  let lastSavedJson = '';
  let interceptInstalled = false;

  function formatResponse(data) {
    if (!data || typeof data !== 'object') return String(data);
    return [data.code, data.message, data.hint ? 'Dica: ' + data.hint : '']
      .filter(Boolean)
      .join(' — ');
  }

  function getCustomerId() {
    var id = window.__cartSyncCustomerId;
    if (id == null || id === '') return null;
    return String(id);
  }

  function isLoggedIn() {
    return Boolean(window.__cartSyncEnabled && getCustomerId());
  }

  function clearRestoreSession() {
    try {
      sessionStorage.removeItem(SESSION_CUSTOMER_KEY);
      sessionStorage.removeItem(LEGACY_RESTORE_KEY);
    } catch (e) {
      /* sessionStorage pode falhar em iframe restrito */
    }
  }

  function markRestored(customerId) {
    try {
      sessionStorage.setItem(SESSION_CUSTOMER_KEY, customerId);
      sessionStorage.removeItem(LEGACY_RESTORE_KEY);
    } catch (e) {
      /* ignore */
    }
  }

  function alreadyRestoredFor(customerId) {
    try {
      return sessionStorage.getItem(SESSION_CUSTOMER_KEY) === customerId;
    } catch (e) {
      return false;
    }
  }

  function isCartAddUrl(url) {
    if (!url) return false;
    try {
      var path = new URL(url, window.location.origin).pathname;
      return path === '/cart/add' || path === '/cart/add.js';
    } catch (e) {
      return /\/cart\/add(\.js)?(\?|$)/.test(String(url));
    }
  }

  function requestUrl(input) {
    if (!input) return '';
    if (typeof input === 'string') return input;
    if (typeof URL !== 'undefined' && input instanceof URL) return input.href;
    return input.url || '';
  }

  function isFailedCartAddPayload(data) {
    return Boolean(data && data.status && Number(data.status) >= 400);
  }

  function toVariantId(item) {
    return Number(item.variant_id || item.id);
  }

  function isValidVariantId(id) {
    var n = Number(id);
    return Number.isFinite(n) && n >= MIN_VARIANT_ID;
  }

  function mapCartItems(cart) {
    return (cart.items || [])
      .map(function (item) {
        return {
          id: toVariantId(item),
          quantity: Number(item.quantity),
        };
      })
      .filter(function (item) {
        return isValidVariantId(item.id) && item.quantity > 0;
      });
  }

  function parseRemoteRaw(raw) {
    if (raw == null || raw === '') return [];
    if (typeof raw === 'string') {
      try {
        return parseRemoteRaw(JSON.parse(raw));
      } catch (e) {
        return [];
      }
    }
    if (Array.isArray(raw)) return raw;
    if (raw && Array.isArray(raw.items)) return raw.items;
    if (raw && Array.isArray(raw.cart)) return raw.cart;
    return [];
  }

  function normalizeRemoteItems(rawList) {
    return parseRemoteRaw(rawList)
      .map(function (item) {
        return { id: Number(item.id || item.variant_id), quantity: Number(item.quantity) };
      })
      .filter(function (item) {
        return isValidVariantId(item.id) && Number.isFinite(item.quantity) && item.quantity > 0;
      });
  }

  function itemsFromAppPayload(data) {
    if (data.ok === false) {
      throw new Error(formatResponse(data));
    }
    if (Array.isArray(data.cart)) return data.cart;
    if (Array.isArray(data.items)) return data.items;
    return [];
  }

  async function fetchRemoteCartFromApp() {
    var prefetch = window.__cartSyncPrefetch;
    window.__cartSyncPrefetch = null;

    if (prefetch) {
      return itemsFromAppPayload(await prefetch);
    }

    var res = await nativeFetch(CART_SYNC_URL, {
      method: 'GET',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });
    var text = await res.text();
    if (!res.ok) throw new Error('GET ' + res.status + ': ' + text);
    return itemsFromAppPayload(JSON.parse(text));
  }

  async function loadRemoteCartData() {
    return normalizeRemoteItems(await fetchRemoteCartFromApp());
  }

  async function getLocalCartItemsStable() {
    var lastKey = null;
    var stableItems = [];
    for (var i = 0; i < 6; i++) {
      var cart = await nativeFetch('/cart.js', { credentials: 'same-origin' }).then(function (r) {
        return r.json();
      });
      var items = mapCartItems(cart);
      var key = JSON.stringify(items);
      if (key === lastKey) return items;
      lastKey = key;
      stableItems = items;
      await new Promise(function (r) {
        setTimeout(r, 300);
      });
    }
    return stableItems;
  }

  async function getLocalCartItemsOnce(keepalive) {
    var cart = await nativeFetch('/cart.js', {
      credentials: 'same-origin',
      keepalive: Boolean(keepalive),
    }).then(function (r) {
      return r.json();
    });
    return mapCartItems(cart);
  }

  function queuePendingSave(options) {
    pendingSave = true;
    if (options && (options.immediate || options.keepalive)) {
      pendingSaveOptions = Object.assign({}, pendingSaveOptions || {}, options);
    }
  }

  async function saveCartToAccount(options) {
    var skipEmpty = options && options.skipEmpty;
    var immediate = options && options.immediate;
    var keepalive = options && options.keepalive;
    if (!isLoggedIn()) return;
    if (restoreInFlight) {
      queuePendingSave(options);
      return;
    }
    if (saveInFlight) {
      queuePendingSave(options);
      return;
    }

    saveInFlight = true;
    pendingSave = false;
    pendingSaveOptions = null;

    try {
      var items = immediate
        ? await getLocalCartItemsOnce(keepalive)
        : await getLocalCartItemsStable();
      if (skipEmpty && items.length === 0) return;

      var payload = JSON.stringify({
        items: items,
        clear: items.length === 0,
      });

      if (payload === lastSavedJson) return;

      var res = await nativeFetch(CART_SYNC_URL, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        keepalive: Boolean(keepalive),
      });
      var text = await res.text();
      var data;
      try {
        data = JSON.parse(text);
      } catch (e) {
        return;
      }

      if (data.ok) lastSavedJson = payload;
    } catch (err) {
      /* ignore */
    } finally {
      saveInFlight = false;
      if (pendingSave) {
        var nextOptions = pendingSaveOptions;
        pendingSave = false;
        pendingSaveOptions = null;
        saveCartToAccount(nextOptions || undefined);
      }
    }
  }

  function saveAfterCartAdd() {
    if (!isLoggedIn() || restoreInFlight) return;
    clearTimeout(saveTimer);
    saveCartToAccount({ immediate: true, keepalive: true });
  }

  function installCartAddIntercept() {
    if (interceptInstalled) return;
    interceptInstalled = true;

    window.fetch = function (input, init) {
      var url = requestUrl(input);
      var watching = isCartAddUrl(url);

      return nativeFetch(input, init).then(function (res) {
        if (!watching) return res;

        var clone = res.clone();
        return clone
          .json()
          .then(function (data) {
            if (res.ok && !isFailedCartAddPayload(data)) {
              saveAfterCartAdd();
            }
            return res;
          })
          .catch(function () {
            if (res.ok) saveAfterCartAdd();
            return res;
          });
      });
    };
  }

  function scheduleSave(source, event) {
    if (event && event.detail && event.detail.source === 'cart-sync') {
      return;
    }
    if (restoreInFlight) {
      pendingSave = true;
      return;
    }
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      saveCartToAccount();
    }, SAVE_DEBOUNCE_MS);
  }

  async function addItemsToCart(items) {
    var res = await nativeFetch('/cart/add.js', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: items }),
    });
    var text = await res.text();
    var data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      throw new Error('Resposta inválida /cart/add.js: ' + text);
    }
    if (!res.ok || (data.status && data.status >= 400)) {
      throw new Error(data.description || data.message || 'Falha ao adicionar');
    }
    if (typeof window.refreshCart === 'function') {
      Promise.resolve(window.refreshCart(null, { openMinicart: false })).catch(function () {});
    } else {
      document.dispatchEvent(new CustomEvent('cart:refresh', { detail: { source: 'cart-sync' } }));
      document.dispatchEvent(new CustomEvent('cart:updated', { detail: { source: 'cart-sync' } }));
    }
    return data;
  }

  async function rebuildCart() {
    if (!isLoggedIn()) {
      clearRestoreSession();
      return;
    }

    var customerId = getCustomerId();
    if (alreadyRestoredFor(customerId)) return;

    restoreInFlight = true;

    try {
      var localPromise = nativeFetch('/cart.js', { credentials: 'same-origin' }).then(function (r) {
        return r.json();
      });
      var remote = await loadRemoteCartData();
      if (remote.length === 0) {
        markRestored(customerId);
        return;
      }

      var local = await localPromise;
      var localItems = mapCartItems(local);

      if (JSON.stringify(localItems) === JSON.stringify(remote)) {
        lastSavedJson = JSON.stringify({ items: remote, clear: false });
        markRestored(customerId);
        return;
      }

      if (local.item_count > 0) {
        var clearRes = await nativeFetch('/cart/clear.js', { method: 'POST' });
        if (!clearRes.ok) return;
      }

      try {
        await addItemsToCart(remote);
      } catch (addErr) {
        return;
      }

      lastSavedJson = JSON.stringify({ items: remote, clear: false });
      markRestored(customerId);
    } catch (err) {
      /* ignore */
    } finally {
      restoreInFlight = false;
      if (pendingSave) {
        var nextOptions = pendingSaveOptions || { skipEmpty: true };
        pendingSave = false;
        pendingSaveOptions = null;
        saveCartToAccount(nextOptions);
      }
    }
  }

  function bindCartSaveEvents() {
    var sources = ['cart:update', 'cart:updated', 'cart:change', 'cart:refresh'];
    sources.forEach(function (name) {
      document.addEventListener(name, function (event) {
        scheduleSave(name, event);
      });
    });
  }

  bindCartSaveEvents();
  rebuildCart();

  document.addEventListener('click', function (e) {
    if (
      e.target.closest(
        'form[action*="/cart/add"] button, form[action*="/cart/add"] [type="submit"], [name="add"], [data-action="add-to-cart"], add-to-cart-component button'
      )
    ) {
      scheduleSave('click-add');
    }
    if (
      e.target.closest(
        '[data-cart-remove], .cart-remove, .cart__remove, [href*="quantity=0"], button[name="remove"]'
      )
    ) {
      scheduleSave('click-remove');
    }
  });

  document.addEventListener('change', function (e) {
    if (
      e.target.matches('[name="updates[]"], .cart-quantity, .quantity__input, quantity-input input')
    ) {
      scheduleSave('change-qty');
    }
  });

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') {
      clearTimeout(saveTimer);
      saveCartToAccount({ skipEmpty: true });
    }
  });

  installCartAddIntercept();
})();
