# VGC Featured Match Finder

Lakebed capsule that ranks current-round VGC pairings by Championship Points product (`cpA * cpB`).

## Commands

```bash
cd vgc-featured-match-finder
cp .env.lakebed.server.example .env.lakebed.server  # opcional (demo CP)
npx lakebed dev
```

Inspect state:

```bash
npx lakebed db list --port 3000
npx lakebed db dump --port 3000
npx lakebed logs --port 3000
```

Smoke tests:

```bash
npx tsx shared/smoke-test.ts
```

## Cache

Server-side cache via `sourcePayloads` + TTL (no auth required):

| Fonte | TTL |
|-------|-----|
| Championship Points | 12 horas |
| Partidas (JSON PokéData) | 3 minutos |

Mutations repetidas dentro do TTL reutilizam o payload salvo e evitam `fetch()` externo. O Lakebed aplica rate limits no deploy.

## Deploy com fetch externo

```bash
npx lakebed deploy
npx lakebed claim
npx lakebed deploy
```

## Fontes

- Partidas: `standingsVGC/{eventId}/{division}/*.json`
- CPs: PokéData `/2026/` (VG, divisão do evento, todas as regiões NA/EU/LA/AP/SO/RU)

Exemplo evento recente: **Indianapolis** → `0000187`

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

