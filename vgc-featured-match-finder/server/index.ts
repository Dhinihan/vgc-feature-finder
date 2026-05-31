import {
  boolean,
  capsule,
  endpoint,
  json,
  mutation,
  query,
  string,
  table,
  text
} from "lakebed/server";
import type {
  ChampionshipPointsMeta,
  ChampionshipPointsPlayer,
  EventDashboard,
  Pairing,
  ParsedTournamentRound,
  PlayerOverride,
  RankedPairing,
  TournamentPlayer
} from "../shared/domain";
import { needsPairingsRefresh, resolveDisplayRound } from "../shared/round-resolution";
import { expandCpPlayers, type CompactCpRow } from "../shared/cp-storage";
import { compactPairing, expandCompactPairing, type CompactPairingRow } from "../shared/pairings-storage";
import { createLeaderboardIndex, matchPlayerWithLeaderboardIndex } from "../shared/leaderboard-index";
import type { LeaderboardIndex } from "../shared/leaderboard-index";
import { readStoredBoolean } from "../shared/stored-boolean";
import { normalizePlayerName } from "../shared/normalize-player-name";
import {
  divisionJsonFileName,
  extractExternalEventId,
  parseChampionshipPointsPayload,
  parseCurrentRoundFromHtml,
  resolveCurrentRound,
  parseEventTitleFromHtml,
  buildTournamentRecordIndexRaw,
  countPairingsInRound,
  detectCurrentRoundFromPayload,
  extractPairingsForRoundRaw,
  mergeExtractedPairings,
  mergeTournamentRecordIndexes,
  parsePairingsForRound,
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
const PAIRINGS_STAGING_META = "meta";
const PAIRINGS_JSON_META = "json-meta";
const PAIRINGS_JSON_SLICE_PREFIX = "json-";
const PAIRINGS_PREP_STATE = "prep-state";
const PAIRINGS_ROW_SLICE_PARSE_BATCH = 4;
const PAIRINGS_ROW_SLICE_OVERLAP_BYTES = 12_000;
const PAIRINGS_ROWS_PER_COMMIT = 6;
const WILDCARD_COUNTRY = "*";
const MAX_PERSISTED_PAYLOAD_BYTES = 60_000;

function championshipPointsDivisionLabel(division: string): string {
  const normalized = division.trim().toLowerCase();
  if (normalized === "juniors") {
    return "Juniors";
  }
  if (normalized === "seniors") {
    return "Seniors";
  }
  return "Masters";
}

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

function getLatestRunningRefreshRun(
  ctx: ServerContext,
  eventId: string
): TableRow | null {
  const runs = ctx.db.refreshRuns
    .where("eventId", eventId)
    .orderBy("createdAt", "desc")
    .all()
    .filter((row) => String(row.status) === "running");

  return runs[0] ?? null;
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

  if (body.length > MAX_PERSISTED_PAYLOAD_BYTES) {
    ctx.log.warn("source payload not stored (too large for lakebed row limit)", {
      source,
      eventId,
      byteLength: body.length,
      maxBytes: MAX_PERSISTED_PAYLOAD_BYTES
    });
    return;
  }

  ctx.db.sourcePayloads.insert({
    source,
    eventId,
    fetchedAt: new Date().toISOString(),
    body
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
  const chunkRows = ctx.db.cpChunks.all().sort(
    (a, b) => Number.parseInt(String(a.chunkIndex), 10) - Number.parseInt(String(b.chunkIndex), 10)
  );

  if (chunkRows.length > 0) {
    const compact: CompactCpRow[] = [];
    for (const row of chunkRows) {
      const parsed = JSON.parse(String(row.body)) as CompactCpRow[];
      if (Array.isArray(parsed)) {
        compact.push(...parsed);
      }
    }
    return expandCpPlayers(compact);
  }

  return ctx.db.championshipPointsPlayers.all().map((row) => ({
    displayName: String(row.displayName),
    normalizedName: String(row.normalizedName),
    country: String(row.country),
    championshipPoints: Number.parseInt(String(row.championshipPoints), 10) || 0
  }));
}

function clearCpStorage(ctx: ServerContext): void {
  deleteAllRows(ctx, "cpChunks", ctx.db.cpChunks.all());
  deleteAllRows(ctx, "championshipPointsPlayers", ctx.db.championshipPointsPlayers.all());
}

function sumCpChunkPlayerCounts(ctx: ServerContext): number {
  let total = 0;
  for (const row of ctx.db.cpChunks.all()) {
    try {
      const parsed = JSON.parse(String(row.body)) as unknown[];
      if (Array.isArray(parsed)) {
        total += parsed.length;
      }
    } catch {
      // ignore malformed chunk
    }
  }
  return total;
}

function readChampionshipPointsMeta(ctx: ServerContext): ChampionshipPointsMeta {
  const metaRow = getLatestSourcePayload(ctx, PAYLOAD_SOURCE.championshipPoints, "");
  let meta: Record<string, unknown> = {};
  if (metaRow) {
    try {
      meta = JSON.parse(String(metaRow.body)) as Record<string, unknown>;
    } catch {
      meta = {};
    }
  }

  const chunkCount = ctx.db.cpChunks.all().length;
  const legacyCount = ctx.db.championshipPointsPlayers.all().length;
  const playerCount =
    typeof meta.playerCount === "number"
      ? meta.playerCount
      : legacyCount > 0
        ? legacyCount
        : chunkCount > 0
          ? sumCpChunkPlayerCounts(ctx)
          : 0;

  return {
    playerCount,
    chunkCount,
    importedAt: typeof meta.importedAt === "string" ? meta.importedAt : null,
    division: typeof meta.division === "string" ? meta.division : "masters",
    source: typeof meta.source === "string" ? meta.source : "external-sync"
  };
}

function importCpChunk(
  ctx: ServerContext,
  input: {
    replace: boolean;
    chunkIndex: number;
    chunkTotal: number;
    division: string;
    players: CompactCpRow[];
  }
): { chunkIndex: number; chunkTotal: number; rowsInChunk: number } {
  if (input.chunkIndex === 0 && input.replace) {
    clearCpStorage(ctx);
  }

  const existing = ctx.db.cpChunks
    .all()
    .filter((row) => String(row.chunkIndex) === String(input.chunkIndex));

  deleteAllRows(ctx, "cpChunks", existing);

  ctx.db.cpChunks.insert({
    chunkIndex: String(input.chunkIndex),
    body: JSON.stringify(input.players)
  });

  const importedAt = new Date().toISOString();
  let playerCount: number | undefined;
  if (input.chunkIndex === input.chunkTotal - 1) {
    playerCount = 0;
    for (const row of ctx.db.cpChunks.all()) {
      const parsed = JSON.parse(String(row.body)) as CompactCpRow[];
      if (Array.isArray(parsed)) {
        playerCount += parsed.length;
      }
    }
  }

  replaceSourcePayload(
    ctx,
    PAYLOAD_SOURCE.championshipPoints,
    "",
    JSON.stringify({
      division: input.division,
      playerCount,
      chunkTotal: input.chunkTotal,
      chunksReceived: input.chunkIndex + 1,
      importedAt,
      source: "external-sync"
    })
  );

  ctx.log.info("cp chunk imported", {
    chunkIndex: input.chunkIndex,
    chunkTotal: input.chunkTotal,
    rowsInChunk: input.players.length
  });

  return {
    chunkIndex: input.chunkIndex,
    chunkTotal: input.chunkTotal,
    rowsInChunk: input.players.length
  };
}

function buildTournamentPlayer(
  displayName: string,
  country: string,
  tournamentRecord: string | null,
  leaderboardIndex: LeaderboardIndex,
  overrides: PlayerOverride[]
): TournamentPlayer {
  const label = parsePlayerLabel(
    displayName.includes("[") ? displayName : `${displayName}${country ? ` [${country}]` : ""}`
  );
  const resolvedCountry = country || label.country;
  const matched = matchPlayerWithLeaderboardIndex(
    label.displayName,
    resolvedCountry,
    leaderboardIndex,
    overrides
  );

  return {
    displayName: label.displayName,
    normalizedName: normalizePlayerName(label.displayName),
    country: resolvedCountry,
    tournamentRecord,
    championshipPoints: matched.championshipPoints,
    championshipPointsMatch: matched.match
  };
}

function parseEventRound(value: string | undefined): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function readImportedRound(event: TableRow): number {
  const imported = parseEventRound(String(event.importedRound ?? ""));
  if (imported > 0) {
    return imported;
  }

  return parseEventRound(String(event.currentRound));
}

function listPairingRoundsInDb(ctx: ServerContext, eventId: string): number[] {
  const rounds = new Set<number>();

  for (const row of ctx.db.pairings.where("eventId", eventId).all()) {
    const round = parseEventRound(String(row.roundNumber));
    if (round > 0) {
      rounds.add(round);
    }
  }

  return [...rounds];
}

function parsePairingsForTargetRound(
  ctx: ServerContext,
  jsonBody: string,
  targetRound: number
): { roundNumber: number; pairings: ParsedTournamentRound["pairings"] } {
  const direct = parsePairingsForRound(jsonBody, targetRound);
  if (direct.length > 0) {
    return { roundNumber: targetRound, pairings: direct };
  }

  for (let round = targetRound - 1; round >= 1; round--) {
    const fallback = parsePairingsForRound(jsonBody, round);
    if (fallback.length > 0) {
      ctx.log.warn("pairings fallback to earlier round", {
        targetRound,
        fallbackRound: round,
        pairingCount: fallback.length
      });
      return { roundNumber: round, pairings: fallback };
    }
  }

  return { roundNumber: targetRound, pairings: [] };
}

function buildPairings(ctx: ServerContext, event: TableRow, displayRound: number): Pairing[] {
  const leaderboardIndex = createLeaderboardIndex(loadChampionshipPoints(ctx));
  const overrides = loadOverrides(ctx);
  const roundNumber = displayRound > 0 ? displayRound : parseEventRound(String(event.currentRound));

  return ctx.db.pairings
    .where("eventId", event.id)
    .all()
    .filter((row) => parseEventRound(String(row.roundNumber)) === roundNumber)
    .map((row) => {
      const playerARecord = String(row.playerARecord ?? "").trim() || null;
      const playerA = buildTournamentPlayer(
        String(row.playerAName),
        String(row.playerACountry),
        playerARecord,
        leaderboardIndex,
        overrides
      );
      const playerBName = String(row.playerBName);
      const rawResult = String(row.result ?? "").trim().toUpperCase();
      const hasResult = rawResult !== "" && rawResult !== "-" && rawResult !== "?";
      const result = hasResult ? rawResult : null;

      return {
        id: row.id,
        eventId: String(row.eventId),
        roundNumber,
        tableNumber: String(row.tableNumber) ? Number.parseInt(String(row.tableNumber), 10) : null,
        playerA,
        playerB: playerBName
          ? buildTournamentPlayer(
              playerBName,
              String(row.playerBCountry),
              String(row.playerBRecord ?? "").trim() || null,
              leaderboardIndex,
              overrides
            )
          : null,
        result,
        isPending: hasResult ? false : readStoredBoolean(row.isPending, true),
        isBye: readStoredBoolean(row.isBye, false)
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

async function syncCurrentRoundFromPokeData(
  ctx: ServerContext,
  event: TableRow
): Promise<number | null> {
  const externalEventId = String(event.externalEventId);
  const division = String(event.division) || "masters";

  try {
    const html = await fetchText(standingsPageUrl(externalEventId, division));
    const htmlRound = parseCurrentRoundFromHtml(html);

    if (htmlRound === null) {
      ctx.log.warn("could not parse current round from PokéData HTML", { externalEventId });
      return null;
    }

    const storedRound = Number.parseInt(String(event.currentRound), 10) || 0;
    const titleFromHtml = parseEventTitleFromHtml(html);

    if (htmlRound !== storedRound || titleFromHtml) {
      ctx.db.events.update(event.id, {
        currentRound: String(htmlRound),
        lastRefreshAt: new Date().toISOString(),
        ...(titleFromHtml ? { title: titleFromHtml } : {})
      });
      ctx.log.info("current round synced from PokéData HTML", {
        externalEventId,
        previousRound: storedRound,
        htmlRound
      });
    }

    return htmlRound;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.log.warn("failed to fetch PokéData HTML for round sync", { externalEventId, message });
    return null;
  }
}

function buildEventDashboard(
  ctx: ServerContext,
  options: { pendingOnly: boolean }
): EventDashboard {
  const event = getActiveEvent(ctx);

  if (!event) {
    return {
      event: null,
      needsPairingsRefresh: false,
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

  const liveRound = parseEventRound(String(event.currentRound));
  const importedRound = readImportedRound(event);
  const roundsInDb = listPairingRoundsInDb(ctx, event.id);
  const displayRound = resolveDisplayRound(liveRound, importedRound, roundsInDb);
  const pairings = buildPairings(ctx, event, displayRound);
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
      currentRound: liveRound,
      displayRound,
      importedRound,
      lastRefreshAt: String(event.lastRefreshAt),
      sourceUrl: String(event.sourceUrl),
      division: String(event.division)
    },
    needsPairingsRefresh: needsPairingsRefresh(liveRound, displayRound, pairings.length),
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

/** Lakebed caps each outbound fetch body at 1 MiB; row storage is ~64 KiB per chunk. */
const LAKEBED_MAX_FETCH_BYTES = 50_000;
const LAKEBED_MAX_ROW_BYTES = 50_000;

async function fetchText(url: string, init?: RequestInit): Promise<string> {
  const response = await fetch(url, init);

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return response.text();
}

function parseContentRangeTotal(contentRange: string | null): number | null {
  if (!contentRange) {
    return null;
  }

  const match = contentRange.match(/\/(\d+)$/);
  if (!match) {
    return null;
  }

  const total = Number.parseInt(match[1], 10);
  return Number.isNaN(total) ? null : total;
}

type PairingsJsonMeta = {
  totalBytes: number;
  fetchSliceCount: number;
  rowSliceCount: number;
  fetchedThrough: number;
  jsonUrl: string;
};

function pairingsJsonRowSliceKey(rowSliceIndex: number): string {
  return `${PAIRINGS_JSON_SLICE_PREFIX}row-${rowSliceIndex}`;
}

function isPairingsJsonChunkIndex(chunkIndex: string): boolean {
  return (
    chunkIndex === PAIRINGS_JSON_META ||
    chunkIndex.startsWith(PAIRINGS_JSON_SLICE_PREFIX)
  );
}

function countPairingsJsonRowSlices(ctx: ServerContext, eventId: string): number {
  return ctx.db.pairingsChunks
    .where("eventId", eventId)
    .all()
    .filter((row) => String(row.chunkIndex).startsWith(`${PAIRINGS_JSON_SLICE_PREFIX}row-`))
    .length;
}

function readPairingsJsonRowSlice(ctx: ServerContext, eventId: string, rowSliceIndex: number): string {
  const row = ctx.db.pairingsChunks
    .where("eventId", eventId)
    .all()
    .find((item) => String(item.chunkIndex) === pairingsJsonRowSliceKey(rowSliceIndex));

  if (!row) {
    throw new Error(`missing pairings JSON row slice ${rowSliceIndex}`);
  }

  return String(row.body);
}

function appendPairingsJsonToRowSlices(ctx: ServerContext, eventId: string, chunk: string): number {
  const rowRows = ctx.db.pairingsChunks
    .where("eventId", eventId)
    .all()
    .filter((row) => String(row.chunkIndex).startsWith(`${PAIRINGS_JSON_SLICE_PREFIX}row-`))
    .sort((left, right) => {
      const leftIndex = Number.parseInt(String(left.chunkIndex).split("-").pop() ?? "0", 10);
      const rightIndex = Number.parseInt(String(right.chunkIndex).split("-").pop() ?? "0", 10);
      return leftIndex - rightIndex;
    });

  let lastRow = rowRows.at(-1) ?? null;
  let remaining = chunk;

  while (remaining.length > 0) {
    const lastBody = lastRow ? String(lastRow.body) : "";
    const spaceInLastRow = LAKEBED_MAX_ROW_BYTES - lastBody.length;

    if (spaceInLastRow > 0) {
      const take = remaining.slice(0, spaceInLastRow);
      const updatedBody = lastBody + take;
      remaining = remaining.slice(take.length);

      if (lastRow) {
        ctx.db.pairingsChunks.update(lastRow.id, { body: updatedBody });
      } else {
        lastRow = ctx.db.pairingsChunks.insert({
          eventId,
          chunkIndex: pairingsJsonRowSliceKey(0),
          body: updatedBody
        });
      }
    }

    if (remaining.length === 0) {
      break;
    }

    const nextIndex = lastRow
      ? Number.parseInt(String(lastRow.chunkIndex).split("-").pop() ?? "0", 10) + 1
      : 0;
    const part = remaining.slice(0, LAKEBED_MAX_ROW_BYTES);
    remaining = remaining.slice(part.length);

    lastRow = ctx.db.pairingsChunks.insert({
      eventId,
      chunkIndex: pairingsJsonRowSliceKey(nextIndex),
      body: part
    });
  }

  return countPairingsJsonRowSlices(ctx, eventId);
}

type PairingsPrepState = {
  targetRound: number;
  recordIndex: Record<string, string>;
  seenKeys: string[];
  pairings: ParsedTournamentRound["pairings"];
};

function clearPairingsPrepState(ctx: ServerContext, eventId: string): void {
  const rows = ctx.db.pairingsChunks
    .where("eventId", eventId)
    .all()
    .filter((row) => String(row.chunkIndex) === PAIRINGS_PREP_STATE);
  deleteAllRows(ctx, "pairingsChunks", rows);
}

function readPairingsPrepState(ctx: ServerContext, eventId: string): PairingsPrepState | null {
  const row = ctx.db.pairingsChunks
    .where("eventId", eventId)
    .all()
    .find((item) => String(item.chunkIndex) === PAIRINGS_PREP_STATE);

  if (!row) {
    return null;
  }

  try {
    return JSON.parse(String(row.body)) as PairingsPrepState;
  } catch {
    return null;
  }
}

function writePairingsPrepState(ctx: ServerContext, eventId: string, state: PairingsPrepState): void {
  clearPairingsPrepState(ctx, eventId);
  ctx.db.pairingsChunks.insert({
    eventId,
    chunkIndex: PAIRINGS_PREP_STATE,
    body: JSON.stringify(state)
  });
}

function parsePairingsPrepBatch(
  ctx: ServerContext,
  eventId: string,
  targetRound: number,
  rowSliceStart: number,
  rowSliceEnd: number,
  state: PairingsPrepState
): PairingsPrepState {
  let recordIndex = new Map(Object.entries(state.recordIndex));
  const seen = new Set(state.seenKeys);
  let pairings = [...state.pairings];
  let partial = "";

  for (let index = rowSliceStart; index < rowSliceEnd; index++) {
    partial += readPairingsJsonRowSlice(ctx, eventId, index);
  }

  recordIndex = mergeTournamentRecordIndexes(
    recordIndex,
    buildTournamentRecordIndexRaw(partial)
  );

  let scanPayload = partial;
  if (rowSliceEnd < (readPairingsJsonMeta(ctx, eventId)?.rowSliceCount ?? rowSliceEnd)) {
    scanPayload += readPairingsJsonRowSlice(ctx, eventId, rowSliceEnd).slice(
      0,
      PAIRINGS_ROW_SLICE_OVERLAP_BYTES
    );
  }

  const batchPairings = extractPairingsForRoundRaw(scanPayload, targetRound, recordIndex);
  pairings = mergeExtractedPairings(pairings, batchPairings, seen, targetRound);

  return {
    targetRound,
    recordIndex: Object.fromEntries(recordIndex.entries()),
    seenKeys: [...seen],
    pairings
  };
}

function isPairingsStagingChunkIndex(chunkIndex: string): boolean {
  return chunkIndex === PAIRINGS_STAGING_META || /^\d+$/.test(chunkIndex);
}

async function probePairingsJsonSize(
  url: string
): Promise<{ totalBytes: number; fetchSliceCount: number; singleFetch: boolean }> {
  const probe = await fetch(url, { headers: { Range: "bytes=0-0" } });

  if (probe.status === 206) {
    const totalBytes = parseContentRangeTotal(probe.headers.get("Content-Range"));

    if (totalBytes !== null && totalBytes > LAKEBED_MAX_FETCH_BYTES) {
      return {
        totalBytes,
        fetchSliceCount: Math.ceil(totalBytes / LAKEBED_MAX_FETCH_BYTES),
        singleFetch: false
      };
    }

    if (totalBytes !== null) {
      return { totalBytes, fetchSliceCount: 1, singleFetch: true };
    }
  }

  const body = await fetchText(url);
  return { totalBytes: body.length, fetchSliceCount: 1, singleFetch: true };
}

async function fetchPairingsJsonSliceBody(
  url: string,
  sliceIndex: number,
  totalBytes: number,
  singleFetch: boolean
): Promise<string> {
  if (singleFetch) {
    return fetchText(url);
  }

  const start = sliceIndex * LAKEBED_MAX_FETCH_BYTES;
  const end = Math.min(start + LAKEBED_MAX_FETCH_BYTES - 1, totalBytes - 1);
  return fetchText(url, { headers: { Range: `bytes=${start}-${end}` } });
}

function clearPairingsJsonSlices(ctx: ServerContext, eventId: string): void {
  const rows = ctx.db.pairingsChunks
    .where("eventId", eventId)
    .all()
    .filter(
      (row) =>
        isPairingsJsonChunkIndex(String(row.chunkIndex)) ||
        String(row.chunkIndex) === PAIRINGS_PREP_STATE
    );
  deleteAllRows(ctx, "pairingsChunks", rows);
}

function readPairingsJsonMeta(ctx: ServerContext, eventId: string): PairingsJsonMeta | null {
  const row = ctx.db.pairingsChunks
    .where("eventId", eventId)
    .all()
    .find((item) => String(item.chunkIndex) === PAIRINGS_JSON_META);

  if (!row) {
    return null;
  }

  try {
    return JSON.parse(String(row.body)) as PairingsJsonMeta;
  } catch {
    return null;
  }
}

function writePairingsJsonMeta(ctx: ServerContext, eventId: string, meta: PairingsJsonMeta): void {
  const existing = ctx.db.pairingsChunks
    .where("eventId", eventId)
    .all()
    .filter((item) => String(item.chunkIndex) === PAIRINGS_JSON_META);
  deleteAllRows(ctx, "pairingsChunks", existing);

  ctx.db.pairingsChunks.insert({
    eventId,
    chunkIndex: PAIRINGS_JSON_META,
    body: JSON.stringify(meta)
  });
}

function assemblePairingsJsonFromSlices(ctx: ServerContext, eventId: string): string {
  const meta = readPairingsJsonMeta(ctx, eventId);
  if (!meta) {
    throw new Error("pairings JSON slices not fetched");
  }

  const parts: string[] = [];
  for (let index = 0; index < meta.rowSliceCount; index++) {
    const row = ctx.db.pairingsChunks
      .where("eventId", eventId)
      .all()
      .find((item) => String(item.chunkIndex) === pairingsJsonRowSliceKey(index));

    if (!row) {
      throw new Error(`missing pairings JSON row slice ${index}`);
    }

    parts.push(String(row.body));
  }

  return parts.join("");
}

async function fetchPairingsJsonSlice(
  ctx: ServerContext,
  event: TableRow,
  sliceIndex: number,
  options?: { force?: boolean }
): Promise<{ sliceIndex: number; sliceTotal: number; done: boolean }> {
  const externalEventId = String(event.externalEventId);
  const division = String(event.division) || "masters";
  const jsonUrl = standingsJsonUrl(externalEventId, division);

  if (sliceIndex === 0 || options?.force) {
    clearPairingsJsonSlices(ctx, event.id);
  }

  let meta = readPairingsJsonMeta(ctx, event.id);

  if (!meta || options?.force) {
    const probed = await probePairingsJsonSize(jsonUrl);
    meta = {
      totalBytes: probed.totalBytes,
      fetchSliceCount: probed.fetchSliceCount,
      rowSliceCount: 0,
      fetchedThrough: -1,
      jsonUrl
    };
    writePairingsJsonMeta(ctx, event.id, meta);
  }

  if (sliceIndex < 0 || sliceIndex >= meta.fetchSliceCount) {
    throw new Error(`invalid pairings JSON fetch slice index ${sliceIndex}`);
  }

  if (sliceIndex <= meta.fetchedThrough && !options?.force) {
    return {
      sliceIndex,
      sliceTotal: meta.fetchSliceCount,
      done: sliceIndex === meta.fetchSliceCount - 1
    };
  }

  const body = await fetchPairingsJsonSliceBody(
    jsonUrl,
    sliceIndex,
    meta.totalBytes,
    meta.fetchSliceCount === 1 && meta.totalBytes <= LAKEBED_MAX_FETCH_BYTES
  );

  const rowSliceCount = appendPairingsJsonToRowSlices(ctx, event.id, body);
  meta = {
    ...meta,
    rowSliceCount,
    fetchedThrough: sliceIndex,
    totalBytes: meta.totalBytes || body.length
  };
  writePairingsJsonMeta(ctx, event.id, meta);

  ctx.log.info("pairings JSON fetch slice appended", {
    externalEventId,
    sliceIndex,
    fetchSliceTotal: meta.fetchSliceCount,
    byteLength: body.length,
    rowSliceCount
  });

  const isLastFetchSlice = sliceIndex === meta.fetchSliceCount - 1;

  return {
    sliceIndex,
    sliceTotal: meta.fetchSliceCount,
    done: isLastFetchSlice
  };
}

async function fetchTextLarge(url: string): Promise<string> {
  const probed = await probePairingsJsonSize(url);

  if (probed.singleFetch) {
    return fetchPairingsJsonSliceBody(url, 0, probed.totalBytes, true);
  }

  const parts: string[] = [];
  for (let index = 0; index < probed.fetchSliceCount; index++) {
    parts.push(await fetchPairingsJsonSliceBody(url, index, probed.totalBytes, false));
  }

  return parts.join("");
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

function pairingsImportFresh(ctx: ServerContext, eventId: string, liveRound: number): boolean {
  const rows = ctx.db.pairings.where("eventId", eventId).all();
  if (rows.length === 0 || liveRound <= 0) {
    return false;
  }

  const hasLiveRound = rows.some(
    (row) => parseEventRound(String(row.roundNumber)) === liveRound
  );
  if (!hasLiveRound) {
    return false;
  }

  const importedAt = Date.parse(String(rows[0].importedAt));
  if (Number.isNaN(importedAt)) {
    return false;
  }

  return Date.now() - importedAt < PAIRINGS_CACHE_MS;
}

function cpImportSecretMatches(ctx: ServerContext, provided: string | null): boolean {
  const expected = ctx.env.CP_IMPORT_SECRET?.trim();
  if (!expected) {
    return false;
  }
  return provided === expected;
}

function insertPairingRow(
  ctx: ServerContext,
  eventId: string,
  currentRound: number,
  pairing: {
    tableNumber: number | null;
    playerA: { displayName: string; country: string; tournamentRecord: string | null };
    playerB: { displayName: string; country: string; tournamentRecord: string | null } | null;
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
    playerARecord: playerALabel.tournamentRecord ?? "",
    playerBName: playerBLabel ? playerBLabel.displayName : "",
    playerBNormalizedName: playerBLabel ? normalizePlayerName(playerBLabel.displayName) : "",
    playerBCountry: playerBLabel ? playerBLabel.country : "",
    playerBRecord: playerBLabel ? playerBLabel.tournamentRecord ?? "" : "",
    result: pairing.result ?? "",
    isPending: pairing.isPending,
    isBye: pairing.isBye,
    importedAt
  });
}


function clearEventPairingData(ctx: ServerContext, eventId: string): void {
  const existingPairings = ctx.db.pairings.where("eventId", eventId).all();
  deleteAllRows(ctx, "pairings", existingPairings);

  const payloads = ctx.db.sourcePayloads
    .where("source", PAYLOAD_SOURCE.pairingsJson)
    .all()
    .filter((row) => String(row.eventId) === eventId);
  deleteAllRows(ctx, "sourcePayloads", payloads);

  clearPairingsChunks(ctx, eventId);
}

type PairingsStagingMeta = {
  roundNumber: number;
  pairingCount: number;
  chunkTotal: number;
  title: string;
  importedAt: string;
};

function clearPairingsChunks(ctx: ServerContext, eventId: string): void {
  const rows = ctx.db.pairingsChunks.where("eventId", eventId).all();
  deleteAllRows(ctx, "pairingsChunks", rows);
}

function clearPairingsStagingOnly(ctx: ServerContext, eventId: string): void {
  const rows = ctx.db.pairingsChunks
    .where("eventId", eventId)
    .all()
    .filter((row) => isPairingsStagingChunkIndex(String(row.chunkIndex)));
  deleteAllRows(ctx, "pairingsChunks", rows);
}

function readPairingsStagingMeta(ctx: ServerContext, eventId: string): PairingsStagingMeta | null {
  const row = ctx.db.pairingsChunks
    .where("eventId", eventId)
    .all()
    .find((item) => String(item.chunkIndex) === PAIRINGS_STAGING_META);

  if (!row) {
    return null;
  }

  try {
    return JSON.parse(String(row.body)) as PairingsStagingMeta;
  } catch {
    return null;
  }
}

function writePairingsStagingMeta(ctx: ServerContext, eventId: string, meta: PairingsStagingMeta): void {
  const existing = ctx.db.pairingsChunks
    .where("eventId", eventId)
    .all()
    .filter((item) => String(item.chunkIndex) === PAIRINGS_STAGING_META);
  deleteAllRows(ctx, "pairingsChunks", existing);

  ctx.db.pairingsChunks.insert({
    eventId,
    chunkIndex: PAIRINGS_STAGING_META,
    body: JSON.stringify(meta)
  });
}

function chunkPairingRowsByCount(rows: CompactPairingRow[], size: number): CompactPairingRow[][] {
  const chunks: CompactPairingRow[][] = [];

  for (let index = 0; index < rows.length; index += size) {
    chunks.push(rows.slice(index, index + size));
  }

  return chunks;
}

function storePairingsStagingChunks(
  ctx: ServerContext,
  eventId: string,
  compactRows: CompactPairingRow[]
): number {
  clearPairingsStagingOnly(ctx, eventId);

  const chunks =
    compactRows.length <= PAIRINGS_ROWS_PER_COMMIT
      ? [compactRows]
      : chunkPairingRowsByCount(compactRows, PAIRINGS_ROWS_PER_COMMIT);

  for (let index = 0; index < chunks.length; index++) {
    ctx.db.pairingsChunks.insert({
      eventId,
      chunkIndex: String(index),
      body: JSON.stringify(chunks[index])
    });
  }

  return chunks.length;
}

function loadPairingsStagingChunk(
  ctx: ServerContext,
  eventId: string,
  chunkIndex: number
): CompactPairingRow[] {
  const row = ctx.db.pairingsChunks
    .where("eventId", eventId)
    .all()
    .find((item) => String(item.chunkIndex) === String(chunkIndex));

  if (!row) {
    return [];
  }

  const parsed = JSON.parse(String(row.body)) as CompactPairingRow[];
  return Array.isArray(parsed) ? parsed : [];
}

function finalizePairingsImport(
  ctx: ServerContext,
  event: TableRow,
  meta: PairingsStagingMeta
): {
  roundNumber: number;
  pairingCount: number;
  unmatchedPlayerCount: number;
  ambiguousPlayerCount: number;
  title: string;
} {
  const now = new Date().toISOString();
  ctx.db.events.update(event.id, {
    importedRound: String(meta.roundNumber),
    title: meta.title || String(event.title),
    lastRefreshAt: now
  });

  clearPairingsChunks(ctx, event.id);

  const ranked = rankPairings(
    buildPairings(ctx, { ...event, importedRound: String(meta.roundNumber) }, meta.roundNumber)
  );
  const { unmatched, ambiguous } = countUnmatchedPlayers(ranked);

  return {
    roundNumber: meta.roundNumber,
    pairingCount: meta.pairingCount,
    unmatchedPlayerCount: unmatched,
    ambiguousPlayerCount: ambiguous,
    title: meta.title || String(event.title)
  };
}

function resolvePairingsTargetRound(
  ctx: ServerContext,
  event: TableRow,
  htmlRound: number | null,
  jsonBody: string
): number {
  const storedRound = parseEventRound(String(event.currentRound));
  const standingsRoundFromBody = detectCurrentRoundFromPayload(jsonBody);

  return htmlRound !== null
    ? Math.max(htmlRound, standingsRoundFromBody, storedRound)
    : resolveCurrentRound(null, Math.max(standingsRoundFromBody, storedRound));
}

function beginPreparePairingsFromJsonSlices(
  ctx: ServerContext,
  event: TableRow
): { targetRound: number; parseBatchTotal: number } {
  const jsonMeta = readPairingsJsonMeta(ctx, event.id);

  if (!jsonMeta || jsonMeta.rowSliceCount < 1) {
    throw new Error("pairings JSON slices not fetched");
  }

  const targetRound = parseEventRound(
    String(getActiveEvent(ctx)?.currentRound ?? event.currentRound)
  );

  if (targetRound < 1) {
    throw new Error("current round is unknown; sync round before importing pairings");
  }

  clearPairingsStagingOnly(ctx, event.id);
  clearPairingsPrepState(ctx, event.id);

  writePairingsPrepState(ctx, event.id, {
    targetRound,
    recordIndex: {},
    seenKeys: [],
    pairings: []
  });

  const parseBatchTotal = Math.ceil(jsonMeta.rowSliceCount / PAIRINGS_ROW_SLICE_PARSE_BATCH);

  ctx.log.info("pairings import parse batches scheduled", {
    externalEventId: String(event.externalEventId),
    targetRound,
    rowSliceCount: jsonMeta.rowSliceCount,
    parseBatchTotal
  });

  return { targetRound, parseBatchTotal };
}

function parsePreparePairingsBatch(
  ctx: ServerContext,
  event: TableRow,
  batchIndex: number
): { batchIndex: number; parseBatchTotal: number; done: boolean } {
  const jsonMeta = readPairingsJsonMeta(ctx, event.id);

  if (!jsonMeta || jsonMeta.rowSliceCount < 1) {
    throw new Error("pairings JSON slices not fetched");
  }

  const parseBatchTotal = Math.ceil(jsonMeta.rowSliceCount / PAIRINGS_ROW_SLICE_PARSE_BATCH);

  if (batchIndex < 0 || batchIndex >= parseBatchTotal) {
    throw new Error(`invalid pairings parse batch index ${batchIndex}`);
  }

  const state = readPairingsPrepState(ctx, event.id);

  if (!state) {
    throw new Error("pairings import parse not started");
  }

  const rowSliceStart = batchIndex * PAIRINGS_ROW_SLICE_PARSE_BATCH;
  const rowSliceEnd = Math.min(
    rowSliceStart + PAIRINGS_ROW_SLICE_PARSE_BATCH,
    jsonMeta.rowSliceCount
  );

  const updated = parsePairingsPrepBatch(
    ctx,
    event.id,
    state.targetRound,
    rowSliceStart,
    rowSliceEnd,
    state
  );

  writePairingsPrepState(ctx, event.id, updated);

  return {
    batchIndex,
    parseBatchTotal,
    done: batchIndex === parseBatchTotal - 1
  };
}

function finalizePreparePairingsFromJsonSlices(
  ctx: ServerContext,
  event: TableRow
): {
  roundNumber: number;
  pairingCount: number;
  chunkTotal: number;
  title: string;
} {
  const externalEventId = String(event.externalEventId);
  const state = readPairingsPrepState(ctx, event.id);

  if (!state) {
    throw new Error("pairings import parse not started");
  }

  const parsedPairings = state.pairings;

  if (parsedPairings.length === 0) {
    throw new Error(`nenhuma partida encontrada para a rodada ${state.targetRound}`);
  }

  const compactRows = parsedPairings.map((pairing) => compactPairing(pairing));
  const chunkTotal = storePairingsStagingChunks(ctx, event.id, compactRows);
  const title = String(event.title);
  const importedAt = new Date().toISOString();

  writePairingsStagingMeta(ctx, event.id, {
    roundNumber: state.targetRound,
    pairingCount: parsedPairings.length,
    chunkTotal,
    title,
    importedAt
  });

  clearPairingsPrepState(ctx, event.id);

  ctx.log.info("pairings staged for chunked import", {
    externalEventId,
    roundNumber: state.targetRound,
    pairingCount: parsedPairings.length,
    chunkTotal
  });

  return {
    roundNumber: state.targetRound,
    pairingCount: parsedPairings.length,
    chunkTotal,
    title
  };
}

async function preparePairingsStaging(
  ctx: ServerContext,
  event: TableRow,
  options?: { force?: boolean; fetchPageHtml?: boolean; fromJsonSlices?: boolean }
): Promise<{
  roundNumber: number;
  pairingCount: number;
  chunkTotal: number;
  title: string;
}> {
  const externalEventId = String(event.externalEventId);
  const division = String(event.division) || "masters";
  const jsonUrl = standingsJsonUrl(externalEventId, division);

  let pageHtml: string | null = null;
  let htmlRound: number | null = null;

  if (options?.fetchPageHtml !== false) {
    pageHtml = await fetchText(standingsPageUrl(externalEventId, division));
    htmlRound = parseCurrentRoundFromHtml(pageHtml);

    if (htmlRound !== null) {
      const titleFromHtml = parseEventTitleFromHtml(pageHtml);
      ctx.db.events.update(event.id, {
        currentRound: String(htmlRound),
        lastRefreshAt: new Date().toISOString(),
        ...(titleFromHtml ? { title: titleFromHtml } : {})
      });
    }
  }

  const liveRound =
    htmlRound ?? parseEventRound(String(getActiveEvent(ctx)?.currentRound ?? event.currentRound));

  const cached = getLatestSourcePayload(ctx, PAYLOAD_SOURCE.pairingsJson, event.id);
  const standingsRound = cached ? detectCurrentRoundFromPayload(String(cached.body)) : null;
  let jsonBody = "";

  if (options?.fromJsonSlices) {
    throw new Error("use preparePairingsImportBegin/ParseBatch/Finalize for JSON slice imports");
  } else if (
    !options?.force &&
    pairingsImportFresh(ctx, event.id, liveRound) &&
    cached &&
    standingsRound !== null &&
    countPairingsInRound(String(cached.body), liveRound) > 0
  ) {
    jsonBody = String(cached.body);
  } else {
    jsonBody = await fetchTextLarge(jsonUrl);
    replaceSourcePayload(ctx, PAYLOAD_SOURCE.pairingsJson, event.id, jsonBody);
  }

  const targetRound = resolvePairingsTargetRound(ctx, event, htmlRound, jsonBody);

  const { roundNumber, pairings: parsedPairings } = parsePairingsForTargetRound(
    ctx,
    jsonBody,
    targetRound
  );

  if (parsedPairings.length === 0) {
    throw new Error(`nenhuma partida encontrada para a rodada ${targetRound}`);
  }

  const compactRows = parsedPairings.map((pairing) => compactPairing(pairing));
  const chunkTotal = storePairingsStagingChunks(ctx, event.id, compactRows);
  const title = (pageHtml ? parseEventTitleFromHtml(pageHtml) : "") || String(event.title);
  const importedAt = new Date().toISOString();

  writePairingsStagingMeta(ctx, event.id, {
    roundNumber,
    pairingCount: parsedPairings.length,
    chunkTotal,
    title,
    importedAt
  });

  ctx.log.info("pairings staged for chunked import", {
    externalEventId,
    roundNumber,
    pairingCount: parsedPairings.length,
    chunkTotal,
    jsonByteLength: jsonBody.length
  });

  return {
    roundNumber,
    pairingCount: parsedPairings.length,
    chunkTotal,
    title
  };
}

function commitPairingsStagingChunk(
  ctx: ServerContext,
  event: TableRow,
  chunkIndex: number
): {
  inserted: number;
  done: boolean;
  roundNumber: number;
  pairingCount: number;
  unmatchedPlayerCount: number;
  ambiguousPlayerCount: number;
  title: string;
} {
  const meta = readPairingsStagingMeta(ctx, event.id);

  if (!meta) {
    throw new Error("pairings staging not prepared");
  }

  if (chunkIndex < 0 || chunkIndex >= meta.chunkTotal) {
    throw new Error(`invalid pairings chunk index ${chunkIndex}`);
  }

  if (chunkIndex === 0) {
    const existingPairings = ctx.db.pairings
      .where("eventId", event.id)
      .all()
      .filter((row) => parseEventRound(String(row.roundNumber)) === meta.roundNumber);
    deleteAllRows(ctx, "pairings", existingPairings);
  }

  const compactRows = loadPairingsStagingChunk(ctx, event.id, chunkIndex);
  const importedAt = meta.importedAt;

  for (const compactRow of compactRows) {
    insertPairingRow(ctx, event.id, meta.roundNumber, expandCompactPairing(compactRow), importedAt);
  }

  const done = chunkIndex === meta.chunkTotal - 1;

  if (!done) {
    return {
      inserted: compactRows.length,
      done: false,
      roundNumber: meta.roundNumber,
      pairingCount: meta.pairingCount,
      unmatchedPlayerCount: 0,
      ambiguousPlayerCount: 0,
      title: meta.title
    };
  }

  const finalized = finalizePairingsImport(ctx, event, meta);

  return {
    inserted: compactRows.length,
    done: true,
    ...finalized
  };
}

async function importPairingsForEventChunked(
  ctx: ServerContext,
  event: TableRow,
  options?: { force?: boolean; fetchPageHtml?: boolean }
): Promise<{
  roundNumber: number;
  pairingCount: number;
  unmatchedPlayerCount: number;
  ambiguousPlayerCount: number;
  title: string;
}> {
  const staged = await preparePairingsStaging(ctx, event, options);
  let lastResult = {
    roundNumber: staged.roundNumber,
    pairingCount: 0,
    unmatchedPlayerCount: 0,
    ambiguousPlayerCount: 0,
    title: staged.title
  };

  for (let chunkIndex = 0; chunkIndex < staged.chunkTotal; chunkIndex++) {
    const committed = commitPairingsStagingChunk(ctx, event, chunkIndex);
    if (committed.done) {
      lastResult = {
        roundNumber: committed.roundNumber,
        pairingCount: committed.pairingCount,
        unmatchedPlayerCount: committed.unmatchedPlayerCount,
        ambiguousPlayerCount: committed.ambiguousPlayerCount,
        title: committed.title
      };
    }
  }

  return lastResult;
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
  const htmlRound = pageHtml ? parseCurrentRoundFromHtml(pageHtml) : null;
  const standingsRound = detectCurrentRoundFromPayload(jsonBody);
  const storedRound = Number.parseInt(String(event.currentRound), 10) || 0;
  const currentRound =
    htmlRound !== null
      ? Math.max(htmlRound, standingsRound, storedRound)
      : resolveCurrentRound(null, Math.max(standingsRound, storedRound));
  const { roundNumber, pairings } = parsePairingsForTargetRound(ctx, jsonBody, currentRound);
  const title = (pageHtml ? parseEventTitleFromHtml(pageHtml) : "") || String(event.title);

  const existingPairings = ctx.db.pairings
    .where("eventId", event.id)
    .all()
    .filter((row) => parseEventRound(String(row.roundNumber)) === roundNumber);
  deleteAllRows(ctx, "pairings", existingPairings);

  const importedAt = new Date().toISOString();

  for (const pairing of pairings) {
    insertPairingRow(ctx, event.id, roundNumber, pairing, importedAt);
  }

  const now = new Date().toISOString();
  ctx.db.events.update(event.id, {
    importedRound: String(roundNumber),
    title,
    lastRefreshAt: now
  });

  const ranked = rankPairings(
    buildPairings(ctx, { ...event, importedRound: String(roundNumber) }, roundNumber)
  );
  const { unmatched, ambiguous } = countUnmatchedPlayers(ranked);

  return {
    roundNumber,
    pairingCount: pairings.length,
    unmatchedPlayerCount: unmatched,
    ambiguousPlayerCount: ambiguous,
    title
  };
}

async function importPairingsForEvent(
  ctx: ServerContext,
  event: TableRow,
  options?: { force?: boolean; fetchPageHtml?: boolean }
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

  const jsonUrl = standingsJsonUrl(externalEventId, division);
  let jsonBody = "";
  let fromCache = false;
  let pageHtml: string | null = null;
  let htmlRound: number | null = null;

  if (options?.fetchPageHtml !== false) {
    pageHtml = await fetchText(standingsPageUrl(externalEventId, division));
    htmlRound = parseCurrentRoundFromHtml(pageHtml);

    if (htmlRound !== null) {
      const titleFromHtml = parseEventTitleFromHtml(pageHtml);
      ctx.db.events.update(event.id, {
        currentRound: String(htmlRound),
        lastRefreshAt: new Date().toISOString(),
        ...(titleFromHtml ? { title: titleFromHtml } : {})
      });
      ctx.log.info("current round synced from PokéData HTML", {
        externalEventId,
        htmlRound
      });
    }
  }

  const cached = getLatestSourcePayload(ctx, PAYLOAD_SOURCE.pairingsJson, event.id);
  const standingsRound = cached ? detectCurrentRoundFromPayload(String(cached.body)) : null;

  if (
    !options?.force &&
    pairingsImportFresh(ctx, event.id) &&
    cached &&
    standingsRound !== null &&
    countPairingsInRound(String(cached.body), standingsRound) > 0
  ) {
    jsonBody = String(cached.body);
    fromCache = true;
    ctx.log.info("pairings served from cache", {
      externalEventId,
      fetchedAt: String(cached.fetchedAt),
      roundNumber: standingsRound
    });
  } else {
    jsonBody = await fetchTextLarge(jsonUrl);
    replaceSourcePayload(ctx, PAYLOAD_SOURCE.pairingsJson, event.id, jsonBody);
  }

  try {
    const result = applyPairingsPayload(ctx, event, jsonBody, pageHtml);
    return { ...result, fromCache };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const roundNumber =
      htmlRound ?? (Number.parseInt(String(event.currentRound), 10) || 0);
    const pairingCount = ctx.db.pairings.where("eventId", event.id).all().length;

    ctx.log.error("pairings import failed after round sync", {
      externalEventId,
      roundNumber,
      message
    });

    if (htmlRound !== null) {
      return {
        roundNumber,
        pairingCount,
        unmatchedPlayerCount: 0,
        ambiguousPlayerCount: 0,
        title: String(event.title),
        fromCache
      };
    }

    throw error;
  }
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
      importedRound: string(),
      lastRefreshAt: string(),
      isActive: boolean().default(true)
    }),
    cpChunks: table({
      chunkIndex: string(),
      body: string()
    }),
    pairingsChunks: table({
      eventId: string(),
      chunkIndex: string(),
      body: string()
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
      playerARecord: string(),
      playerBName: string(),
      playerBNormalizedName: string(),
      playerBCountry: string(),
      playerBRecord: string(),
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
    eventDashboard: query(async (ctx) => {
      const serverCtx = ctx as ServerContext;
      const event = getActiveEvent(serverCtx);

      if (event) {
        await syncCurrentRoundFromPokeData(serverCtx, event);
      }

      return buildEventDashboard(serverCtx, { pendingOnly: false });
    }),

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

      const dashboard = buildEventDashboard(serverCtx, { pendingOnly: false });

      for (const pairing of dashboard.rankedPairings) {
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
    }),

    championshipPointsMeta: query((ctx) => readChampionshipPointsMeta(ctx as ServerContext))
  },

  mutations: {
    configureEvent: mutation(async (ctx, externalEventId: string, sourceUrl: string, division: string) => {
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

        clearEventPairingData(serverCtx, duplicate.id);
        serverCtx.db.events.update(duplicate.id, {
          currentRound: "0",
          importedRound: "0",
          title: `Event ${parsedId}`
        });

        serverCtx.log.info("event configured", {
          externalEventId: parsedId,
          division: normalizedDivision,
          eventId: duplicate.id
        });

        const eventRow = {
          ...duplicate,
          externalEventId: parsedId,
          sourceUrl: resolvedSourceUrl,
          division: normalizedDivision,
          isActive: true
        };

        await syncCurrentRoundFromPokeData(serverCtx, eventRow);

        return { eventId: duplicate.id };
      }

      const created = serverCtx.db.events.insert({
        externalEventId: parsedId,
        sourceUrl: resolvedSourceUrl,
        division: normalizedDivision,
        title: `Event ${parsedId}`,
        currentRound: "0",
        importedRound: "0",
        lastRefreshAt: now,
        isActive: true
      });

      serverCtx.log.info("event configured", {
        externalEventId: parsedId,
        division: normalizedDivision,
        eventId: created.id
      });

      await syncCurrentRoundFromPokeData(serverCtx, created);

      return { eventId: created.id };
    }),

    preparePairingsImportBegin: mutation(async (ctx) => {
      const serverCtx = ctx as ServerContext;
      const event = getActiveEvent(serverCtx);

      if (!event) {
        throw new Error("no active event");
      }

      const externalEventId = String(event.externalEventId);
      const startedAt = new Date().toISOString();

      serverCtx.db.refreshRuns.insert({
        eventId: event.id,
        startedAt,
        finishedAt: "",
        status: "running",
        roundNumber: String(event.currentRound),
        pairingCount: "0",
        unmatchedPlayerCount: "0",
        ambiguousPlayerCount: "0",
        message: "staging"
      });

      trimRefreshRuns(serverCtx, event.id);
      serverCtx.log.info("pairings import staging started", { externalEventId });

      return beginPreparePairingsFromJsonSlices(serverCtx, event);
    }),

    preparePairingsImportParseBatch: mutation((ctx, batchIndex: number) => {
      const serverCtx = ctx as ServerContext;
      const event = getActiveEvent(serverCtx);

      if (!event) {
        throw new Error("no active event");
      }

      try {
        return parsePreparePairingsBatch(serverCtx, event, batchIndex);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const run = getLatestRunningRefreshRun(serverCtx, event.id);

        if (run) {
          serverCtx.db.refreshRuns.update(run.id, {
            finishedAt: new Date().toISOString(),
            status: "error",
            message
          });
        }

        serverCtx.log.error("pairings import parse batch failed", {
          externalEventId: String(event.externalEventId),
          batchIndex,
          message
        });
        throw error;
      }
    }),

    preparePairingsImportFinalize: mutation((ctx) => {
      const serverCtx = ctx as ServerContext;
      const event = getActiveEvent(serverCtx);

      if (!event) {
        throw new Error("no active event");
      }

      try {
        return finalizePreparePairingsFromJsonSlices(serverCtx, event);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const run = getLatestRunningRefreshRun(serverCtx, event.id);

        if (run) {
          serverCtx.db.refreshRuns.update(run.id, {
            finishedAt: new Date().toISOString(),
            status: "error",
            message
          });
        }

        serverCtx.log.error("pairings import finalize failed", {
          externalEventId: String(event.externalEventId),
          message
        });
        throw error;
      }
    }),

    fetchPairingsJsonSlice: mutation(async (ctx, sliceIndex: number, force?: boolean) => {
      const serverCtx = ctx as ServerContext;
      const event = getActiveEvent(serverCtx);

      if (!event) {
        throw new Error("no active event");
      }

      return fetchPairingsJsonSlice(serverCtx, event, sliceIndex, {
        force: Boolean(force)
      });
    }),

    commitPairingsChunk: mutation((ctx, chunkIndex: number) => {
      const serverCtx = ctx as ServerContext;
      const event = getActiveEvent(serverCtx);

      if (!event) {
        throw new Error("no active event");
      }

      const committed = commitPairingsStagingChunk(serverCtx, event, chunkIndex);
      const run = getLatestRunningRefreshRun(serverCtx, event.id);

      if (committed.done && run) {
        const now = new Date().toISOString();
        serverCtx.db.refreshRuns.update(run.id, {
          finishedAt: now,
          status: "success",
          roundNumber: String(committed.roundNumber),
          pairingCount: String(committed.pairingCount),
          unmatchedPlayerCount: String(committed.unmatchedPlayerCount),
          ambiguousPlayerCount: String(committed.ambiguousPlayerCount),
          message: "ok"
        });

        trimRefreshRuns(serverCtx, event.id);

        serverCtx.log.info("pairings import completed", {
          externalEventId: String(event.externalEventId),
          roundNumber: committed.roundNumber,
          pairingCount: committed.pairingCount
        });
      }

      return committed;
    }),

    syncCurrentRound: mutation(async (ctx) => {
      const serverCtx = ctx as ServerContext;
      const event = getActiveEvent(serverCtx);

      if (!event) {
        throw new Error("no active event");
      }

      const roundNumber = await syncCurrentRoundFromPokeData(serverCtx, event);

      if (roundNumber === null) {
        throw new Error("could not read current round from PokéData");
      }

      return { roundNumber };
    }),

    refreshChampionshipPoints: mutation((ctx) => {
      const meta = readChampionshipPointsMeta(ctx as ServerContext);
      throw new Error(
        `CP não são importados no Lakebed (limite de runtime). Rode scripts/sync-cp-to-lakebed.mjs localmente. Jogadores no banco: ${meta.playerCount}.`
      );
    }),

    refreshPairings: mutation(async (ctx) => {
      const serverCtx = ctx as ServerContext;
      const event = getActiveEvent(serverCtx);

      if (!event) {
        throw new Error("no active event");
      }

      return importPairingsForEventChunked(serverCtx, event, {
        force: true,
        fetchPageHtml: true
      });
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
  },

  endpoints: {
    importChampionshipPoints: endpoint(
      { method: "POST", path: "/api/cp/import" },
      async (ctx, req) => {
        const serverCtx = ctx as ServerContext;
        const secret = req.headers.get("x-cp-import-secret");

        if (!cpImportSecretMatches(serverCtx, secret)) {
          return text("unauthorized", { status: 401 });
        }

        let payload: {
          replace?: boolean;
          chunkIndex?: number;
          chunkTotal?: number;
          division?: string;
          players?: CompactCpRow[];
        };

        try {
          payload = await req.json();
        } catch {
          return json({ ok: false, error: "invalid json" }, { status: 400 });
        }

        const chunkIndex = Number(payload.chunkIndex);
        const chunkTotal = Number(payload.chunkTotal);
        const players = payload.players;

        if (
          !Number.isInteger(chunkIndex) ||
          chunkIndex < 0 ||
          !Number.isInteger(chunkTotal) ||
          chunkTotal < 1 ||
          chunkIndex >= chunkTotal ||
          !Array.isArray(players)
        ) {
          return json({ ok: false, error: "invalid chunk payload" }, { status: 400 });
        }

        const result = importCpChunk(serverCtx, {
          replace: Boolean(payload.replace),
          chunkIndex,
          chunkTotal,
          division: String(payload.division ?? "masters"),
          players
        });

        return json({ ok: true, ...result, meta: readChampionshipPointsMeta(serverCtx) });
      }
    )
  }
});
