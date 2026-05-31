import type { ChampionshipPointsPlayer, ParsedTournamentRound } from "./domain";
import { normalizePlayerName } from "./normalize-player-name";

export type ParsedPlayerLabel = {
  displayName: string;
  country: string;
};

export function parsePlayerLabel(raw: string): ParsedPlayerLabel {
  const trimmed = raw.trim();
  const bracketMatch = trimmed.match(/^(.+?)\s*\[([A-Za-z]{2,3})\]\s*$/);

  if (bracketMatch) {
    return {
      displayName: bracketMatch[1].trim(),
      country: bracketMatch[2].toUpperCase()
    };
  }

  return {
    displayName: trimmed,
    country: ""
  };
}

function parsePositiveInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value));
  }

  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number.parseInt(value.replace(/[^\d]/g, ""), 10);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }

  return null;
}

function isPendingResult(result: string | null | undefined): boolean {
  if (result === null || result === undefined) {
    return true;
  }
  if (!result) {
    return true;
  }

  const normalized = result.trim().toUpperCase();
  return normalized === "" || normalized === "-" || normalized === "?" || normalized === "PENDING";
}

export function parseChampionshipPointsPayload(payload: string): ChampionshipPointsPlayer[] {
  const trimmed = payload.trim();
  if (!trimmed) {
    return [];
  }

  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    return parseChampionshipPointsJson(trimmed);
  }

  return parseChampionshipPointsHtml(trimmed);
}

function parseChampionshipPointsJson(payload: string): ChampionshipPointsPlayer[] {
  const parsed = JSON.parse(payload) as unknown;
  const rows = Array.isArray(parsed)
    ? parsed
    : typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { players?: unknown }).players)
      ? (parsed as { players: unknown[] }).players
      : [];

  const players: ChampionshipPointsPlayer[] = [];

  for (const row of rows) {
    if (typeof row !== "object" || row === null) {
      continue;
    }

    const record = row as Record<string, unknown>;
    const displayName = String(
      record.displayName ?? record.name ?? record.trainer ?? record.player ?? ""
    ).trim();

    if (!displayName) {
      continue;
    }

    const country = String(record.country ?? record.region ?? "").trim().toUpperCase();
    const points =
      parsePositiveInt(record.championshipPoints) ??
      parsePositiveInt(record.points) ??
      parsePositiveInt(record.cp) ??
      parsePositiveInt(record.total);

    if (points === null) {
      continue;
    }

    players.push({
      displayName,
      normalizedName: normalizePlayerName(displayName),
      country,
      championshipPoints: points
    });
  }

  return dedupeChampionshipPoints(players);
}

