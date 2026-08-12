/**
 * Cross Device Cart
 * Network: filtre "cart-sync"
 * Save = POST | Leitura fallback = GET (app devolve cart)
 */
(function () {
  const CART_SYNC_URL = '/apps/cart-sync';
  const SAVE_DEBOUNCE_MS = 1200;
  const DEBUG = true;

  let saveTimer = null;
  let saveInFlight = false;
  let restoreInFlight = false;
  let lastSavedJson = '';

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

  function mapCartItems(cart) {
    return (cart.items || []).map(function (item) {
      return {
        id: item.variant_id || item.id,
        quantity: item.quantity,
      };
    });
  }

  function parseRemoteRaw(raw) {
    if (raw == null || raw === '') return [];

    if (typeof raw === 'string') {
      try {
        return parseRemoteRaw(JSON.parse(raw));
      } catch (e) {
        logWarn('remoteCartData string JSON inválida', raw);
        return [];
      }
    }

    if (Array.isArray(raw)) return raw;
    if (raw && Array.isArray(raw.items)) return raw.items;

    logWarn('remoteCartData formato não reconhecido', raw);
    return [];
  }

  function normalizeRemoteItems(rawList) {
    return parseRemoteRaw(rawList)
      .map(function (item) {
        return {
          id: Number(item.id),
          quantity: Number(item.quantity),
        };
      })
      .filter(function (item) {
        return (
          Number.isFinite(item.id) &&
          item.id > 0 &&
          Number.isFinite(item.quantity) &&
          item.quantity > 0
        );
      });
  }

  function getRemoteItemsFromLiquid() {
    return normalizeRemoteItems(window.remoteCartData);
  }

  async function fetchRemoteCartFromApp() {
    logInfo('GET ' + CART_SYNC_URL + ' (app lê metafield no servidor)');

    const res = await fetch(CART_SYNC_URL, {
      method: 'GET',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });

    const text = await res.text();
    logInfo('Resposta GET', { status: res.status, bodyPreview: text.slice(0, 500) });

    if (!res.ok) {
      throw new Error('GET retornou ' + res.status + ': ' + text);
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      throw new Error('GET não retornou JSON válido');
    }

    if (Array.isArray(data.cart)) return data.cart;
    if (Array.isArray(data.items)) return data.items;

    logWarn('GET sem lista cart/items', data);
    return [];
  }

  async function loadRemoteCartData() {
    logInfo('Debug Liquid', window.__cartSyncDebug || null);
    logInfo('remoteCartData bruto', window.remoteCartData);

    let items = getRemoteItemsFromLiquid();
    if (items.length > 0) {
      logOk('Metafield lido via Liquid', { itemCount: items.length, items: items });
      return items;
    }

    logWarn('Liquid vazio — tentando GET no app', {
      dica: 'Confira Storefront API ON no metafield + npm run deploy',
    });

    try {
      const fromApp = normalizeRemoteItems(await fetchRemoteCartFromApp());
      if (fromApp.length > 0) {
        window.remoteCartData = fromApp;
        logOk('Carrinho carregado via app (GET)', { itemCount: fromApp.length, items: fromApp });
        return fromApp;
      }
      logWarn('App GET também retornou vazio');
    } catch (err) {
      logError('Falha no GET /apps/cart-sync', err);
    }

    return [];
  }

  async function getLocalCartItemsStable() {
    let lastKey = null;
    let stableItems = [];

    for (let i = 0; i < 6; i++) {
      const cart = await fetch('/cart.js').then(function (r) {
        return r.json();
      });
      const items = mapCartItems(cart);
      const key = JSON.stringify(items);

      if (key === lastKey) return items;

      lastKey = key;
      stableItems = items;
      await new Promise(function (r) {
        setTimeout(r, 300);
      });
    }

    return stableItems;
  }

  async function addItemsToCart(items) {
    logInfo('POST /cart/add.js', items);

    const res = await fetch('/cart/add.js', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: items }),
    });

    const text = await res.text();
    let data;

    try {
      data = JSON.parse(text);
    } catch (e) {
      throw new Error('Resposta inválida /cart/add.js: ' + text);
    }

    logInfo('Resposta /cart/add.js', { status: res.status, data: data });

    if (!res.ok || (data.status && data.status >= 400)) {
      throw new Error(data.description || data.message || 'Falha ao adicionar');
    }

    if (typeof window.refreshCart === 'function') {
      logInfo('refreshCart()');
      await window.refreshCart(null, { openMinicart: false });
    } else {
      document.dispatchEvent(new CustomEvent('cart:refresh'));
      document.dispatchEvent(new CustomEvent('cart:updated'));
    }

    return data;
  }

  async function saveCartToAccount() {
    if (!window.__cartSyncEnabled) {
      logInfo('Save ignorado — não logado');
      return;
    }
    if (restoreInFlight || saveInFlight) return;

    saveInFlight = true;

    try {
      const items = await getLocalCartItemsStable();
      const payload = JSON.stringify({ items: items });

      if (payload === lastSavedJson) {
        logInfo('Save ignorado — igual ao último');
        return;
      }

      logInfo('POST /apps/cart-sync — enviando', {
        itemCount: items.length,
        items: items,
      });

      const res = await fetch(CART_SYNC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
      });

      const text = await res.text();
      let data;

      try {
        data = JSON.parse(text);
      } catch (e) {
        logWarn('POST não retornou JSON', { status: res.status, body: text });
        return;
      }

      if (data.ok) {
        lastSavedJson = payload;
        logOk('Salvo no metafield', data);
      } else {
        logWarn(formatResponse(data), data);
      }
    } catch (err) {
      logError('Erro no save', err);
    } finally {
      saveInFlight = false;
    }
  }

  function scheduleSave(source) {
    if (restoreInFlight) {
      logInfo('Save adiado — restore em andamento', { source: source });
      return;
    }
    logInfo('Save agendado', { source: source, delayMs: SAVE_DEBOUNCE_MS });
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveCartToAccount, SAVE_DEBOUNCE_MS);
  }

  async function rebuildCart() {
    if (!window.__cartSyncEnabled) {
      logInfo('Restore ignorado — não logado');
      return;
    }

    restoreInFlight = true;

    try {
      const remote = await loadRemoteCartData();

      if (remote.length === 0) {
        logWarn('Nada para restaurar');
        return;
      }

      const local = await fetch('/cart.js').then(function (r) {
        return r.json();
      });

      logInfo('Local antes restore', { item_count: local.item_count, items: mapCartItems(local) });

      if (local.item_count > 0) {
        logInfo('Limpando carrinho local');
        const clearRes = await fetch('/cart/clear.js', { method: 'POST' });
        if (!clearRes.ok) logWarn('Falha ao limpar', await clearRes.text());
        else logOk('Carrinho local limpo');
      }

      await addItemsToCart(
        remote.map(function (item) {
          return { id: item.id, quantity: item.quantity };
        })
      );

      const after = await fetch('/cart.js').then(function (r) {
        return r.json();
      });

      logInfo('Local após restore', { item_count: after.item_count, items: mapCartItems(after) });

      lastSavedJson = JSON.stringify({ items: remote });
      logOk('Restore concluído', { itemCount: remote.length, items: remote });
    } catch (err) {
      logError('Erro no restore', err);
    } finally {
      restoreInFlight = false;
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    logInfo('Inicializado', {
      enabled: window.__cartSyncEnabled,
      debug: window.__cartSyncDebug,
      remoteCartData: window.remoteCartData,
    });
    rebuildCart();
  });

  document.addEventListener('cart:updated', function () {
    scheduleSave('cart:updated');
  });

  document.addEventListener('cart:change', function () {
    scheduleSave('cart:change');
  });

  document.addEventListener('click', function (e) {
    if (
      e.target.closest(
        'form[action*="/cart/add"] button, form[action*="/cart/add"] [type="submit"], [name="add"]'
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
      e.target.matches(
        '[name="updates[]"], .cart-quantity, .quantity__input, quantity-input input'
      )
    ) {
      scheduleSave('change-qty');
    }
  });
})();
