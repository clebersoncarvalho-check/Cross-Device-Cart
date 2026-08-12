# Tema — Cross Device Cart

Copie para o tema Shopify da loja.

| Repo | Tema |
|------|------|
| `theme-reference/theme.liquid.snippet` | trecho no `layout/theme.liquid` |
| `theme-reference/cart-sync.js` | `assets/cart-sync.js` |

## Deploy

1. PC: `npm run deploy` (Storefront API no metafield)
2. Ubuntu: `git pull` → `docker compose build` → `docker compose up -d`
3. Publicar tema

## API

| Método | URL | Função |
|--------|-----|--------|
| GET | `/apps/cart-sync` | Lê carrinho do metafield (`cart`, `items`) |
| POST | `/apps/cart-sync` | Salva carrinho no metafield |

## Teste

Network filtro `cart-sync` — POST ao add/remove, GET no load da página (restore).
