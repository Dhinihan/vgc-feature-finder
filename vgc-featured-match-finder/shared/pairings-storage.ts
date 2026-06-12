import type { ParsedTournamentRound } from "./domain";

/** Compact row for staging pairings in Lakebed chunks (fits 64KB row limit). */
export type CompactPairingRow = [
  number | null,
  string,
  string,
  string,
  string,
  string,
  string,
  string | null,
  number,
  number
];

export function compactPairing(
  pairing: ParsedTournamentRound["pairings"][number]
): CompactPairingRow {
  return [
    pairing.tableNumber,
    pairing.playerA.displayName,
    pairing.playerA.country,
    pairing.playerA.tournamentRecord ?? "",
    pairing.playerB?.displayName ?? "",
    pairing.playerB?.country ?? "",
    pairing.playerB?.tournamentRecord ?? "",
    pairing.result,
    pairing.isPending ? 1 : 0,
    pairing.isBye ? 1 : 0
  ];
}

export function expandCompactPairing(row: CompactPairingRow): ParsedTournamentRound["pairings"][number] {
  const isBye = row[9] === 1;
  const isPending = row[8] === 1;

  return {
    tableNumber: row[0],
    playerA: {
      displayName: row[1],
      country: row[2],
      tournamentRecord: row[3] || null
    },
    playerB: isBye
      ? null
      : {
          displayName: row[4],
          country: row[5],
          tournamentRecord: row[6] || null
        },
    result: row[7],
    isPending,
    isBye
  };
}

export function chunkCompactPairings(
  rows: CompactPairingRow[],
  maxChunkBytes = 50_000
): CompactPairingRow[][] {
  const chunks: CompactPairingRow[][] = [];
  let current: CompactPairingRow[] = [];
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
