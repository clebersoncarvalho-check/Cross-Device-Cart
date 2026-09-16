/**
 * Cross Device Cart
 * Network: filtre "cart-sync"  |  POST = salvar  |  GET = buscar no app
 */
(function () {
  const CART_SYNC_URL = '/apps/cart-sync';
  const SAVE_DEBOUNCE_MS = 1200;
  const MIN_VARIANT_ID = 1000000000;
  const SESSION_CUSTOMER_KEY = 'cartSyncCustomerId';
  const LEGACY_RESTORE_KEY = 'cartSyncRestored';
  const DEBUG = true;

  const nativeFetch = window.fetch.bind(window);

  let saveTimer = null;
  let saveInFlight = false;
  let restoreInFlight = false;
  let pendingSave = false;
  let pendingSaveOptions = null;
  let lastSavedJson = '';
  let interceptInstalled = false;

  function logOk(msg, data) {
    console.log('[cart-sync] ✅ ' + msg, data !== undefined ? data : '');
  }
  function logWarn(msg, data) {
    console.warn('[cart-sync] ❌ ' + msg, data !== undefined ? data : '');
  }
  function logInfo(msg, data) {
    if (DEBUG) console.log('[cart-sync] ℹ️ ' + msg, data !== undefined ? data : '');
  }
  function logError(msg, err) {
    console.error('[cart-sync] 🔴 ' + msg, err);
  }

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
        logWarn('JSON inválido no app', raw);
        return [];
      }
    }
    if (Array.isArray(raw)) return raw;
    if (raw && Array.isArray(raw.items)) return raw.items;
    if (raw && Array.isArray(raw.cart)) return raw.cart;
    return [];
  }

  function normalizeRemoteItems(rawList) {
    var parsed = parseRemoteRaw(rawList);
    var items = parsed
      .map(function (item) {
        return { id: Number(item.id || item.variant_id), quantity: Number(item.quantity) };
      })
      .filter(function (item) {
        return isValidVariantId(item.id) && Number.isFinite(item.quantity) && item.quantity > 0;
      });

    var dropped = parsed.length - items.length;
    if (dropped > 0) {
      logWarn('Itens inválidos ignorados (use variant_id)', {
        dropped: dropped,
        kept: items,
      });
    }
    return items;
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
      logInfo('GET ' + CART_SYNC_URL + ' (prefetch do head)');
      var prefetched = await prefetch;
      logInfo('Resposta GET prefetch', prefetched);
      return itemsFromAppPayload(prefetched);
    }

    logInfo('GET ' + CART_SYNC_URL);
    var res = await nativeFetch(CART_SYNC_URL, {
      method: 'GET',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });
    var text = await res.text();
    logInfo('Resposta GET', { status: res.status, bodyPreview: text.slice(0, 500) });
    if (!res.ok) throw new Error('GET ' + res.status + ': ' + text);
    return itemsFromAppPayload(JSON.parse(text));
  }

  async function loadRemoteCartData() {
    logInfo('Buscando carrinho no app', { customerId: getCustomerId() });
    try {
      var fromApp = normalizeRemoteItems(await fetchRemoteCartFromApp());
      if (fromApp.length > 0) {
        logOk('Carrinho via GET', fromApp);
        return fromApp;
      }
      logInfo('GET sem itens válidos');
    } catch (err) {
      logError('Falha GET', err);
      throw err;
    }
    return [];
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
    if (!isLoggedIn()) {
      logInfo('Save ignorado — não logado');
      return;
    }
    if (restoreInFlight) {
      queuePendingSave(options);
      logInfo('Save adiado — restore em andamento');
      return;
    }
    if (saveInFlight) {
      queuePendingSave(options);
      logInfo('Save na fila — outro save em andamento');
      return;
    }

    saveInFlight = true;
    pendingSave = false;
    pendingSaveOptions = null;

    try {
      var items = immediate
        ? await getLocalCartItemsOnce(keepalive)
        : await getLocalCartItemsStable();
      if (skipEmpty && items.length === 0) {
        logInfo('Save vazio ignorado (visibility/logout)');
        return;
      }

      var payload = JSON.stringify({
        items: items,
        clear: items.length === 0,
      });

      if (payload === lastSavedJson) {
        logInfo('Save ignorado — igual ao último', items);
        return;
      }

      logInfo('POST /apps/cart-sync', {
        itemCount: items.length,
        items: items,
        immediate: Boolean(immediate),
        keepalive: Boolean(keepalive),
      });

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
        logWarn('POST não retornou JSON', { status: res.status, body: text });
        return;
      }

      if (data.ok) {
        lastSavedJson = payload;
        logOk(data.skipped ? 'Save vazio ignorado pelo app' : 'Salvo no app', data);
      } else {
        logWarn(formatResponse(data), data);
      }
    } catch (err) {
      logError('Erro no save', err);
    } finally {
      saveInFlight = false;
      if (pendingSave) {
        var nextOptions = pendingSaveOptions;
        pendingSave = false;
        pendingSaveOptions = null;
        logInfo('Rodando save que estava na fila');
        saveCartToAccount(nextOptions || undefined);
      }
    }
  }

  function saveAfterCartAdd() {
    if (!isLoggedIn() || restoreInFlight) return;
    clearTimeout(saveTimer);
    logInfo('Save imediato após /cart/add');
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
      logInfo('Save adiado', { source: source });
      return;
    }
    logInfo('Save agendado', { source: source, delayMs: SAVE_DEBOUNCE_MS });
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      saveCartToAccount();
    }, SAVE_DEBOUNCE_MS);
  }

  async function addItemsToCart(items) {
    logInfo('POST /cart/add.js', items);
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
      Promise.resolve(window.refreshCart(null, { openMinicart: false })).catch(function (err) {
        logWarn('refreshCart falhou depois do restore', err);
      });
    } else {
      document.dispatchEvent(new CustomEvent('cart:refresh', { detail: { source: 'cart-sync' } }));
      document.dispatchEvent(new CustomEvent('cart:updated', { detail: { source: 'cart-sync' } }));
    }
    return data;
  }

  async function rebuildCart() {
    if (!isLoggedIn()) {
      clearRestoreSession();
      logInfo('Restore ignorado — não logado (sessão de restore limpa)');
      return;
    }

    var customerId = getCustomerId();
    if (alreadyRestoredFor(customerId)) {
      logInfo('Restore já rodou neste login — pulando', { customerId: customerId });
      return;
    }

    restoreInFlight = true;

    try {
      var localPromise = nativeFetch('/cart.js', { credentials: 'same-origin' }).then(function (r) {
        return r.json();
      });
      var remote = await loadRemoteCartData();
      if (remote.length === 0) {
        logInfo('Nada válido para restaurar (não limpa o carrinho)');
        markRestored(customerId);
        return;
      }

      var local = await localPromise;
      var localItems = mapCartItems(local);
      logInfo('Local antes restore', { item_count: local.item_count, items: localItems });

      if (JSON.stringify(localItems) === JSON.stringify(remote)) {
        logOk('Carrinho local já igual ao app');
        lastSavedJson = JSON.stringify({ items: remote, clear: false });
        markRestored(customerId);
        return;
      }

      if (local.item_count > 0) {
        logInfo('Limpando carrinho local antes do restore');
        var clearRes = await nativeFetch('/cart/clear.js', { method: 'POST' });
        if (!clearRes.ok) {
          logWarn('Falha ao limpar — aborta restore para não perder itens', await clearRes.text());
          return;
        }
      }

      try {
        await addItemsToCart(remote);
      } catch (addErr) {
        logError('Restore falhou no add (id inválido?). Carrinho pode ter sido limpo.', addErr);
        return;
      }

      lastSavedJson = JSON.stringify({ items: remote, clear: false });
      markRestored(customerId);
      logOk('Restore concluído', remote);
    } catch (err) {
      logError('Erro no restore', err);
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

  logInfo('Inicializado', {
    enabled: window.__cartSyncEnabled,
    customerId: getCustomerId(),
  });
  bindCartSaveEvents();
  rebuildCart();

  document.addEventListener(
    'click',
    function (e) {
      if (e.target.closest('madesa-buy-now')) {
        logInfo('Clique Comprar agora (save sai no /cart/add.js)');
      }
    },
    true
  );

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
