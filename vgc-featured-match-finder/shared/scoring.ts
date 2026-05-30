import type { Pairing, RankedPairing } from "./domain";

export function scorePairing(pairing: Pairing): RankedPairing {
  if (!pairing.playerB || pairing.isBye) {
    return {
      ...pairing,
      importanceScore: 0,
      scoreStatus: "bye"
    };
  }

  const cpA = pairing.playerA.championshipPoints;
  const cpB = pairing.playerB.championshipPoints;

  return {
    ...pairing,
    importanceScore: (cpA ?? 0) * (cpB ?? 0),
    scoreStatus: cpA === null || cpB === null ? "missing-player-cp" : "complete"
  };
}

export function rankPairings(pairings: Pairing[]): RankedPairing[] {
  return pairings
    .map(scorePairing)
    .sort((a, b) => {
      if (b.importanceScore !== a.importanceScore) {
        return b.importanceScore - a.importanceScore;
      }

      return (
        (a.tableNumber ?? Number.MAX_SAFE_INTEGER) -
        (b.tableNumber ?? Number.MAX_SAFE_INTEGER)
      );
    });
}
