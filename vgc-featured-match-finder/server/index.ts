import {
  boolean,
  capsule,
  mutation,
  query,
  string,
  table
} from "lakebed/server";
import type {
  ChampionshipPointsPlayer,
  EventDashboard,
  Pairing,
  PlayerOverride,
  RankedPairing,
  RefreshResult,
  TournamentPlayer
} from "../shared/domain";
import { matchPlayerToChampionshipPoints } from "../shared/match-player";
import { normalizePlayerName } from "../shared/normalize-player-name";
import {
  DEMO_CHAMPIONSHIP_POINTS_JSON,
  divisionJsonFileName,
  extractExternalEventId,
  parseChampionshipPointsPayload,
  parseCurrentRoundFromHtml,
  parseEventTitleFromHtml,
  parsePairingsPayload,
  parsePlayerLabel
} from "../shared/parsing";
import { rankPairings } from "../shared/scoring";

const SOURCES = {
  pokeDataBaseUrl: "https://www.pokedata.ovh",
  championshipPointsUrl: "https://www.pokedata.ovh/2026/",
  championshipPointsRegions: ["NA", "EU", "LA", "AP", "SO", "RU"] as const
};

const CP_CACHE_MS = 12 * 60 * 60 * 1000;
const PAIRINGS_CACHE_MS = 3 * 60 * 1000;

const PAYLOAD_SOURCE = {
  championshipPoints: "championship-points",
  pairingsJson: "pairings-json"
} as const;
const REFRESH_RUN_LIMIT = 20;
const WILDCARD_COUNTRY = "*";

type ServerContext = {
  auth: { userId: string };
  db: Record<string, TableApi>;
  env: Record<string, string | undefined>;
  log: {
    info(message: string, data?: unknown): void;
    warn(message: string, data?: unknown): void;
    error(message: string, data?: unknown): void;
  };
};

type TableRow = Record<string, string | boolean> & {
  id: string;
  createdAt: string;
  updatedAt: string;
};

type TableApi = {
  where(field: string, value: unknown): TableApi;
  orderBy(field: string, direction?: "asc" | "desc"): TableApi;
  limit(count: number): TableApi;
  all(): TableRow[];
  get(id: string): TableRow | null;
  insert(value: Record<string, string | boolean>): TableRow;
  update(id: string, patch: Record<string, string | boolean>): void;
  delete(id: string): void;
};

function getActiveEvent(ctx: ServerContext): TableRow | null {
  const events = ctx.db.events.where("isActive", true).all();
  return events[0] ?? null;
}

function deleteAllRows(ctx: ServerContext, tableName: string, rows: TableRow[]): void {
  const table = ctx.db[tableName];
  for (const row of rows) {
    table.delete(row.id);
  }
}

function trimRefreshRuns(ctx: ServerContext, eventId: string): void {
  const runs = ctx.db.refreshRuns
    .where("eventId", eventId)
    .orderBy("createdAt", "desc")
    .all();

  for (const row of runs.slice(REFRESH_RUN_LIMIT)) {
    ctx.db.refreshRuns.delete(row.id);
  }
}

function replaceSourcePayload(
  ctx: ServerContext,
  source: string,
  eventId: string,
  body: string
): void {
  const existing = ctx.db.sourcePayloads
    .where("source", source)
    .all()
    .filter((row) => row.eventId === eventId);

  deleteAllRows(ctx, "sourcePayloads", existing);

  ctx.db.sourcePayloads.insert({
    source,
    eventId,
    fetchedAt: new Date().toISOString(),
    body: body.slice(0, 500_000)
  });
}

function loadOverrides(ctx: ServerContext): PlayerOverride[] {
  return ctx.db.playerOverrides.all().map((row) => ({
    tournamentNormalizedName: String(row.tournamentNormalizedName),
    tournamentCountry: String(row.tournamentCountry),
    leaderboardNormalizedName: String(row.leaderboardNormalizedName),
    leaderboardCountry: String(row.leaderboardCountry)
  }));
}

