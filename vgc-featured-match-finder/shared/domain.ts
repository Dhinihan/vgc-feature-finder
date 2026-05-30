export type ChampionshipPointsPlayer = {
  displayName: string;
  normalizedName: string;
  country: string;
  championshipPoints: number;
};

export type ChampionshipPointsMatch =
  | {
      status: "exact";
      leaderboardDisplayName: string;
    }
  | {
      status: "normalized-name";
      leaderboardDisplayName: string;
    }
  | {
      status: "manual-override";
      leaderboardDisplayName: string;
    }
  | {
      status: "ambiguous";
      candidates: string[];
    }
  | {
      status: "not-found";
    };

export type TournamentPlayer = {
  displayName: string;
  normalizedName: string;
  country: string;
  tournamentRecord: string | null;
  championshipPoints: number | null;
  championshipPointsMatch: ChampionshipPointsMatch;
};

export type Pairing = {
  id: string;
  eventId: string;
  roundNumber: number;
  tableNumber: number | null;
  playerA: TournamentPlayer;
  playerB: TournamentPlayer | null;
  result: string | null;
  isPending: boolean;
  isBye: boolean;
};

export type RankedPairing = Pairing & {
  importanceScore: number;
  scoreStatus: "complete" | "missing-player-cp" | "bye";
};

export type ParsedTournamentRound = {
  title: string;
  currentRound: number;
  pairings: Array<{
    tableNumber: number | null;
    playerA: { displayName: string; country: string; tournamentRecord: string | null };
    playerB: { displayName: string; country: string; tournamentRecord: string | null } | null;
    result: string | null;
    isPending: boolean;
    isBye: boolean;
  }>;
};

export type PlayerOverride = {
  tournamentNormalizedName: string;
  tournamentCountry: string;
  leaderboardNormalizedName: string;
  leaderboardCountry: string;
};

export type EventDashboard = {
  event: {
    id: string;
    externalEventId: string;
    title: string;
    currentRound: number;
    lastRefreshAt: string;
    sourceUrl: string;
    division: string;
  } | null;
  rankedPairings: RankedPairing[];
  stats: {
    totalPairings: number;
    pendingPairings: number;
    completedPairings: number;
    unmatchedPlayers: number;
    ambiguousPlayers: number;
  };
};

export type RefreshResult = {
  championshipPointsUpdated: boolean;
  championshipPointsCount: number;
  pairingsCount: number;
  roundNumber: number;
  unmatchedPlayerCount: number;
  ambiguousPlayerCount: number;
  championshipPointsFromCache: boolean;
  pairingsFromCache: boolean;
};

export type ChampionshipPointsMeta = {
  playerCount: number;
  chunkCount: number;
  importedAt: string | null;
  division: string;
  source: string;
};

