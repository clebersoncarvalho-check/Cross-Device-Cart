# Cross Device Cart

App Shopify que sincroniza o carrinho do cliente logado entre dispositivos.

Quando o cliente adiciona produtos em um aparelho e entra na loja em outro (com a mesma conta), o carrinho é restaurado automaticamente.

O cliente precisa estar logado na vitrine. Visitante anônimo não sincroniza.

## 1. Instalar o app

1. Instale o app na loja pelo Admin da Shopify.
2. Abra o app **uma vez** no Admin (isso cria a sessão necessária para o sync funcionar).

## 2. Adicionar os scripts no tema

No Admin, abra o **Cross Device Cart**. A home do app mostra os dois códigos prontos para copiar.

### Código Liquid

1. Vá em **Loja online → Temas → Editar código**.
2. Abra o arquivo `layout/theme.liquid`.
3. Cole o código Liquid **dentro do `<head>`**, o mais cedo possível.
4. Salve.

Esse trecho avisa se o cliente está logado e inicia a busca do carrinho no app.

### Arquivo JavaScript

1. No editor do tema, em **assets**, crie um arquivo novo chamado `cart-sync.js`.
2. Cole o JavaScript copiado do app.
3. Salve.

O Liquid já carrega esse arquivo com:

```liquid
<script src="{{ 'cart-sync.js' | asset_url }}" defer></script>
```

Os mesmos códigos também estão em `theme-reference/` neste repositório.

## 3. Publicar e testar

1. Salve e publique o tema.
2. Na vitrine, entre com uma conta de cliente.
3. Adicione um produto ao carrinho.
4. Em outro dispositivo (ou janela anônima), faça login com a mesma conta.
5. O carrinho deve reaparecer.

## Como funciona

- **POST** `/apps/cart-sync` — salva o carrinho no metafield do cliente.
- **GET** `/apps/cart-sync` — lê o carrinho salvo e o tema restaura os itens.

O tema não lê o metafield direto. Só o app faz isso.
