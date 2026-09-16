export const CART_SYNC_CODES = {
  SUCCESS: "SUCCESS",
  NOT_LOGGED_IN: "NOT_LOGGED_IN",
  NO_ADMIN_SESSION: "NO_ADMIN_SESSION",
  PROXY_AUTH_FAILED: "PROXY_AUTH_FAILED",
  INVALID_JSON: "INVALID_JSON",
  INVALID_ITEMS: "INVALID_ITEMS",
  METAFIELD_ERROR: "METAFIELD_ERROR",
  ADMIN_API_ERROR: "ADMIN_API_ERROR",
  ADMIN_TOKEN_EXPIRED: "ADMIN_TOKEN_EXPIRED",
  METHOD_NOT_ALLOWED: "METHOD_NOT_ALLOWED",
  UNEXPECTED_ERROR: "UNEXPECTED_ERROR",
  HEALTH_OK: "HEALTH_OK",
  CART_LOADED: "CART_LOADED",
  EMPTY_SAVE_SKIPPED: "EMPTY_SAVE_SKIPPED",
};

const MESSAGES = {
  [CART_SYNC_CODES.SUCCESS]: "Carrinho salvo no metafield do cliente.",
  [CART_SYNC_CODES.NOT_LOGGED_IN]:
    "Cliente precisa estar logado na vitrine para sincronizar o carrinho.",
  [CART_SYNC_CODES.NO_ADMIN_SESSION]:
    "App sem sessão Admin. Abra este app no Admin da loja uma vez.",
  [CART_SYNC_CODES.PROXY_AUTH_FAILED]:
    "Falha na autenticação do App Proxy. Verifique credenciais e instalação.",
  [CART_SYNC_CODES.INVALID_JSON]: "Body inválido. Envie JSON.",
  [CART_SYNC_CODES.INVALID_ITEMS]:
    'Formato esperado: { "items": [{ "id": variantId, "quantity": number }] }',
  [CART_SYNC_CODES.METAFIELD_ERROR]:
    "Não foi possível gravar o metafield app.dados_do_carrinho.",
  [CART_SYNC_CODES.ADMIN_API_ERROR]:
    "Erro ao chamar a Admin API da Shopify.",
  [CART_SYNC_CODES.ADMIN_TOKEN_EXPIRED]:
    "Token do app expirou ou é inválido. Reinstale o app e abra-o no Admin.",
  [CART_SYNC_CODES.METHOD_NOT_ALLOWED]: "Use POST para salvar o carrinho.",
  [CART_SYNC_CODES.UNEXPECTED_ERROR]: "Erro inesperado no servidor.",
  [CART_SYNC_CODES.HEALTH_OK]: "App Proxy respondendo.",
  [CART_SYNC_CODES.CART_LOADED]: "Carrinho carregado do metafield do cliente.",
  [CART_SYNC_CODES.EMPTY_SAVE_SKIPPED]:
    "Save vazio ignorado. Envie clear: true para apagar o metafield.",
};

const HINTS = {
  [CART_SYNC_CODES.NOT_LOGGED_IN]:
    "Faça login como cliente em www.sualoja.com (não no Admin).",
  [CART_SYNC_CODES.NO_ADMIN_SESSION]:
    "Admin → Apps → Cross Device Cart → abrir a home do app.",
  [CART_SYNC_CODES.PROXY_AUTH_FAILED]:
    "Confira SHOPIFY_API_KEY/SECRET no servidor e reinstale o app.",
  [CART_SYNC_CODES.METAFIELD_ERROR]:
    "Rode npm run deploy e reinstale o app para criar app.dados_do_carrinho.",
  [CART_SYNC_CODES.ADMIN_TOKEN_EXPIRED]:
    "Desinstale, instale de novo e abra o app no Admin. Se persistir, limpe Session no banco.",
  [CART_SYNC_CODES.INVALID_ITEMS]:
    "Use variant_id de /cart.js como id de cada item.",
};

export function proxyJson(body, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

export function cartSyncResponse({
  ok,
  code,
  message,
  hint,
  step,
  ...rest
}) {
  return {
    ok,
    code,
    message: message ?? MESSAGES[code] ?? code,
    ...(hint || HINTS[code] ? { hint: hint ?? HINTS[code] } : {}),
    ...(step ? { step } : {}),
    ...rest,
  };
}

export function isUnauthorizedAdminError(error) {
  const message =
    error instanceof Error ? error.message : String(error ?? "");
  const responseCode = error?.response?.code;

  return (
    responseCode === 401 ||
    message.includes("401") ||
    message.includes("Unauthorized")
  );
}