function loadChampionshipPoints(ctx: ServerContext): ChampionshipPointsPlayer[] {
  return ctx.db.championshipPointsPlayers.all().map((row) => ({
    displayName: String(row.displayName),
    normalizedName: String(row.normalizedName),
    country: String(row.country),
    championshipPoints: Number.parseInt(String(row.championshipPoints), 10) || 0
  }));
}

function buildTournamentPlayer(
  displayName: string,
  country: string,
  leaderboard: ChampionshipPointsPlayer[],
  overrides: PlayerOverride[]
): TournamentPlayer {
  const label = parsePlayerLabel(
    displayName.includes("[") ? displayName : `${displayName}${country ? ` [${country}]` : ""}`
  );
  const resolvedCountry = country || label.country;
  const matched = matchPlayerToChampionshipPoints(label.displayName, resolvedCountry, leaderboard, overrides);

  return {
    displayName: label.displayName,
    normalizedName: normalizePlayerName(label.displayName),
    country: resolvedCountry,
    championshipPoints: matched.championshipPoints,
    championshipPointsMatch: matched.match
  };
}

function buildPairings(ctx: ServerContext, event: TableRow): Pairing[] {
  const leaderboard = loadChampionshipPoints(ctx);
  const overrides = loadOverrides(ctx);
  const roundNumber = Number.parseInt(String(event.currentRound), 10) || 0;

  return ctx.db.pairings
    .where("eventId", event.id)
    .all()
    .filter((row) => Number.parseInt(String(row.roundNumber), 10) === roundNumber)
    .map((row) => {
      const playerA = buildTournamentPlayer(
        String(row.playerAName),
        String(row.playerACountry),
        leaderboard,
        overrides
      );
      const playerBName = String(row.playerBName);

      return {
        id: row.id,
        eventId: String(row.eventId),
        roundNumber,
        tableNumber: String(row.tableNumber) ? Number.parseInt(String(row.tableNumber), 10) : null,
        playerA,
        playerB: playerBName
          ? buildTournamentPlayer(playerBName, String(row.playerBCountry), leaderboard, overrides)
          : null,
        result: String(row.result) || null,
        isPending: Boolean(row.isPending),
        isBye: Boolean(row.isBye)
      } satisfies Pairing;
    });
}

function countUnmatchedPlayers(pairings: RankedPairing[]): {
  unmatched: number;
  ambiguous: number;
} {
  const unmatchedNames = new Set<string>();
  const ambiguousNames = new Set<string>();

  for (const pairing of pairings) {
    for (const player of [pairing.playerA, pairing.playerB]) {
      if (!player) {
        continue;
      }

      if (player.championshipPointsMatch.status === "not-found") {
        unmatchedNames.add(player.normalizedName);
      }

      if (player.championshipPointsMatch.status === "ambiguous") {
        ambiguousNames.add(player.normalizedName);
      }
    }
  }

  return { unmatched: unmatchedNames.size, ambiguous: ambiguousNames.size };
}

function buildEventDashboard(
  ctx: ServerContext,
  options: { pendingOnly: boolean }
): EventDashboard {
  const event = getActiveEvent(ctx);

  if (!event) {
    return {
      event: null,
      rankedPairings: [],
      stats: {
        totalPairings: 0,
        pendingPairings: 0,
        completedPairings: 0,
        unmatchedPlayers: 0,
        ambiguousPlayers: 0
      }
    };
  }

  const pairings = buildPairings(ctx, event);
  let ranked = rankPairings(pairings);

  if (options.pendingOnly) {
    ranked = ranked.filter((pairing) => pairing.isPending);
  }

  const allRanked = rankPairings(pairings);
  const { unmatched, ambiguous } = countUnmatchedPlayers(allRanked);

  return {
    event: {
      id: event.id,
      externalEventId: String(event.externalEventId),
      title: String(event.title),
      currentRound: Number.parseInt(String(event.currentRound), 10) || 0,
      lastRefreshAt: String(event.lastRefreshAt),
      sourceUrl: String(event.sourceUrl),
      division: String(event.division)
    },
    rankedPairings: ranked,
    stats: {
      totalPairings: pairings.length,
      pendingPairings: pairings.filter((pairing) => pairing.isPending).length,
      completedPairings: pairings.filter((pairing) => !pairing.isPending).length,
      unmatchedPlayers: unmatched,
      ambiguousPlayers: ambiguous
    }
  };
}

