import type { ChampionshipPointsMatch, ChampionshipPointsPlayer, PlayerOverride } from "./domain";
import { createLeaderboardIndex, matchPlayerWithLeaderboardIndex } from "./leaderboard-index";

export function matchPlayerToChampionshipPoints(
  displayName: string,
  country: string,
  leaderboard: ChampionshipPointsPlayer[],
  overrides: PlayerOverride[]
): { championshipPoints: number | null; match: ChampionshipPointsMatch } {
  return matchPlayerWithLeaderboardIndex(
    displayName,
    country,
    createLeaderboardIndex(leaderboard),
    overrides
  );
}
