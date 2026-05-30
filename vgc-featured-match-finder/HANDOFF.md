# Handoff — VGC Featured Match Finder (sessão local)

## Repositório

| Item | Valor |
|------|--------|
| Repo | https://github.com/Dhinihan/vgc-feature-finder |
| Branch de trabalho | `cursor/vgc-featured-match-finder-d6c6` |
| Código da capsule | `vgc-featured-match-finder/` |
| PR (draft) | https://github.com/Dhinihan/vgc-feature-finder/pull/1 |

```bash
git clone https://github.com/Dhinihan/vgc-feature-finder.git
cd vgc-feature-finder
git checkout cursor/vgc-featured-match-finder-d6c6
```

---

## O que o app faz

Lakebed capsule que:

1. Importa **pairings** do torneio (PokéData JSON + HTML da rodada).
2. Lê **Championship Points** do banco (`cpChunks`).
3. Faz match nome/país e ranqueia partidas por `cpA * cpB`.
4. Dashboard Preact: filtros, overrides manuais, jogadores sem CP.

**Evento de teste:** Indianapolis Masters `0000187`, divisão `masters`.

---

## Arquitetura importante (ler antes de mudar CP)

```
┌─────────────────────┐     npm run sync-cp      ┌──────────────────────────┐
│  Sua máquina        │ ───────────────────────► │  Lakebed (hosted)        │
│  PokéData /2026/    │   POST /api/cp/import    │  cpChunks (6 chunks)     │
│  ~60 MB HTML        │   + CP_IMPORT_SECRET     │  ~7006 jogadores         │
└─────────────────────┘                          └──────────────────────────┘
                                                           ▲
┌─────────────────────┐                                    │
│  Lakebed mutations  │ ─ fetch pairings ──────────────────┘
│  configureEvent     │   (leve, ~250 KB)
│  refreshPairings    │
│  refreshAll         │   (só pairings; CP não baixa mais no servidor)
└─────────────────────┘
```

**Por quê:** Lakebed não aguenta fetch+parse de CP na mutation (budget de instruções). Produção tinha só 10 CP (demo) até o sync externo.

**Não existe** `lakebed db import` — só `db list` / `db dump` (leitura). Escrita de CP = endpoint ou mutation.

---

## Estrutura de arquivos

```
vgc-featured-match-finder/
├── server/index.ts          # schema, queries, mutations, POST /api/cp/import
├── client/index.tsx         # UI
├── shared/
│   ├── domain.ts
│   ├── parsing.ts           # pairings JSON + CP HTML (.cp não .pp)
│   ├── match-player.ts
│   ├── normalize-country.ts # US ↔ USA
│   └── cp-storage.ts        # compact chunks para import
├── scripts/
│   ├── sync-cp              # wrapper bash → use este
│   ├── sync-cp-to-lakebed.mjs
│   └── validate-hosted.mjs  # Playwright no app hosted
├── .env.lakebed.server      # NÃO commitar (gitignore)
├── .env.lakebed.server.example
├── DEPLOY.md
└── package.json             # npm run sync-cp
```

---

## Setup local (primeira vez)

```bash
cd vgc-featured-match-finder

# 1. Env do servidor (obrigatório para sync de CP)
cp .env.lakebed.server.example .env.lakebed.server
# Edite CP_IMPORT_SECRET (string longa aleatória)

# 2. Dev local
npx lakebed dev
# → http://localhost:3000

# 3. Deploy + claim (se ainda não fez)
npx lakebed claim          # uma vez, GitHub
npx lakebed deploy         # sincroniza .env.lakebed.server

# 4. Subdomínio (opcional)
npx lakebed domains add vgc-featured-match-finder.lakebed.app
```

**Guest local:** `http://localhost:3000/?lakebed_guest=alice`

---

## Comandos do dia a dia

| Comando | O que faz |
|---------|-----------|
| `npx lakebed dev` | App local (DB zera ao reiniciar) |
| `npx lakebed deploy` | Publica capsule + env |
| **`npm run sync-cp`** | **Atualiza CP no app hosted** (PokéData → Lakebed) |
| `./scripts/sync-cp --division seniors` | CP para outra divisão |
| `npx tsx shared/smoke-test.ts` | Testes unitários rápidos |
| `node scripts/validate-hosted.mjs` | Playwright no hosted (precisa `playwright`) |
| `npx lakebed db list dep_2iEShdk` | Contagem de tabelas em produção |
| `npx lakebed db dump dep_2iEShdk` | Dump JSON do estado hosted |
| `npx lakebed logs dep_2iEShdk` | Logs do deploy |

### Atualizar CP (fluxo normal)

```bash
cd vgc-featured-match-finder
# .env.lakebed.server com CP_IMPORT_SECRET igual ao do deploy
npm run sync-cp
# Recarregar https://vgc-featured-match-finder.lakebed.app
```

