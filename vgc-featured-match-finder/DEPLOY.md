# Deploy e claim

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

