# VGC Featured Match Finder

Lakebed capsule that ranks current-round VGC pairings by Championship Points product (`cpA * cpB`).

## Commands

```bash
cd vgc-featured-match-finder
npx lakebed dev
```

Local admin user (mutations): open `http://localhost:3000/?lakebed_guest=vinicius`

Inspect state:

```bash
npx lakebed db list --port 3000
npx lakebed db dump --port 3000
npx lakebed logs --port 3000
```

Smoke tests (pure shared logic):

```bash
npx tsx shared/smoke-test.ts
```

## Deploy with external fetch

```bash
npx lakebed deploy
npx lakebed claim
npx lakebed deploy
```

Set `ADMIN_USER_ID` in `.env.lakebed.server` for production. Remove or disable `USE_DEMO_CP_FALLBACK` when PokéData CP ingestion is available.

## Data sources

- Pairings: PokéData standings JSON (`standingsVGC/{eventId}/{division}/`)
- Championship Points: PokéData 2026 leaderboard POST (all regions), with optional demo fixture fallback for local development
