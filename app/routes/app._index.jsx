import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { getCartSyncAdminStatus } from "../lib/cart-sync.server";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const status = await getCartSyncAdminStatus(admin, session);

  return {
    status,
    proxyUrl: "/apps/cart-sync",
    metafieldKey: "app.dados_do_carrinho",
  };
};

export default function Index() {
  const { status, proxyUrl, metafieldKey } = useLoaderData();
  const fetcher = useFetcher();
  const isRefreshing = fetcher.state !== "idle";

  const allOk = status.adminApi.ok && status.metafieldDefinition.ok;

  return (
    <s-page heading="Cross Device Cart">
      <s-button
        slot="primary-action"
        onClick={() => fetcher.load("/app")}
        {...(isRefreshing ? { loading: true } : {})}
      >
        Atualizar status
      </s-button>

      <s-section heading="Status da integração">
        <s-paragraph>
          Use esta página para confirmar se o app está pronto para sincronizar
          carrinhos entre dispositivos.
        </s-paragraph>

        <s-stack direction="block" gap="base">
          <StatusRow
            label="Loja conectada"
            ok={Boolean(status.shop)}
            message={status.shop ?? "Sem loja na sessão"}
          />
          <StatusRow
            label="Admin API"
            ok={status.adminApi.ok}
            message={status.adminApi.message}
          />
          <StatusRow
            label="Metafield do carrinho"
            ok={status.metafieldDefinition.ok}
            message={status.metafieldDefinition.message}
          />
          <StatusRow
            label="Resumo"
            ok={allOk}
            message={
              allOk
                ? "App pronto. Teste na vitrine com cliente logado."
                : "Corrija os itens em vermelho antes de testar na loja."
            }
          />
        </s-stack>
      </s-section>

      <s-section heading="Como testar na loja">
        <s-unordered-list>
          <s-list-item>
            Cliente logado na vitrine adiciona produto ao carrinho.
          </s-list-item>
          <s-list-item>
            DevTools → Network → filtro:{" "}
            <s-text type="strong">{proxyUrl.replace("/", "")}</s-text>
          </s-list-item>
          <s-list-item>
            A request POST deve retornar JSON com{" "}
            <s-text type="strong">ok: true</s-text> e code{" "}
            <s-text type="strong">SUCCESS</s-text>.
          </s-list-item>
          <s-list-item>
            No Console do browser:{" "}
            <s-text type="strong">[cart-sync] ✅ Carrinho salvo</s-text>
          </s-list-item>
        </s-unordered-list>
      </s-section>

      <s-section heading="Endpoints">
        <s-box
          padding="base"
          borderWidth="base"
          borderRadius="base"
          background="subdued"
        >
          <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>
            <code>{`Vitrine (tema):  POST ${proxyUrl}
Health check:     GET  ${proxyUrl}
Metafield:        customer.metafields.${metafieldKey}`}</code>
          </pre>
        </s-box>
      </s-section>

      <s-section heading="Códigos de resposta (JSON)">
        <s-box
          padding="base"
          borderWidth="base"
          borderRadius="base"
          background="subdued"
        >
          <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>
            <code>{`SUCCESS              → Carrinho salvo
NOT_LOGGED_IN        → Cliente não logado na vitrine
NO_ADMIN_SESSION     → Abrir app no Admin
ADMIN_TOKEN_EXPIRED  → Reinstalar app / limpar Session
PROXY_AUTH_FAILED    → Credenciais ou proxy incorretos
METAFIELD_ERROR      → Definição app.dados_do_carrinho ausente
INVALID_ITEMS        → Body JSON inválido`}</code>
          </pre>
        </s-box>
      </s-section>

      {!allOk && status.adminApi.details && (
        <s-section heading="Detalhe do erro (Admin API)">
          <s-box
            padding="base"
            borderWidth="base"
            borderRadius="base"
            background="subdued"
          >
            <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>
              <code>{JSON.stringify(status.adminApi.details, null, 2)}</code>
            </pre>
          </s-box>
        </s-section>
      )}

      <s-section slot="aside" heading="Scopes da sessão">
        <s-paragraph>
          <s-text>{status.scopes ?? "Não disponível"}</s-text>
        </s-paragraph>
      </s-section>

      <s-section slot="aside" heading="Se o sync falhar">
        <s-unordered-list>
          <s-list-item>Abra esta página no Admin (cria sessão).</s-list-item>
          <s-list-item>
            Rode <s-text type="strong">npm run deploy</s-text> e reinstale o
            app.
          </s-list-item>
          <s-list-item>
            Confira <s-text type="strong">theme-reference/</s-text> no repo
            para o JS/Liquid do tema.
          </s-list-item>
        </s-unordered-list>
      </s-section>
    </s-page>
  );
}

function StatusRow({ label, ok, message }) {
  return (
    <s-box padding="base" borderWidth="base" borderRadius="base">
      <s-stack direction="inline" gap="base">
        <s-text type="strong">{ok ? "✅" : "❌"}</s-text>
        <s-stack direction="block" gap="small">
          <s-text type="strong">{label}</s-text>
          <s-text>{message}</s-text>
        </s-stack>
      </s-stack>
    </s-box>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
