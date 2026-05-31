import { matchPlayerToChampionshipPoints } from "./match-player";
import { normalizePlayerName } from "./normalize-player-name";
import {
  formatTournamentRecord,
  parseChampionshipPointsPayload,
  parsePairingsPayload,
  resolveCurrentRound
} from "./parsing";
import { rankPairings, scorePairing } from "./scoring";
import type { ChampionshipPointsPlayer, Pairing, PlayerOverride } from "./domain";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

export function runSmokeTests(): string[] {
  const results: string[] = [];

  assert(normalizePlayerName("João da Silva") === "joaodasilva", "accent normalization");
  assert(normalizePlayerName("JOAO DA SILVA") === "joaodasilva", "case normalization");
  assert(normalizePlayerName(" João Silva ") === "joaosilva", "spacing normalization");
  assert(normalizePlayerName("O'Brien, Chris.") === "obrienchris", "punctuation normalization");

  const leaderboard: ChampionshipPointsPlayer[] = [
    {
      displayName: "João da Silva",
      normalizedName: "joaodasilva",
      country: "BR",
      championshipPoints: 725
    },
    {
      displayName: "João Silva",
      normalizedName: "joaosilva",
      country: "BR",
      championshipPoints: 500
    },
    {
      displayName: "João Silva",
      normalizedName: "joaosilva",
      country: "PT",
      championshipPoints: 300
    }
  ];

  const overrides: PlayerOverride[] = [
    {
      tournamentNormalizedName: "joaodasilva",
      tournamentCountry: "BR",
      leaderboardNormalizedName: "joaosilva",
      leaderboardCountry: "BR"
    }
  ];

  const overrideMatch = matchPlayerToChampionshipPoints("João da Silva", "BR", leaderboard, overrides);
  assert(overrideMatch.match.status === "manual-override", "override priority");

  const exactMatch = matchPlayerToChampionshipPoints("João da Silva", "BR", leaderboard, []);
  assert(exactMatch.match.status === "exact", "exact match");

  const uniqueNameMatch = matchPlayerToChampionshipPoints("João Silva", "", leaderboard, []);
  assert(uniqueNameMatch.match.status === "ambiguous", "ambiguous homonym");

  const missing = matchPlayerToChampionshipPoints("Unknown Player", "US", leaderboard, []);
  assert(missing.match.status === "not-found", "not found");

  const pairing: Pairing = {
    id: "1",
    eventId: "evt",
    roundNumber: 1,
    tableNumber: 4,
    playerA: {
      displayName: "A",
      normalizedName: "a",
      country: "US",
      tournamentRecord: null,
      championshipPoints: 800,
      championshipPointsMatch: { status: "exact", leaderboardDisplayName: "A" }
    },
    playerB: {
      displayName: "B",
      normalizedName: "b",
      country: "US",
      tournamentRecord: null,
      championshipPoints: null,
      championshipPointsMatch: { status: "not-found" }
    },
    result: null,
    isPending: true,
    isBye: false
  };

  const scored = scorePairing(pairing);
  assert(scored.importanceScore === 800, "missing cp counts as 1 for scoring");
  assert(scored.scoreStatus === "missing-player-cp", "missing cp status");

  const completePairing: Pairing = {
    ...pairing,
    playerB: {
      ...pairing.playerB!,
      championshipPoints: 600,
      championshipPointsMatch: { status: "exact", leaderboardDisplayName: "B" }
    }
  };

  assert(scorePairing(completePairing).importanceScore === 480000, "score multiplication");

  const ranked = rankPairings([
    { ...completePairing, id: "1", tableNumber: 12, },
    {
      ...completePairing,
      id: "2",
      tableNumber: 4,
      playerA: { ...completePairing.playerA, championshipPoints: 1200 },
      playerB: { ...completePairing.playerB!, championshipPoints: 100 }
    }
  ]);

  assert(ranked[0].importanceScore >= ranked[1].importanceScore, "descending score order");

  const cpPayload = JSON.stringify([
    { name: "Tester [US]", country: "US", points: 100 }
  ]);
  const cpPlayers = parseChampionshipPointsPayload(cpPayload);
  assert(cpPlayers.length === 1, "cp json parser");

  assert(formatTournamentRecord({ wins: 4, losses: 0, ties: 0 }) === "4-0", "record 4-0");
  assert(formatTournamentRecord({ wins: 2, losses: 2, ties: 0 }) === "2-2", "record 2-2");
  assert(formatTournamentRecord({ wins: 2, losses: 1, ties: 1 }) === "2-1-1", "record with ties");

  const pairingsPayload = JSON.stringify([
    {
      name: "Alice [US]",
      record: { wins: 1, losses: 0, ties: 0 },
      rounds: {
        "1": { name: "Bob [US]", result: "W", table: 3 }
      }
    },
    {
      name: "Bob [US]",
      record: { wins: 0, losses: 1, ties: 0 },
      rounds: {
        "1": { name: "Alice [US]", result: "L", table: 3 }
      }
    }
  ]);

  assert(resolveCurrentRound(9, 8) === 9, "html round ahead of json");
  assert(resolveCurrentRound(8, 9) === 9, "json round ahead of html");
  assert(resolveCurrentRound(null, 4) === 4, "json-only round");

  const liveRoundPayload = JSON.stringify([
    {
      name: "Top [US]",
      rounds: {
        "8": { name: "Rival [US]", result: "W", table: 1 },
        "9": { name: "Other [US]", result: null, table: 2 }
      }
    },
    {
      name: "Rival [US]",
      rounds: {
        "8": { name: "Top [US]", result: "L", table: 1 }
      }
    }
  ]);
  assert(parsePairingsPayload(liveRoundPayload).currentRound === 9, "pending round 9 detected");

  const parsedRound = parsePairingsPayload(pairingsPayload);
  assert(parsedRound.pairings.length === 1, "pairings dedupe");
  assert(parsedRound.pairings[0].result === "W", "pairings keep W/L result");
  assert(parsedRound.pairings[0].isPending === false, "finished match not pending");
  assert(parsedRound.pairings[0].playerA.tournamentRecord === "1-0", "player A tournament record");
  assert(parsedRound.pairings[0].playerB?.tournamentRecord === "0-1", "player B tournament record");


  const cpHtml = `<tr><td>1</td><td><div class="player">Dylan Matthews</div></td><td><div class="country">USA</div></td><td class="point"><div class="cp">1332</div><div class="pp">30</div></td></tr>`;
  const fromHtml = parseChampionshipPointsPayload(cpHtml);
  assert(fromHtml.length === 1 && fromHtml[0].championshipPoints === 1332, "cp html uses .cp not .pp");

  results.push("all smoke tests passed");
  return results;
}