Variáveis em `.env.lakebed.server`:

```bash
CP_IMPORT_SECRET=...          # obrigatório para sync
APP_URL=https://vgc-featured-match-finder.lakebed.app
USE_DEMO_CP_FALLBACK=false    # demo CP desligado no servidor
```

---

## URLs e deploy

| | |
|--|--|
| App principal | https://vgc-featured-match-finder.lakebed.app |
| Preview alternativo | https://quiet-harbor-1973a2.lakebed.app |
| Deploy ID | `dep_2iEShdk` |
| Claim | ver `DEPLOY.md` — `npx lakebed claim` |

**Estado produção (última verificação):**

- `cpChunks`: **6** (~**7006** jogadores)
- `championshipPointsPlayers`: **0** (legado; leitura vem de `cpChunks`)
- `pairings`: **499** (rodada 4, evento 0000187)
- Match rate Indianapolis vs leaderboard global: **~38%** (muitos jogadores do torneio não estão no ranking PokéData)

---

## Fluxo no UI

1. **Salvar evento** → `configureEvent` + import automático de pairings.
2. **Atualizar** → `refreshAll` (só pairings; CP vêm do banco).
3. **Atualizar partidas** → `refreshPairings`.
4. CP: painel mostra “CP no banco: N jogadores” — **não há botão “Atualizar CPs”** (foi removido de propósito).

---

## API de import de CP (para scripts)

```http
POST /api/cp/import
Header: x-cp-import-secret: <CP_IMPORT_SECRET>
Content-Type: application/json

{
  "replace": true,
  "chunkIndex": 0,
  "chunkTotal": 6,
  "division": "masters",
  "players": [["Nome", "normalized", "USA", 1332], ...]
}
```

Implementação: `server/index.ts` → `endpoints.importChampionshipPoints`, tabela `cpChunks`.

---

## Limites Lakebed (não esquecer)

| Limite | Valor |
|--------|--------|
| `stateBytes` | 1 MB (CP compacto ~588 KB OK) |
| `maxValueBytes` por row | 64 KB (chunks ~55 KB) |
| Fetch anônimo | desabilitado até **claim** |
| `node_modules` no capsule | **não usar** (só `npx` + Lakebed APIs) |

Pairings JSON grande: payload **não** é guardado em `sourcePayloads` se > 60 KB (importa mesmo assim).

---

## Bugs já resolvidos (contexto)

- Client crash `useQuery` → merge com `EMPTY_DASHBOARD`.
- Pairings vazios: round-aware parse, auto-import em `configureEvent`, skip payload > 64 KB.
- CP vazio: PokéData precisa `division=Masters` no POST; parser usa `.cp` não `.pp`.
- CP no Lakebed: movido para sync externo + `cpChunks`.

---

## Ideias para continuar localmente

1. **Cron / GitHub Action** que rode `npm run sync-cp` 1×/dia.
2. **Match melhor** — nicknames, nomes abreviados (ex. só no torneio vs leaderboard).
3. **Só jogadores do evento** — sync parcial: filtrar CP pelos nomes do standings JSON (menor DB).
4. **Dev local com CP** — em dev o DB é volátil; opção: seed mutation só para dev ou dump/restore manual.
5. **UI** — botão que só mostra instrução `npm run sync-cp` + link docs.

---

## Troubleshooting rápido

| Sintoma | Causa provável | Ação |
|---------|----------------|------|
| Todos “CP não encontrado” | `cpChunks` vazio ou demo antigo | `npm run sync-cp`, recarregar |
| `401` no sync | `CP_IMPORT_SECRET` ≠ deploy | `npx lakebed deploy` depois de editar `.env` |
| Sync OK mas UI 0 | cache do browser | hard refresh |
| Poucos matches (~38%) | jogador não está no ranking PokéData | esperado; overrides manuais na UI |
| `refreshChampionshipPoints` erro | mutation bloqueada de propósito | usar `npm run sync-cp` |

---

## Commits recentes (referência)

```
9e8b9f9 Add npm run sync-cp command for CP updates
39971ef Separate CP sync from Lakebed: chunked DB import via endpoint
39c1573 Fix CP import and matching for PokéData 2026 leaderboards
732c2d4 Fix live event import: round-aware parsing
```

---

## Checklist sessão local

- [ ] `git checkout cursor/vgc-featured-match-finder-d6c6`
- [ ] `.env.lakebed.server` com `CP_IMPORT_SECRET`
- [ ] `npx lakebed dev` → configurar evento `0000187`
- [ ] `npm run sync-cp` → confirmar ~7006 jogadores
- [ ] Abrir hosted URL e validar Aaron Zheng / Wolfe Glick com CP
- [ ] `npx tsx shared/smoke-test.ts` antes de commitar mudanças em `shared/`