async function fetchText(url: string, init?: RequestInit): Promise<string> {
  const response = await fetch(url, init);

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return response.text();
}

function standingsJsonUrl(externalEventId: string, division: string): string {
  const divisionLabel = divisionJsonFileName(division);
  return `${SOURCES.pokeDataBaseUrl}/standingsVGC/${externalEventId}/${division.toLowerCase()}/${externalEventId}_${divisionLabel}.json`;
}

function standingsPageUrl(externalEventId: string, division: string): string {
  return `${SOURCES.pokeDataBaseUrl}/standingsVGC/${externalEventId}/${division.toLowerCase()}/`;
}

function getLatestSourcePayload(
  ctx: ServerContext,
  source: string,
  eventId: string
): TableRow | null {
  const rows = ctx.db.sourcePayloads
    .where("source", source)
    .all()
    .filter((row) => String(row.eventId) === eventId);

  if (rows.length === 0) {
    return null;
  }

  return rows.sort(
    (a, b) => Date.parse(String(b.fetchedAt)) - Date.parse(String(a.fetchedAt))
  )[0];
}

function isPayloadCacheFresh(row: TableRow | null, ttlMs: number): boolean {
  if (!row) {
    return false;
  }

  const fetchedAt = Date.parse(String(row.fetchedAt));
  if (Number.isNaN(fetchedAt)) {
    return false;
  }

  return Date.now() - fetchedAt < ttlMs;
}

function championshipPointsCacheFresh(ctx: ServerContext): boolean {
  const cached = getLatestSourcePayload(ctx, PAYLOAD_SOURCE.championshipPoints, "");
  const hasRows = ctx.db.championshipPointsPlayers.all().length > 0;
  return hasRows && isPayloadCacheFresh(cached, CP_CACHE_MS);
}

function pairingsCacheFresh(ctx: ServerContext, eventId: string): boolean {
  const cached = getLatestSourcePayload(ctx, PAYLOAD_SOURCE.pairingsJson, eventId);
  return isPayloadCacheFresh(cached, PAIRINGS_CACHE_MS);
}

