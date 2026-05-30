import type { ChampionshipPointsMatch, ChampionshipPointsPlayer, PlayerOverride } from "./domain";
import { countryCodesMatch } from "./normalize-country";
import { normalizePlayerName } from "./normalize-player-name";
import { firstLastKey } from "./match-player-keys";

const WILDCARD_COUNTRY = "*";

export type LeaderboardIndex = {
  byNameCountry: Map<string, ChampionshipPointsPlayer[]>;
  byName: Map<string, ChampionshipPointsPlayer[]>;
  byTokenCountry: Map<string, ChampionshipPointsPlayer[]>;
  byToken: Map<string, ChampionshipPointsPlayer[]>;
  byOverrideKey: Map<string, ChampionshipPointsPlayer>;
};

function nameCountryKey(normalizedName: string, country: string): string {
  return `${normalizedName}\0${country}`;
}

function pushToMap(map: Map<string, ChampionshipPointsPlayer[]>, key: string, player: ChampionshipPointsPlayer): void {
  const bucket = map.get(key);
  if (bucket) {
    bucket.push(player);
    return;
  }
  map.set(key, [player]);
}

export function createLeaderboardIndex(leaderboard: ChampionshipPointsPlayer[]): LeaderboardIndex {
  const byNameCountry = new Map<string, ChampionshipPointsPlayer[]>();
  const byName = new Map<string, ChampionshipPointsPlayer[]>();
  const byTokenCountry = new Map<string, ChampionshipPointsPlayer[]>();
  const byToken = new Map<string, ChampionshipPointsPlayer[]>();
  const byOverrideKey = new Map<string, ChampionshipPointsPlayer>();

  for (const player of leaderboard) {
    pushToMap(byNameCountry, nameCountryKey(player.normalizedName, player.country), player);
    pushToMap(byName, player.normalizedName, player);

    const tokenKey = firstLastKey(player.displayName);
    if (tokenKey.includes("|")) {
      pushToMap(byTokenCountry, nameCountryKey(tokenKey, player.country), player);
      pushToMap(byToken, tokenKey, player);
    }

    byOverrideKey.set(nameCountryKey(player.normalizedName, player.country), player);
  }

  return { byNameCountry, byName, byTokenCountry, byToken, byOverrideKey };
}

export function matchPlayerWithLeaderboardIndex(
  displayName: string,
  country: string,
  index: LeaderboardIndex,
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
    const target = index.byOverrideKey.get(
      nameCountryKey(override.leaderboardNormalizedName, override.leaderboardCountry)
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

  const exactMatches =
    index.byNameCountry.get(nameCountryKey(normalizedName, playerCountry)) ??
    [];

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

  const nameMatches = index.byName.get(normalizedName) ?? [];

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
    const tokenMatches =
      index.byTokenCountry.get(nameCountryKey(tokenKey, playerCountry)) ?? [];

    if (tokenMatches.length === 1) {
      return {
        championshipPoints: tokenMatches[0].championshipPoints,
        match: {
          status: "normalized-name",
          leaderboardDisplayName: tokenMatches[0].displayName
        }
      };
    }

    const tokenNameOnly = index.byToken.get(tokenKey) ?? [];
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
