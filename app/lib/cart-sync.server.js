import { authenticate } from "../shopify.server";
import {
  CART_SYNC_CODES,
  cartSyncResponse,
  isUnauthorizedAdminError,
  proxyJson,
} from "./cart-sync-responses.server";

export const METAFIELD_NAMESPACE = "$app";
export const METAFIELD_KEY = "dados_do_carrinho";
export const METAFIELD_TYPE = "json";

function logInfo(message, extra) {
  if (extra === undefined) {
    console.info("[cart-sync]", message);
    return;
  }
  console.info("[cart-sync]", message, extra);
}

function logError(message, extra) {
  if (extra === undefined) {
    console.error("[cart-sync]", message);
    return;
  }
  console.error("[cart-sync]", message, extra);
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

export async function cartSyncAction({ request }) {
  try {
    if (request.method !== "POST") {
      logError("Método não permitido no save. Use POST.", {
        method: request.method,
      });
      return proxyJson(
        cartSyncResponse({
          ok: false,
          code: CART_SYNC_CODES.METHOD_NOT_ALLOWED,
          step: "validate_method",
        }),
      );
    }

    let admin;
    try {
      ({ admin } = await authenticate.public.appProxy(request));
    } catch (authError) {
      logError("Falha na autenticação do App Proxy no save.", {
        erro: errorText(authError),
      });
      return proxyJson(
        cartSyncResponse({
          ok: false,
          code: CART_SYNC_CODES.PROXY_AUTH_FAILED,
          step: "proxy_auth",
        }),
      );
    }

    if (!admin) {
      logError(
        "Save recusado: sem sessão Admin. Abra o app no Admin da loja.",
      );
      return proxyJson(
        cartSyncResponse({
          ok: false,
          code: CART_SYNC_CODES.NO_ADMIN_SESSION,
          step: "admin_session",
        }),
      );
    }

    const url = new URL(request.url);
    const customerId = url.searchParams.get("logged_in_customer_id");
    const shop = url.searchParams.get("shop");

    logInfo("POST recebido para salvar carrinho.", { shop, customerId });

    if (!customerId) {
      logError("Save recusado: cliente não está logado na vitrine.", { shop });
      return proxyJson(
        cartSyncResponse({
          ok: false,
          code: CART_SYNC_CODES.NOT_LOGGED_IN,
          step: "customer_auth",
          shop,
        }),
      );
    }

    let body;
    try {
      body = await request.json();
    } catch {
      logError("Save recusado: body do POST não é um JSON válido.", {
        shop,
        customerId,
      });
      return proxyJson(
        cartSyncResponse({
          ok: false,
          code: CART_SYNC_CODES.INVALID_JSON,
          step: "parse_body",
        }),
      );
    }

    const items = normalizeItems(body?.items);
    if (items === null) {
      logError("Save recusado: lista de itens inválida.", {
        shop,
        customerId,
        itemsRecebidos: body?.items,
      });
      return proxyJson(
        cartSyncResponse({
          ok: false,
          code: CART_SYNC_CODES.INVALID_ITEMS,
          step: "validate_items",
        }),
      );
    }

    if (items.length === 0 && body?.clear !== true) {
      logInfo("Save vazio ignorado. Metafield não foi apagado.", {
        shop,
        customerId,
      });
      return proxyJson(
        cartSyncResponse({
          ok: true,
          code: CART_SYNC_CODES.EMPTY_SAVE_SKIPPED,
          step: "skip_empty_save",
          skipped: true,
          customerId,
          itemCount: 0,
          items,
          shop,
        }),
      );
    }

    const ownerId = `gid://shopify/Customer/${customerId}`;
    const value = JSON.stringify(items);

    logInfo("Gravando carrinho no metafield do cliente.", {
      shop,
      customerId,
      itemCount: items.length,
      items,
      clear: items.length === 0,
    });

    let response;
    try {
      response = await admin.graphql(
        `#graphql
          mutation CartSyncMetafieldsSet($metafields: [MetafieldsSetInput!]!) {
            metafieldsSet(metafields: $metafields) {
              metafields {
                id
                namespace
                key
                value
              }
              userErrors {
                field
                message
                code
              }
            }
          }`,
        {
          variables: {
            metafields: [
              {
                ownerId,
                namespace: METAFIELD_NAMESPACE,
                key: METAFIELD_KEY,
                type: METAFIELD_TYPE,
                value,
              },
            ],
          },
        },
      );
    } catch (graphqlError) {
      if (isUnauthorizedAdminError(graphqlError)) {
        logError("Token Admin expirado ou inválido ao gravar o metafield.", {
          shop,
          customerId,
          erro: errorText(graphqlError),
        });
        return proxyJson(
          cartSyncResponse({
            ok: false,
            code: CART_SYNC_CODES.ADMIN_TOKEN_EXPIRED,
            step: "save_metafield",
            shop,
          }),
        );
      }

      logError("Falha na requisição para gravar o metafield.", {
        shop,
        customerId,
        erro: errorText(graphqlError),
      });
      return proxyJson(
        cartSyncResponse({
          ok: false,
          code: CART_SYNC_CODES.ADMIN_API_ERROR,
          step: "save_metafield",
          details:
            graphqlError instanceof Error
              ? graphqlError.message
              : String(graphqlError),
          shop,
        }),
      );
    }

    const json = await response.json();
    const userErrors = json?.data?.metafieldsSet?.userErrors ?? [];

    if (userErrors.length > 0) {
      logError("Shopify recusou a gravação do metafield.", {
        shop,
        customerId,
        userErrors,
      });
      return proxyJson(
        cartSyncResponse({
          ok: false,
          code: CART_SYNC_CODES.METAFIELD_ERROR,
          step: "save_metafield",
          userErrors,
          shop,
        }),
      );
    }

    if (json?.errors?.length) {
      logError("Erro GraphQL ao gravar o metafield.", {
        shop,
        customerId,
        errors: json.errors,
      });
      return proxyJson(
        cartSyncResponse({
          ok: false,
          code: CART_SYNC_CODES.ADMIN_API_ERROR,
          step: "save_metafield",
          details: json.errors,
          shop,
        }),
      );
    }

    logInfo("Carrinho salvo no metafield.", {
      shop,
      customerId,
      itemCount: items.length,
      items,
    });

    return proxyJson(
      cartSyncResponse({
        ok: true,
        code: CART_SYNC_CODES.SUCCESS,
        step: "done",
        customerId,
        itemCount: items.length,
        items,
        shop,
      }),
    );
  } catch (error) {
    logError("Erro inesperado no POST de save.", { erro: errorText(error) });

    if (isUnauthorizedAdminError(error)) {
      return proxyJson(
        cartSyncResponse({
          ok: false,
          code: CART_SYNC_CODES.ADMIN_TOKEN_EXPIRED,
          step: "unknown",
        }),
      );
    }

    return proxyJson(
      cartSyncResponse({
        ok: false,
        code: CART_SYNC_CODES.UNEXPECTED_ERROR,
        step: "unknown",
        details: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

export async function cartSyncLoader({ request }) {
  try {
    let admin;
    try {
      ({ admin } = await authenticate.public.appProxy(request));
    } catch (authError) {
      logError("Falha na autenticação do App Proxy no GET.", {
        erro: errorText(authError),
      });
      return proxyJson(
        cartSyncResponse({
          ok: false,
          code: CART_SYNC_CODES.PROXY_AUTH_FAILED,
          step: "load_cart",
        }),
      );
    }

    const url = new URL(request.url);
    const customerId = url.searchParams.get("logged_in_customer_id");
    const shop = url.searchParams.get("shop");

    logInfo("GET recebido para carregar carrinho.", { shop, customerId });

    if (!customerId) {
      logInfo("GET sem cliente logado. Respondendo health check.", { shop });
      return proxyJson(
        cartSyncResponse({
          ok: true,
          code: CART_SYNC_CODES.HEALTH_OK,
          step: "health_check",
          loggedIn: false,
          customerId: null,
          cart: [],
          items: [],
          itemCount: 0,
          shop,
          endpoint: "/apps/cart-sync",
          saveMethod: "POST",
        }),
      );
    }

    if (!admin) {
      logError(
        "GET recusado: sem sessão Admin. Abra o app no Admin da loja.",
        { shop, customerId },
      );
      return proxyJson(
        cartSyncResponse({
          ok: false,
          code: CART_SYNC_CODES.NO_ADMIN_SESSION,
          step: "load_cart",
          shop,
        }),
      );
    }

    let items = [];

    logInfo("Lendo metafield do carrinho do cliente.", { shop, customerId });

    try {
      const response = await admin.graphql(
        `#graphql
          query CartSyncLoadMetafield($customerId: ID!) {
            customer(id: $customerId) {
              cartMetafield: metafield(namespace: "$app", key: "${METAFIELD_KEY}") {
                jsonValue
              }
            }
          }`,
        {
          variables: {
            customerId: `gid://shopify/Customer/${customerId}`,
          },
        },
      );

      const json = await response.json();

      if (json?.errors?.length) {
        logError("Erro GraphQL ao ler o metafield do carrinho.", {
          shop,
          customerId,
          errors: json.errors,
        });
        return proxyJson(
          cartSyncResponse({
            ok: false,
            code: CART_SYNC_CODES.ADMIN_API_ERROR,
            step: "load_cart",
            details: json.errors,
            shop,
          }),
        );
      }

      items = parseStoredCartItems(
        json?.data?.customer?.cartMetafield?.jsonValue,
      );
    } catch (error) {
      if (isUnauthorizedAdminError(error)) {
        logError("Token Admin expirado ou inválido ao ler o metafield.", {
          shop,
          customerId,
          erro: errorText(error),
        });
        return proxyJson(
          cartSyncResponse({
            ok: false,
            code: CART_SYNC_CODES.ADMIN_TOKEN_EXPIRED,
            step: "load_cart",
            shop,
          }),
        );
      }

      logError("Falha ao ler o metafield do carrinho.", {
        shop,
        customerId,
        erro: errorText(error),
      });
      return proxyJson(
        cartSyncResponse({
          ok: false,
          code: CART_SYNC_CODES.ADMIN_API_ERROR,
          step: "load_cart",
          details: error instanceof Error ? error.message : String(error),
          shop,
        }),
      );
    }

    if (items.length === 0) {
      logInfo("Metafield vazio. Nenhum item para restaurar.", {
        shop,
        customerId,
      });
    } else {
      logInfo("Carrinho carregado do metafield.", {
        shop,
        customerId,
        itemCount: items.length,
        items,
      });
    }

    return proxyJson(
      cartSyncResponse({
        ok: true,
        code: CART_SYNC_CODES.CART_LOADED,
        step: "load_cart",
        loggedIn: true,
        customerId,
        cart: items,
        items,
        itemCount: items.length,
        shop,
        endpoint: "/apps/cart-sync",
        saveMethod: "POST",
      }),
    );
  } catch (error) {
    logError("Erro inesperado no GET de load.", { erro: errorText(error) });
    return proxyJson(
      cartSyncResponse({
        ok: false,
        code: CART_SYNC_CODES.UNEXPECTED_ERROR,
        step: "load_cart",
        details: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

function parseStoredCartItems(rawItems) {
  if (rawItems == null) {
    return [];
  }

  const items = normalizeItems(rawItems);
  if (items === null) {
    logError("Metafield do carrinho com formato inválido.", { rawItems });
    return [];
  }
  return items;
}

function normalizeItems(rawItems) {
  if (!Array.isArray(rawItems)) {
    return null;
  }

  const items = [];

  for (const item of rawItems) {
    if (item == null || typeof item !== "object") {
      return null;
    }

    const id = item.id;
    const quantity = Number(item.quantity);

    if (id == null || id === "" || !Number.isFinite(quantity) || quantity < 0) {
      return null;
    }

    if (quantity === 0) {
      continue;
    }

    items.push({
      id: typeof id === "string" || typeof id === "number" ? id : String(id),
      quantity: Math.floor(quantity),
    });
  }

  return items;
}
