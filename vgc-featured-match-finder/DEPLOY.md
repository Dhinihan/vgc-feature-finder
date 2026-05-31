# Deploy e claim

## Deploy automático (merge em `main`)

Cada push/merge em `main` que altere `vgc-featured-match-finder/` dispara o workflow `.github/workflows/deploy.yml`, que roda `npx lakebed deploy` no Lakebed.

Configure estes **repository secrets** no GitHub (`Settings → Secrets and variables → Actions`):

| Secret | Valor |
|--------|--------|
| `LAKEBED_DEPLOY_ID` | ID do deploy (ex.: `dep_2iEShdk`) — em `.lakebed/deploy.json` local |
| `LAKEBED_CLAIM_TOKEN` | Token de claim (ex.: `tok_...`) — em `.lakebed/deploy.json` local |
| `LAKEBED_SERVER_ENV` | Conteúdo completo de `.env.lakebed.server` (multiline) |

Exemplo local para criar/atualizar os secrets (requer `gh` autenticado):

```bash
cd vgc-featured-match-finder
gh secret set LAKEBED_DEPLOY_ID --body "$(jq -r .deployId .lakebed/deploy.json)"
gh secret set LAKEBED_CLAIM_TOKEN --body "$(jq -r .claimToken .lakebed/deploy.json)"
gh secret set LAKEBED_SERVER_ENV < .env.lakebed.server
```

## 1. Claim (uma vez, no browser)

Abra e entre com GitHub:

**https://dashboard.lakebed.dev/claim/dep_2iEShdk/tok_uJ5QyDBMBZ8q15IEZZpZIFXqekZCRJAk**

Ou, na pasta da capsule:

```bash
npx lakebed claim
```

## 2. Publicar app com fetch

```bash
cd vgc-featured-match-finder
npx lakebed deploy
```

## 3. Subdomínio identificável

```bash
npx lakebed domains add vgc-featured-match-finder.lakebed.app
```

URL final esperada: **https://vgc-featured-match-finder.lakebed.app**

## 4. Evento de teste

Indianapolis VGC Masters: **`0000187`**

## Championship Points (sync externo)

O Lakebed não consegue baixar/parsear ~60 MB de HTML de CP dentro de uma mutation (limite de runtime).
Os CP são gravados no banco via script local:

```bash
cd vgc-featured-match-finder
# Defina CP_IMPORT_SECRET em .env.lakebed.server e rode deploy
npx lakebed deploy
node scripts/sync-cp-to-lakebed.mjs --division masters
```

O app hosted só lê `cpChunks` do banco e importa pairings do torneio.

