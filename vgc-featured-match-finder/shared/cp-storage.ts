import type { ChampionshipPointsPlayer } from "./domain";

/** Compact tuple: displayName, normalizedName, country, championshipPoints */
export type CompactCpRow = [string, string, string, number];

export function compactCpPlayers(players: ChampionshipPointsPlayer[]): CompactCpRow[] {
  return players.map((player) => [
    player.displayName,
    player.normalizedName,
    player.country,
    player.championshipPoints
  ]);
}

export function expandCpPlayers(rows: CompactCpRow[]): ChampionshipPointsPlayer[] {
  return rows.map(([displayName, normalizedName, country, championshipPoints]) => ({
    displayName,
    normalizedName,
    country,
    championshipPoints
  }));
}

export function chunkCompactPlayers(
  rows: CompactCpRow[],
  maxChunkBytes = 55_000
): CompactCpRow[][] {
  const chunks: CompactCpRow[][] = [];
  let current: CompactCpRow[] = [];
  let currentBytes = 2;

  for (const row of rows) {
    const rowBytes = JSON.stringify(row).length + 1;
    if (current.length > 0 && currentBytes + rowBytes > maxChunkBytes) {
      chunks.push(current);
      current = [];
      currentBytes = 2;
    }
    current.push(row);
    currentBytes += rowBytes;
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks;
}
