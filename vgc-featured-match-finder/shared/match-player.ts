import type { ChampionshipPointsMatch, ChampionshipPointsPlayer, PlayerOverride } from "./domain";
import { normalizePlayerName } from "./normalize-player-name";

const WILDCARD_COUNTRY = "*";

function countryMatches(stored: string, playerCountry: string): boolean {
  if (stored === WILDCARD_COUNTRY || playerCountry === WILDCARD_COUNTRY) {
    return true;
  }
  if (!stored || !playerCountry) {
    return true;
  }
  return stored.toUpperCase() === playerCountry.toUpperCase();
}

export function matchPlayerToChampionshipPoints(
  displayName: string,
  country: string,
  leaderboard: ChampionshipPointsPlayer[],
  overrides: PlayerOverride[]
): { championshipPoints: number | null; match: ChampionshipPointsMatch } {
  const normalizedName = normalizePlayerName(displayName);
  const playerCountry = country || WILDCARD_COUNTRY;

  const override = overrides.find(
    (row) =>
      row.tournamentNormalizedName === normalizedName &&
      countryMatches(row.tournamentCountry, playerCountry)
  );

  if (override) {
    const target = leaderboard.find(
      (entry) =>
        entry.normalizedName === override.leaderboardNormalizedName &&
        countryMatches(override.leaderboardCountry, entry.country)
    );

    if (target) {
      return {
        championshipPoints: target.championshipPoints,
        match: {
          status: "manual-override",
          leaderboardDisplayName: target.displayName
        }
      };
    }
  }

  const exactMatches = leaderboard.filter(
    (entry) =>
      entry.normalizedName === normalizedName &&
      countryMatches(entry.country, playerCountry)
  );

  if (exactMatches.length === 1) {
    return {
      championshipPoints: exactMatches[0].championshipPoints,
      match: {
        status: "exact",
        leaderboardDisplayName: exactMatches[0].displayName
      }
    };
  }

  if (exactMatches.length > 1) {
    return {
      championshipPoints: null,
      match: {
        status: "ambiguous",
        candidates: exactMatches.map((entry) => entry.displayName)
      }
    };
  }

  const nameMatches = leaderboard.filter((entry) => entry.normalizedName === normalizedName);

  if (nameMatches.length === 1) {
    return {
      championshipPoints: nameMatches[0].championshipPoints,
      match: {
        status: "normalized-name",
        leaderboardDisplayName: nameMatches[0].displayName
      }
    };
  }

  if (nameMatches.length > 1) {
    return {
      championshipPoints: null,
      match: {
        status: "ambiguous",
        candidates: nameMatches.map((entry) => entry.displayName)
      }
    };
  }

  return {
    championshipPoints: null,
    match: { status: "not-found" }
  };
}
