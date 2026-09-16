# Tema — Cross Device Cart

Copie para o tema Shopify da loja.

| Repo | Tema |
|------|------|
| `theme-reference/theme.liquid.snippet` | trecho no `<head>` do `layout/theme.liquid` |
| `theme-reference/cart-sync.js` | `assets/cart-sync.js` |

O Liquid do tema **não lê** o metafield. Só informa se o cliente está logado e dispara o `GET /apps/cart-sync` no `<head>`. O JS consome esse prefetch e restaura sem esperar `DOMContentLoaded`.

## Deploy

1. PC: `npm run deploy` (definição `$app.dados_do_carrinho`)
2. Ubuntu: `git pull` → `docker compose build` → `docker compose up -d`
3. Copiar snippet + `cart-sync.js` para o tema e publicar

## API

| Método | URL | Função |
|--------|-----|--------|
| GET | `/apps/cart-sync` | Lê carrinho do metafield (`cart`, `items`) |
| POST | `/apps/cart-sync` | Salva `{ items, clear }`. Vazio sem `clear: true` não apaga o metafield |

## Teste

1. Cliente logado, add to cart **ou Comprar agora** → Network `POST /apps/cart-sync` com `SUCCESS` (o Comprar agora grava no `/cart/add.js`, antes do redirect)
2. Outro device / anônimo, mesmo login → `GET /apps/cart-sync` com `CART_LOADED` e depois `/cart/add.js`
3. Logout/login na mesma aba também restaura (a sessão de restore é limpa no logout)
