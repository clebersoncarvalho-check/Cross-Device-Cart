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

export async function cartSyncAction({ request }) {
  try {
    if (request.method !== "POST") {
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
      console.error("[cart-sync] proxy auth failed", authError);
      return proxyJson(
        cartSyncResponse({
          ok: false,
          code: CART_SYNC_CODES.PROXY_AUTH_FAILED,
          step: "proxy_auth",
        }),
      );
    }

    if (!admin) {
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

    if (!customerId) {
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
      return proxyJson(
        cartSyncResponse({
          ok: false,
          code: CART_SYNC_CODES.INVALID_ITEMS,
          step: "validate_items",
        }),
      );
    }

    const ownerId = `gid://shopify/Customer/${customerId}`;
    const value = JSON.stringify(items);

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
      console.error("[cart-sync] metafieldsSet request failed", graphqlError);

      if (isUnauthorizedAdminError(graphqlError)) {
        return proxyJson(
          cartSyncResponse({
            ok: false,
            code: CART_SYNC_CODES.ADMIN_TOKEN_EXPIRED,
            step: "save_metafield",
            shop,
          }),
        );
      }

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
      console.error("[cart-sync] metafieldsSet userErrors", userErrors);
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
      console.error("[cart-sync] metafieldsSet GraphQL errors", json.errors);
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

    console.info("[cart-sync] saved", {
      shop,
      customerId,
      itemCount: items.length,
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
    console.error("[cart-sync] unexpected error", error);

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
      console.error("[cart-sync] loader auth failed", authError);
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

    if (!customerId) {
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
        console.error("[cart-sync] load metafield GraphQL errors", json.errors);
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

      items = parseStoredCartItems(json?.data?.customer?.cartMetafield?.jsonValue);
    } catch (error) {
      console.error("[cart-sync] load metafield failed", error);

      if (isUnauthorizedAdminError(error)) {
        return proxyJson(
          cartSyncResponse({
            ok: false,
            code: CART_SYNC_CODES.ADMIN_TOKEN_EXPIRED,
            step: "load_cart",
            shop,
          }),
        );
      }

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

    console.info("[cart-sync] loaded", {
      shop,
      customerId,
      itemCount: items.length,
    });

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
    console.error("[cart-sync] loader error", error);
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
  return items ?? [];
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

export async function getCartSyncAdminStatus(admin, session) {
  const checks = {
    shop: session.shop,
    sessionOnline: session.isOnline,
    scopes: session.scope ?? null,
    adminApi: { ok: false, message: "Não testado" },
    metafieldDefinition: { ok: false, message: "Não testado" },
  };

  try {
    const shopResponse = await admin.graphql(`#graphql
      query CartSyncShopCheck {
        shop {
          name
          myshopifyDomain
        }
      }`);

    const shopJson = await shopResponse.json();

    if (shopJson.errors?.length) {
      checks.adminApi = {
        ok: false,
        message: "Admin API retornou erro",
        details: shopJson.errors,
      };
      return checks;
    }

    checks.adminApi = {
      ok: true,
      message: `Conectado à loja ${shopJson.data.shop.name}`,
      domain: shopJson.data.shop.myshopifyDomain,
    };
  } catch (error) {
    checks.adminApi = {
      ok: false,
      message: isUnauthorizedAdminError(error)
        ? "Token expirado ou inválido — reinstale o app e abra no Admin"
        : "Falha ao conectar na Admin API",
      details: error instanceof Error ? error.message : String(error),
    };
    return checks;
  }

  try {
    const definitionResponse = await admin.graphql(
      `#graphql
        query CartSyncMetafieldDefinition {
          metafieldDefinitions(first: 1, ownerType: CUSTOMER, namespace: "$app", key: "${METAFIELD_KEY}") {
            nodes {
              id
              name
              namespace
              key
              type {
                name
              }
            }
          }
        }`,
    );

    const definitionJson = await definitionResponse.json();
    const definition = definitionJson?.data?.metafieldDefinitions?.nodes?.[0];

    if (definition) {
      checks.metafieldDefinition = {
        ok: true,
        message: `Definição encontrada: ${definition.namespace}.${definition.key} (${definition.type.name})`,
        id: definition.id,
      };
    } else {
      checks.metafieldDefinition = {
        ok: false,
        message:
          "Definição app.dados_do_carrinho não encontrada — rode npm run deploy e reinstale",
      };
    }
  } catch (error) {
    checks.metafieldDefinition = {
      ok: false,
      message: "Erro ao buscar definição do metafield",
      details: error instanceof Error ? error.message : String(error),
    };
  }

  return checks;
}
