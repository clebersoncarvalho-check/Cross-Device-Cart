import { authenticate } from "../shopify.server";

// App-owned metafield (declared in shopify.app.toml)
const METAFIELD_NAMESPACE = "$app";
const METAFIELD_KEY = "dados_do_carrinho";
const METAFIELD_TYPE = "json";

/**
 * App Proxy API: storefront POST /apps/cart-sync → /proxy/cart-sync
 *
 * Shopify replaces non-2xx proxy responses with the store theme HTML.
 * Always return 200 + JSON so the theme can read errors.
 */
function proxyJson(body, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

export const action = async ({ request }) => {
  try {
    if (request.method !== "POST") {
      return proxyJson({ ok: false, error: "Method not allowed" });
    }

    let admin;
    try {
      ({ admin } = await authenticate.public.appProxy(request));
    } catch (authError) {
      console.error("cart-sync proxy auth failed", authError);
      return proxyJson({
        ok: false,
        error: "App proxy authentication failed",
        hint: "Open the app once in Shopify Admin (press p in shopify app dev), then retry.",
      });
    }

    if (!admin) {
      return proxyJson({
        ok: false,
        error: "App not installed or no admin session for this shop",
        hint: "Open the app in Shopify Admin once, then retry.",
      });
    }

    const url = new URL(request.url);
    const customerId = url.searchParams.get("logged_in_customer_id");

    if (!customerId) {
      return proxyJson({
        ok: false,
        error: "Customer must be logged in on the storefront",
      });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return proxyJson({ ok: false, error: "Invalid JSON body" });
    }

    const items = normalizeItems(body?.items);
    if (items === null) {
      return proxyJson({
        ok: false,
        error:
          'Expected body shape: { items: [{ id: number|string, quantity: number }] }',
      });
    }

    const ownerId = `gid://shopify/Customer/${customerId}`;
    const value = JSON.stringify(items);

    const response = await admin.graphql(
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

    const json = await response.json();
    const userErrors = json?.data?.metafieldsSet?.userErrors ?? [];

    if (userErrors.length > 0) {
      console.error("cart-sync metafieldsSet userErrors", userErrors);
      return proxyJson({
        ok: false,
        error: "Failed to save cart metafield",
        userErrors,
        hint:
          "Run shopify app dev to sync the app metafield definition, then reinstall the app so write_customers is on the access token.",
      });
    }

    if (json?.errors?.length) {
      console.error("cart-sync metafieldsSet GraphQL errors", json.errors);
      return proxyJson({
        ok: false,
        error: "Admin API error",
        details: json.errors,
      });
    }

    return proxyJson({
      ok: true,
      customerId,
      itemCount: items.length,
    });
  } catch (error) {
    console.error("cart-sync unexpected error", error);
    return proxyJson({
      ok: false,
      error: error instanceof Error ? error.message : "Unexpected server error",
    });
  }
};

export const loader = async ({ request }) => {
  try {
    await authenticate.public.appProxy(request);

    const url = new URL(request.url);
    const customerId = url.searchParams.get("logged_in_customer_id");

    return proxyJson({
      ok: true,
      loggedIn: Boolean(customerId),
      customerId: customerId || null,
    });
  } catch (error) {
    console.error("cart-sync loader error", error);
    return proxyJson({
      ok: false,
      error: error instanceof Error ? error.message : "Unexpected server error",
    });
  }
};

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