async function fetchChampionshipPointsPayload(ctx: ServerContext): Promise<string> {
  const chunks: string[] = [];

  for (const region of SOURCES.championshipPointsRegions) {
    try {
      const body = await fetchText(SOURCES.championshipPointsUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `type=VG&region=${encodeURIComponent(region)}`
      });

      if (body.includes("<tr") || body.includes("player(")) {
        chunks.push(body);
      }
    } catch (error) {
      ctx.log.warn("championship points region fetch failed", {
        region,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return chunks.join("\n");
}

function normalizeCountryForStorage(country: string): string {
  return country || WILDCARD_COUNTRY;
}

function persistChampionshipPoints(
  ctx: ServerContext,
  players: ChampionshipPointsPlayer[],
  payload: string
): { playerCount: number; sourceUpdatedAt: string } {
  const existing = ctx.db.championshipPointsPlayers.all();
  deleteAllRows(ctx, "championshipPointsPlayers", existing);

  const updatedAt = new Date().toISOString();

  for (const player of players) {
    ctx.db.championshipPointsPlayers.insert({
      normalizedName: player.normalizedName,
      displayName: player.displayName,
      country: normalizeCountryForStorage(player.country),
      championshipPoints: String(player.championshipPoints),
      source: "pokemon-leaderboard",
      sourceUpdatedAt: updatedAt
    });
  }

  replaceSourcePayload(ctx, "championship-points", "", payload.slice(0, 500_000));

  return { playerCount: players.length, sourceUpdatedAt: updatedAt };
}

async function importChampionshipPoints(
  ctx: ServerContext,
  options?: { force?: boolean }
): Promise<{
  playerCount: number;
  sourceUpdatedAt: string;
  fromCache: boolean;
}> {
  if (!options?.force && championshipPointsCacheFresh(ctx)) {
    const cached = getLatestSourcePayload(ctx, PAYLOAD_SOURCE.championshipPoints, "");
    const rows = ctx.db.championshipPointsPlayers.all();
    const latest = rows
      .map((row) => String(row.sourceUpdatedAt))
      .sort()
      .at(-1) ?? new Date().toISOString();

    ctx.log.info("championship points served from cache", {
      fetchedAt: cached ? String(cached.fetchedAt) : latest,
      playerCount: rows.length
    });

    return {
      playerCount: rows.length,
      sourceUpdatedAt: latest,
      fromCache: true
    };
  }

  const payload = await fetchChampionshipPointsPayload(ctx);
  const players = parseChampionshipPointsPayload(payload);

  if (players.length === 0) {
    if (ctx.env.USE_DEMO_CP_FALLBACK === "true") {
      ctx.log.warn("using demo championship points fixture", {});
      const demoPlayers = parseChampionshipPointsPayload(DEMO_CHAMPIONSHIP_POINTS_JSON);
      const result = persistChampionshipPoints(ctx, demoPlayers, DEMO_CHAMPIONSHIP_POINTS_JSON);
      return { ...result, fromCache: false };
    }

    throw new Error("no championship points parsed from source");
  }

  const result = persistChampionshipPoints(ctx, players, payload);
  return { ...result, fromCache: false };
}

function insertPairingRow(
  ctx: ServerContext,
  eventId: string,
  currentRound: number,
  pairing: {
    tableNumber: number | null;
    playerA: { displayName: string; country: string };
    playerB: { displayName: string; country: string } | null;
    result: string | null;
    isPending: boolean;
    isBye: boolean;
  },
  importedAt: string
): void {
  const playerALabel = pairing.playerA;
  const playerBLabel = pairing.playerB;

  ctx.db.pairings.insert({
    eventId,
    roundNumber: String(currentRound),
    tableNumber: pairing.tableNumber === null ? "" : String(pairing.tableNumber),
    playerAName: playerALabel.displayName,
    playerANormalizedName: normalizePlayerName(playerALabel.displayName),
    playerACountry: playerALabel.country,
    playerBName: playerBLabel ? playerBLabel.displayName : "",
    playerBNormalizedName: playerBLabel ? normalizePlayerName(playerBLabel.displayName) : "",
    playerBCountry: playerBLabel ? playerBLabel.country : "",
    result: pairing.result ?? "",
    isPending: pairing.isPending,
    isBye: pairing.isBye,
    importedAt
  });
}

function applyPairingsPayload(
  ctx: ServerContext,
  event: TableRow,
  jsonBody: string,
  pageHtml: string | null
): {
  roundNumber: number;
  pairingCount: number;
  unmatchedPlayerCount: number;
  ambiguousPlayerCount: number;
  title: string;
} {
  const parsed = parsePairingsPayload(jsonBody);
  const htmlRound = pageHtml ? parseCurrentRoundFromHtml(pageHtml) : null;
  const currentRound = htmlRound ?? parsed.currentRound;
  const title = (pageHtml ? parseEventTitleFromHtml(pageHtml) : "") || String(event.title);

  const existingPairings = ctx.db.pairings.where("eventId", event.id).all();
  deleteAllRows(ctx, "pairings", existingPairings);

  const importedAt = new Date().toISOString();

  for (const pairing of parsed.pairings) {
    insertPairingRow(ctx, event.id, currentRound, pairing, importedAt);
  }

  const now = new Date().toISOString();
  ctx.db.events.update(event.id, {
    currentRound: String(currentRound),
    title,
    lastRefreshAt: now
  });

  const ranked = rankPairings(
    buildPairings(ctx, { ...event, currentRound: String(currentRound) })
  );
  const { unmatched, ambiguous } = countUnmatchedPlayers(ranked);

  return {
    roundNumber: currentRound,
    pairingCount: parsed.pairings.length,
    unmatchedPlayerCount: unmatched,
    ambiguousPlayerCount: ambiguous,
    title
  };
}

async function importPairingsForEvent(
  ctx: ServerContext,
  event: TableRow,
  options?: { force?: boolean }
): Promise<{
  roundNumber: number;
  pairingCount: number;
  unmatchedPlayerCount: number;
  ambiguousPlayerCount: number;
  title: string;
  fromCache: boolean;
}> {
  const externalEventId = String(event.externalEventId);
  const division = String(event.division) || "masters";

  if (!options?.force && pairingsCacheFresh(ctx, event.id)) {
    const cached = getLatestSourcePayload(ctx, PAYLOAD_SOURCE.pairingsJson, event.id);
    if (cached) {
      ctx.log.info("pairings served from cache", {
        externalEventId,
        fetchedAt: String(cached.fetchedAt)
      });

      const result = applyPairingsPayload(ctx, event, String(cached.body), null);
      return { ...result, fromCache: true };
    }
  }

  const jsonUrl = standingsJsonUrl(externalEventId, division);
  const pageUrl = standingsPageUrl(externalEventId, division);
  const [jsonBody, pageHtml] = await Promise.all([fetchText(jsonUrl), fetchText(pageUrl)]);

  replaceSourcePayload(ctx, PAYLOAD_SOURCE.pairingsJson, event.id, jsonBody);

  const result = applyPairingsPayload(ctx, event, jsonBody, pageHtml);
  return { ...result, fromCache: false };
}

export default capsule({
  name: "vgc-featured-match-finder",

  schema: {
    events: table({
      externalEventId: string(),
      sourceUrl: string(),
      division: string(),
      title: string(),
      currentRound: string(),
      lastRefreshAt: string(),
      isActive: boolean().default(true)
    }),
    championshipPointsPlayers: table({
      normalizedName: string(),
      displayName: string(),
      country: string(),
      championshipPoints: string(),
      source: string(),
      sourceUpdatedAt: string()
    }),
    pairings: table({
      eventId: string(),
      roundNumber: string(),
      tableNumber: string(),
      playerAName: string(),
      playerANormalizedName: string(),
      playerACountry: string(),
      playerBName: string(),
      playerBNormalizedName: string(),
      playerBCountry: string(),
      result: string(),
      isPending: boolean().default(true),
      isBye: boolean().default(false),
      importedAt: string()
    }),
    playerOverrides: table({
      tournamentNormalizedName: string(),
      tournamentCountry: string(),
      leaderboardNormalizedName: string(),
      leaderboardCountry: string()
    }),
    refreshRuns: table({
      eventId: string(),
      startedAt: string(),
      finishedAt: string(),
      status: string(),
      roundNumber: string(),
      pairingCount: string(),
      unmatchedPlayerCount: string(),
      ambiguousPlayerCount: string(),
      message: string()
    }),
    sourcePayloads: table({
      source: string(),
      eventId: string(),
      fetchedAt: string(),
      body: string()
    })
  },

  queries: {
    eventDashboard: query((ctx) => buildEventDashboard(ctx as ServerContext, { pendingOnly: true })),

    unmatchedPlayers: query((ctx) => {
      const serverCtx = ctx as ServerContext;
      const event = getActiveEvent(serverCtx);

      if (!event) {
        return [];
      }

      const players = new Map<
        string,
        {
          displayName: string;
          normalizedName: string;
          country: string;
          status: "not-found" | "ambiguous";
          candidates: string[];
        }
      >();

      for (const pairing of rankPairings(buildPairings(serverCtx, event))) {
        for (const player of [pairing.playerA, pairing.playerB]) {
          if (!player) {
            continue;
          }

          const status = player.championshipPointsMatch.status;
          if (status !== "not-found" && status !== "ambiguous") {
            continue;
          }

          players.set(`${player.normalizedName}|${player.country}`, {
            displayName: player.displayName,
            normalizedName: player.normalizedName,
            country: player.country,
            status,
            candidates: status === "ambiguous" ? player.championshipPointsMatch.candidates : []
          });
        }
      }

      return [...players.values()];
    }),

    refreshRuns: query((ctx) => {
      const event = getActiveEvent(ctx as ServerContext);
      if (!event) {
        return [];
      }

      return (ctx as ServerContext).db.refreshRuns
        .where("eventId", event.id)
        .orderBy("createdAt", "desc")
        .limit(20)
        .all();
    })
  },

  mutations: {
    configureEvent: mutation((ctx, externalEventId: string, sourceUrl: string, division: string) => {
      const parsedId = extractExternalEventId(externalEventId);
      const normalizedDivision = division.trim().toLowerCase() || "masters";

      if (!parsedId) {
        throw new Error("externalEventId is required");
      }

      const resolvedSourceUrl =
        sourceUrl.trim() || standingsPageUrl(parsedId, normalizedDivision);

      const serverCtx = ctx as ServerContext;
      const existingRows = serverCtx.db.events.where("isActive", true).all();

      for (const row of existingRows) {
        serverCtx.db.events.update(row.id, { isActive: false });
      }

      const duplicate = serverCtx.db.events
        .all()
        .find((row) => String(row.externalEventId) === parsedId);

      const now = new Date().toISOString();

      if (duplicate) {
        serverCtx.db.events.update(duplicate.id, {
          externalEventId: parsedId,
          sourceUrl: resolvedSourceUrl,
          division: normalizedDivision,
          isActive: true,
          lastRefreshAt: now
        });

        serverCtx.log.info("event configured", {
          externalEventId: parsedId,
          division: normalizedDivision,
          eventId: duplicate.id
        });

        return { eventId: duplicate.id };
      }

      const created = serverCtx.db.events.insert({
        externalEventId: parsedId,
        sourceUrl: resolvedSourceUrl,
        division: normalizedDivision,
        title: `Event ${parsedId}`,
        currentRound: "0",
        lastRefreshAt: now,
        isActive: true
      });

      serverCtx.log.info("event configured", {
        externalEventId: parsedId,
        division: normalizedDivision,
        eventId: created.id
      });

      return { eventId: created.id };
    }),

    refreshChampionshipPoints: mutation(async (ctx) => {
      const serverCtx = ctx as ServerContext;

      serverCtx.log.info("championship points refresh started", {});

      try {
        const result = await importChampionshipPoints(serverCtx);

        serverCtx.log.info("championship points refresh completed", {
          playerCount: result.playerCount
        });

        return result;
      } catch (error) {
        serverCtx.log.error("championship points refresh failed", {
          message: error instanceof Error ? error.message : String(error)
        });
        throw error;
      }
    }),

    refreshPairings: mutation(async (ctx) => {
      const serverCtx = ctx as ServerContext;
      const event = getActiveEvent(serverCtx);

      if (!event) {
        throw new Error("no active event");
      }

      const externalEventId = String(event.externalEventId);
      const division = String(event.division) || "masters";
      const startedAt = new Date().toISOString();

      const run = serverCtx.db.refreshRuns.insert({
        eventId: event.id,
        startedAt,
        finishedAt: "",
        status: "running",
        roundNumber: String(event.currentRound),
        pairingCount: "0",
        unmatchedPlayerCount: "0",
        ambiguousPlayerCount: "0",
        message: ""
      });

      serverCtx.log.info("pairings refresh started", { externalEventId, division });

      try {
        const result = await importPairingsForEvent(serverCtx, event);
        const now = new Date().toISOString();

        serverCtx.db.refreshRuns.update(run.id, {
          finishedAt: now,
          status: "success",
          roundNumber: String(result.roundNumber),
          pairingCount: String(result.pairingCount),
          unmatchedPlayerCount: String(result.unmatchedPlayerCount),
          ambiguousPlayerCount: String(result.ambiguousPlayerCount),
          message: "ok"
        });

        trimRefreshRuns(serverCtx, event.id);

        serverCtx.log.info("pairings refresh completed", {
          externalEventId,
          roundNumber: result.roundNumber,
          pairingCount: result.pairingCount,
          unmatchedPlayerCount: result.unmatchedPlayerCount,
          ambiguousPlayerCount: result.ambiguousPlayerCount
        });

        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        serverCtx.db.refreshRuns.update(run.id, {
          finishedAt: new Date().toISOString(),
          status: "error",
          message
        });
        trimRefreshRuns(serverCtx, event.id);

        serverCtx.log.error("pairings refresh failed", { externalEventId, message });
        throw error;
      }
    }),

    refreshAll: mutation(async (ctx) => {
      const serverCtx = ctx as ServerContext;
      const event = getActiveEvent(serverCtx);

      if (!event) {
        throw new Error("no active event");
      }

      let championshipPointsUpdated = false;
      let championshipPointsCount = serverCtx.db.championshipPointsPlayers.all().length;

      let championshipPointsFromCache = false;
      let pairingsFromCache = false;

      if (!championshipPointsCacheFresh(serverCtx)) {
        try {
          const cpResult = await importChampionshipPoints(serverCtx);
          championshipPointsUpdated = !cpResult.fromCache;
          championshipPointsCount = cpResult.playerCount;
          championshipPointsFromCache = cpResult.fromCache;
        } catch (error) {
          serverCtx.log.warn("refreshAll championship points skipped", {
            message: error instanceof Error ? error.message : String(error)
          });
        }
      } else {
        championshipPointsFromCache = true;
        championshipPointsCount = serverCtx.db.championshipPointsPlayers.all().length;
        serverCtx.log.info("refreshAll championship points from cache", {
          playerCount: championshipPointsCount
        });
      }

      const pairingsResult = await importPairingsForEvent(serverCtx, event);
      pairingsFromCache = pairingsResult.fromCache;
      const now = new Date().toISOString();

      serverCtx.db.refreshRuns.insert({
        eventId: event.id,
        startedAt: now,
        finishedAt: now,
        status: "success",
        roundNumber: String(pairingsResult.roundNumber),
        pairingCount: String(pairingsResult.pairingCount),
        unmatchedPlayerCount: String(pairingsResult.unmatchedPlayerCount),
        ambiguousPlayerCount: String(pairingsResult.ambiguousPlayerCount),
        message: "refreshAll"
      });

      trimRefreshRuns(serverCtx, event.id);

      const result: RefreshResult = {
        championshipPointsUpdated,
        championshipPointsCount,
        pairingsCount: pairingsResult.pairingCount,
        roundNumber: pairingsResult.roundNumber,
        unmatchedPlayerCount: pairingsResult.unmatchedPlayerCount,
        ambiguousPlayerCount: pairingsResult.ambiguousPlayerCount,
        championshipPointsFromCache,
        pairingsFromCache
      };

      serverCtx.log.info("refreshAll completed", result);
      return result;
    }),

    savePlayerOverride: mutation(
      (
        ctx,
        tournamentNormalizedName: string,
        tournamentCountry: string,
        leaderboardNormalizedName: string,
        leaderboardCountry: string
      ) => {
          const serverCtx = ctx as ServerContext;

        const tournamentName = tournamentNormalizedName.trim();
        const leaderboardName = leaderboardNormalizedName.trim();

        if (!tournamentName || !leaderboardName) {
          throw new Error("normalized names are required");
        }

        const tournamentCountryValue = tournamentCountry.trim() || WILDCARD_COUNTRY;
        const leaderboardCountryValue = leaderboardCountry.trim() || WILDCARD_COUNTRY;

        const existing = serverCtx.db.playerOverrides.all().find(
          (row) =>
            String(row.tournamentNormalizedName) === tournamentName &&
            String(row.tournamentCountry) === tournamentCountryValue
        );

        if (existing) {
          serverCtx.db.playerOverrides.update(existing.id, {
            leaderboardNormalizedName: leaderboardName,
            leaderboardCountry: leaderboardCountryValue
          });
        } else {
          serverCtx.db.playerOverrides.insert({
            tournamentNormalizedName: tournamentName,
            tournamentCountry: tournamentCountryValue,
            leaderboardNormalizedName: leaderboardName,
            leaderboardCountry: leaderboardCountryValue
          });
        }

        serverCtx.log.info("player override saved", {
          tournamentNormalizedName: tournamentName,
          tournamentCountry: tournamentCountryValue,
          leaderboardNormalizedName: leaderboardName,
          leaderboardCountry: leaderboardCountryValue
        });
      }
    )
  }
});
