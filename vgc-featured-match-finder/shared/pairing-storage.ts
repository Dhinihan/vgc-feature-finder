import type { ParsedTournamentRound } from "./domain";

/** Compact tuple: table, nameA, countryA, recordA, nameB, countryB, recordB, result, isPending, isBye */
export type CompactPairingRow = [
  number,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  0 | 1,
  0 | 1
];

export function compactPairings(
  pairings: ParsedTournamentRound["pairings"]
): CompactPairingRow[] {
  return pairings.map((pairing) => [
    pairing.tableNumber ?? 0,
    pairing.playerA.displayName,
    pairing.playerA.country,
    pairing.playerA.tournamentRecord ?? "",
    pairing.playerB?.displayName ?? "",
    pairing.playerB?.country ?? "",
    pairing.playerB?.tournamentRecord ?? "",
    pairing.result ?? "",
    pairing.isPending ? 1 : 0,
    pairing.isBye ? 1 : 0
  ]);
}

export function expandPairings(rows: CompactPairingRow[]): ParsedTournamentRound["pairings"] {
  return rows.map(
    ([
      tableNumber,
      playerAName,
      playerACountry,
      playerARecord,
      playerBName,
      playerBCountry,
      playerBRecord,
      result,
      isPending,
      isBye
    ]) => ({
      tableNumber: tableNumber > 0 ? tableNumber : null,
      playerA: {
        displayName: playerAName,
        country: playerACountry,
        tournamentRecord: playerARecord || null
      },
      playerB: playerBName
        ? {
            displayName: playerBName,
            country: playerBCountry,
            tournamentRecord: playerBRecord || null
          }
        : null,
      result: result || null,
      isPending: isPending === 1,
      isBye: isBye === 1
    })
  );
}

export function chunkCompactPairings(
  rows: CompactPairingRow[],
  maxChunkBytes = 55_000
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