function parseChampionshipPointsHtml(payload: string): ChampionshipPointsPlayer[] {
  const players: ChampionshipPointsPlayer[] = [];
  const rowPattern = /<tr[^>]*>[\s\S]*?<\/tr>/gi;
  const rows = payload.match(rowPattern) ?? [];

  for (const row of rows) {
    const nameMatch =
      row.match(/class="player"[^>]*>([^<]+)</i) ?? row.match(/onclick="player\('([^']+)'/i);

    if (!nameMatch) {
      continue;
    }

    const displayName = nameMatch[1].replace(/&amp;/g, "&").trim();
    if (!displayName || /^\d+$/.test(displayName)) {
      continue;
    }

    const countryMatch = row.match(/class="country">([^<]+)</i);
    const country = (countryMatch?.[1] ?? "").trim().toUpperCase();

    // PokéData shows current Championship Points in the first `.cp` cell (`.pp` is Play Points).
    const cpMatch = row.match(/class="cp">([\d,]+)</i);
    if (!cpMatch) {
      continue;
    }

    const points = parsePositiveInt(cpMatch[1]);
    if (points === null) {
      continue;
    }

    players.push({
      displayName,
      normalizedName: normalizePlayerName(displayName),
      country,
      championshipPoints: points
    });
  }

  return dedupeChampionshipPoints(players);
}

function dedupeChampionshipPoints(players: ChampionshipPointsPlayer[]): ChampionshipPointsPlayer[] {
  const map = new Map<string, ChampionshipPointsPlayer>();

  for (const player of players) {
    const key = `${player.normalizedName}|${player.country || "*"}`;
    const existing = map.get(key);

    if (!existing || player.championshipPoints > existing.championshipPoints) {
      map.set(key, player);
    }
  }

  return [...map.values()].sort((a, b) => b.championshipPoints - a.championshipPoints);
}


export function countPairingsInRound(payload: string, roundNumber: number): number {
  const trimmed = payload.trim();
  if (!trimmed.startsWith("[")) {
    return 0;
  }

  const standings = JSON.parse(trimmed) as Array<Record<string, unknown>>;
  return extractPairingsFromStandings(standings, roundNumber).length;
}

export function parsePairingsForRound(payload: string, roundNumber: number): ParsedTournamentRound["pairings"] {
  const trimmed = payload.trim();
  if (!trimmed.startsWith("[")) {
    throw new Error("pairings payload must be JSON standings array");
  }

  const standings = JSON.parse(trimmed) as Array<Record<string, unknown>>;
  return extractPairingsFromStandings(standings, roundNumber);
}


export function parsePairingsPayload(payload: string): ParsedTournamentRound {
  const trimmed = payload.trim();

  if (!trimmed.startsWith("[")) {
    throw new Error("pairings payload must be JSON standings array");
  }

  const standings = JSON.parse(trimmed) as Array<Record<string, unknown>>;
  const currentRound = detectCurrentRound(standings);
  const pairings = extractPairingsFromStandings(standings, currentRound);

  return {
    title: "",
    currentRound,
    pairings
  };
}

export function parseEventTitleFromHtml(html: string): string {
  const match = html.match(/<h1[^>]*>([^<]+)</i);
  if (!match) {
    return "";
  }

  return match[1]
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseCurrentRoundFromHtml(html: string): number | null {
  const match = html.match(/Round\s+(\d+)\s*\/\s*(\d+)/i);
  if (!match) {
    return null;
  }

  return Number.parseInt(match[1], 10);
}

/** Prefer the most up-to-date round when PokéData HTML and JSON disagree. */
export function resolveCurrentRound(htmlRound: number | null, standingsRound: number): number {
  if (htmlRound === null) {
    return standingsRound;
  }

  if (standingsRound <= 0) {
    return htmlRound;
  }

  return Math.max(htmlRound, standingsRound);
}

export function formatTournamentRecord(record: unknown): string | null {
  if (!record || typeof record !== "object") {
    return null;
  }

  const row = record as { wins?: unknown; losses?: unknown; ties?: unknown };
  const wins = parsePositiveInt(row.wins) ?? 0;
  const losses = parsePositiveInt(row.losses) ?? 0;
  const ties = parsePositiveInt(row.ties) ?? 0;

  if (wins === 0 && losses === 0 && ties === 0) {
    return null;
  }

  if (ties > 0) {
    return `${wins}-${losses}-${ties}`;
  }

  return `${wins}-${losses}`;
}

function tournamentRecordKey(displayName: string, country: string): string {
  const label = parsePlayerLabel(
    displayName.includes("[") ? displayName : `${displayName}${country ? ` [${country}]` : ""}`
  );
  return `${normalizePlayerName(label.displayName)}:${(label.country || country || "*").toUpperCase()}`;
}

function buildTournamentRecordIndex(standings: Array<Record<string, unknown>>): Map<string, string> {
  const index = new Map<string, string>();

  for (const playerRow of standings) {
    const playerName = String(playerRow.name ?? "");
    const playerLabel = parsePlayerLabel(playerName);
    const formatted = formatTournamentRecord(playerRow.record);

    if (!formatted) {
      continue;
    }

    index.set(tournamentRecordKey(playerLabel.displayName, playerLabel.country), formatted);
  }

  return index;
}

function lookupTournamentRecord(
  index: Map<string, string>,
  label: ParsedPlayerLabel
): string | null {
  return index.get(tournamentRecordKey(label.displayName, label.country)) ?? null;
}

function detectCurrentRound(standings: Array<Record<string, unknown>>): number {
  let maxRound = 0;
  let highestPendingRound = 0;

  for (const player of standings) {
    const rounds = player.rounds;
    if (!rounds || typeof rounds !== "object") {
      continue;
    }

    for (const [key, roundData] of Object.entries(
      rounds as Record<string, { result?: string | null }>
    )) {
      const roundNumber = Number.parseInt(key, 10);
      if (Number.isNaN(roundNumber)) {
        continue;
      }

      if (roundNumber > maxRound) {
        maxRound = roundNumber;
      }

      if (isPendingResult(roundData?.result) && roundNumber > highestPendingRound) {
        highestPendingRound = roundNumber;
      }
    }
  }

  return highestPendingRound > 0 ? highestPendingRound : maxRound;
}

function extractPairingsFromStandings(
  standings: Array<Record<string, unknown>>,
  roundNumber: number
): ParsedTournamentRound["pairings"] {
  const roundKey = String(roundNumber);
  const seen = new Set<string>();
  const pairings: ParsedTournamentRound["pairings"] = [];
  const recordIndex = buildTournamentRecordIndex(standings);

  for (const playerRow of standings) {
    const playerName = String(playerRow.name ?? "");
    const playerLabel = parsePlayerLabel(playerName);
    const rounds = playerRow.rounds as Record<string, { name?: string; result?: string; table?: number }> | undefined;
    const round = rounds?.[roundKey];

    if (!round) {
      continue;
    }

    const opponentRaw = String(round.name ?? "").trim();
    const isBye = opponentRaw.toUpperCase() === "BYE" || opponentRaw === "";
    const tableNumber = typeof round.table === "number" && round.table > 0 ? round.table : null;
    const playerSide = normalizePlayerName(playerLabel.displayName);

    if (isBye) {
      const byeKey = `bye:${playerSide}:${roundKey}`;
      if (seen.has(byeKey)) {
        continue;
      }
      seen.add(byeKey);

      pairings.push({
        tableNumber,
        playerA: {
          ...playerLabel,
          tournamentRecord:
            lookupTournamentRecord(recordIndex, playerLabel) ??
            formatTournamentRecord(playerRow.record)
        },
        playerB: null,
        result: round.result ?? "W",
        isPending: isPendingResult(round.result),
        isBye: true
      });
      continue;
    }

    const opponentLabel = parsePlayerLabel(opponentRaw);
    const opponentSide = normalizePlayerName(opponentLabel.displayName);
    const names = [playerSide, opponentSide].sort();
    const dedupeKey = `${tableNumber ?? 0}:${names[0]}:${names[1]}`;

    if (seen.has(dedupeKey)) {
      continue;
    }

    if (playerSide > opponentSide) {
      continue;
    }

    seen.add(dedupeKey);

    pairings.push({
      tableNumber,
      playerA: {
        ...playerLabel,
        tournamentRecord: lookupTournamentRecord(recordIndex, playerLabel)
      },
      playerB: {
        ...opponentLabel,
        tournamentRecord: lookupTournamentRecord(recordIndex, opponentLabel)
      },
      result: formatMatchResult(round.result),
      isPending: isPendingResult(round.result),
      isBye: false
    });
  }

  return pairings.sort((a, b) => (a.tableNumber ?? 99999) - (b.tableNumber ?? 99999));
}

function formatMatchResult(result: string | null | undefined): string | null {
  if (result === null || result === undefined) {
    return null;
  }
  if (typeof result !== "string") {
    return null;
  }

  const normalized = result.trim().toUpperCase();
  if (isPendingResult(normalized)) {
    return null;
  }

  return normalized;
}

export function extractExternalEventId(input: string): string {
  const trimmed = input.trim();

  if (!trimmed) {
    return "";
  }

  const urlMatch = trimmed.match(/standingsVGC\/(\d+)/i);
  if (urlMatch) {
    return urlMatch[1];
  }

  if (/^\d+$/.test(trimmed)) {
    return trimmed;
  }

  return trimmed;
}

export function divisionJsonFileName(division: string): string {
  const normalized = division.trim().toLowerCase();
  if (normalized === "juniors") {
    return "Juniors";
  }
  if (normalized === "seniors") {
    return "Seniors";
  }
  return "Masters";
}

/** Minimal fixture used when external CP sources return no rows (local/demo). */
export const DEMO_CHAMPIONSHIP_POINTS_JSON = JSON.stringify([
  { name: "Dylan Salvanera", country: "US", points: 1200 },
  { name: "Zachary Weed", country: "US", points: 950 },
  { name: "Raghav Malaviya", country: "US", points: 800 },
  { name: "Zachary Carlson", country: "US", points: 725 },
  { name: "James Evans", country: "US", points: 700 },
  { name: "Oliver Eskolin", country: "FI", points: 650 },
  { name: "Andrew Figueras", country: "US", points: 600 },
  { name: "Emily Parson", country: "US", points: 550 },
  { name: "Henry Rich", country: "AU", points: 500 },
  { name: "Justin Tang", country: "US", points: 450 }
]);
