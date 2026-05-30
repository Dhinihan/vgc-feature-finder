import type { Pairing, RankedPairing } from "./domain";

/** CP ausente no ranking conta como 1 na relevância (cpA × cpB), não 0. */
function cpForScoring(cp: number | null): number {
  return cp ?? 1;
}

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
    importanceScore: cpForScoring(cpA) * cpForScoring(cpB),
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
