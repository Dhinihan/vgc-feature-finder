import type { ChampionshipPointsMatch, ChampionshipPointsPlayer, PlayerOverride } from "./domain";
import { countryCodesMatch } from "./normalize-country";
import { normalizePlayerName } from "./normalize-player-name";

const WILDCARD_COUNTRY = "*";

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
      countryCodesMatch(row.tournamentCountry, playerCountry)
  );

  if (override) {
    const target = leaderboard.find(
      (entry) =>
        entry.normalizedName === override.leaderboardNormalizedName &&
        countryCodesMatch(override.leaderboardCountry, entry.country)
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
      countryCodesMatch(entry.country, playerCountry)
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


  const tokenKey = firstLastKey(displayName);
  if (tokenKey.includes("|")) {
    const tokenMatches = leaderboard.filter(
      (entry) =>
        firstLastKey(entry.displayName) === tokenKey &&
        countryCodesMatch(entry.country, playerCountry)
    );

    if (tokenMatches.length === 1) {
      return {
        championshipPoints: tokenMatches[0].championshipPoints,
        match: {
          status: "normalized-name",
          leaderboardDisplayName: tokenMatches[0].displayName
        }
      };
    }

    const tokenNameOnly = leaderboard.filter((entry) => firstLastKey(entry.displayName) === tokenKey);
    if (tokenNameOnly.length === 1) {
      return {
        championshipPoints: tokenNameOnly[0].championshipPoints,
        match: {
          status: "normalized-name",
          leaderboardDisplayName: tokenNameOnly[0].displayName
        }
      };
    }

    if (tokenNameOnly.length > 1) {
      return {
        championshipPoints: null,
        match: {
          status: "ambiguous",
          candidates: tokenNameOnly.map((entry) => entry.displayName)
        }
      };
    }
  }

  return {
    championshipPoints: null,
    match: { status: "not-found" }
  };
}

function firstLastKey(displayName: string): string {
  const parts = displayName
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (parts.length < 2) {
    return parts[0] ?? "";
  }

  return `${parts[0]}|${parts[parts.length - 1]}`;
}
