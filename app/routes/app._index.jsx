import { useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  await authenticate.admin(request);

  const themeDir = path.join(process.cwd(), "theme-reference");
  const [liquidSnippet, cartSyncJs] = await Promise.all([
    readFile(path.join(themeDir, "theme.liquid.snippet"), "utf8"),
    readFile(path.join(themeDir, "cart-sync.js"), "utf8"),
  ]);

  return { liquidSnippet, cartSyncJs };
};

export default function Index() {
  const { liquidSnippet, cartSyncJs } = useLoaderData();
  const shopify = useAppBridge();

  async function copyText(text, label) {
    try {
      await navigator.clipboard.writeText(text);
      shopify.toast.show(`${label} copiado`);
    } catch {
      shopify.toast.show(
        "Não foi possível copiar. Selecione o texto e copie manualmente.",
      );
    }
  }

  return (
    <s-page heading="Cross Device Cart">
      <s-section heading="O que o app faz">
        <s-paragraph>
          Salva o carrinho do cliente logado e restaura os mesmos itens quando
          ele abre a loja em outro dispositivo.
        </s-paragraph>
      </s-section>

      <s-section heading="Como instalar no tema">
        <s-ordered-list>
          <s-list-item>
            Cole o código Liquid no arquivo{" "}
            <s-text type="strong">layout/theme.liquid</s-text>, dentro do{" "}
            <s-text type="strong">&lt;head&gt;</s-text>.
          </s-list-item>
          <s-list-item>
            No tema, crie o arquivo{" "}
            <s-text type="strong">assets/cart-sync.js</s-text> e cole o
            JavaScript abaixo.
          </s-list-item>
          <s-list-item>
            Salve e publique o tema. O cliente precisa estar logado na vitrine
            para o carrinho sincronizar.
          </s-list-item>
        </s-ordered-list>
      </s-section>

      <s-section heading="1. Código para o theme.liquid">
        <s-paragraph>
          Cole este trecho no <s-text type="strong">&lt;head&gt;</s-text> do{" "}
          <s-text type="strong">layout/theme.liquid</s-text>.
        </s-paragraph>
        <s-stack direction="block" gap="base">
          <s-button
            variant="primary"
            onClick={() => copyText(liquidSnippet, "Código Liquid")}
          >
            Copiar Liquid
          </s-button>
          <s-text-area
            label="layout/theme.liquid"
            value={liquidSnippet}
            readOnly
            rows={16}
          />
        </s-stack>
      </s-section>

      <s-section heading="2. Código do cart-sync.js">
        <s-paragraph>
          Crie o arquivo <s-text type="strong">assets/cart-sync.js</s-text> no
          tema e cole este código.
        </s-paragraph>
        <s-stack direction="block" gap="base">
          <s-button
            variant="primary"
            onClick={() => copyText(cartSyncJs, "Código JS")}
          >
            Copiar JavaScript
          </s-button>
          <s-text-area
            label="assets/cart-sync.js"
            value={cartSyncJs}
            readOnly
            rows={20}
          />
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
