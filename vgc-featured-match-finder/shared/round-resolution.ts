/** Pick which stored round to show when live tournament round may be ahead of imported data. */
export function resolveDisplayRound(
  liveRound: number,
  importedRound: number,
  roundsWithPairings: number[]
): number {
  if (liveRound <= 0) {
    return importedRound > 0 ? importedRound : 0;
  }

  if (roundsWithPairings.length === 0) {
    return liveRound;
  }

  const sorted = [...new Set(roundsWithPairings)].sort((a, b) => b - a);

  if (sorted.includes(liveRound)) {
    return liveRound;
  }

  const atOrBelowLive = sorted.filter((round) => round <= liveRound);
  if (atOrBelowLive.length > 0) {
    return atOrBelowLive[0];
  }

  return sorted[0];
}

export function needsPairingsRefresh(
  liveRound: number,
  displayRound: number,
  pairingCount: number
): boolean {
  if (liveRound <= 0) {
    return false;
  }

  if (pairingCount === 0) {
    return true;
  }

  return displayRound < liveRound;
}
