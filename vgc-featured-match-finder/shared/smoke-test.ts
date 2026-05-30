import { matchPlayerToChampionshipPoints } from "./match-player";
import { normalizePlayerName } from "./normalize-player-name";
import { parseChampionshipPointsPayload, parsePairingsPayload } from "./parsing";
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
      championshipPoints: 800,
      championshipPointsMatch: { status: "exact", leaderboardDisplayName: "A" }
    },
    playerB: {
      displayName: "B",
      normalizedName: "b",
      country: "US",
      championshipPoints: null,
      championshipPointsMatch: { status: "not-found" }
    },
    result: null,
    isPending: true,
    isBye: false
  };

  const scored = scorePairing(pairing);
  assert(scored.importanceScore === 0, "missing cp score");
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

  const pairingsPayload = JSON.stringify([
    {
      name: "Alice [US]",
      rounds: {
        "1": { name: "Bob [US]", result: "W", table: 3 }
      }
    },
    {
      name: "Bob [US]",
      rounds: {
        "1": { name: "Alice [US]", result: "L", table: 3 }
      }
    }
  ]);

  const parsedRound = parsePairingsPayload(pairingsPayload);
  assert(parsedRound.pairings.length === 1, "pairings dedupe");


  const cpHtml = `<tr><td>1</td><td><div class="player">Dylan Matthews</div></td><td><div class="country">USA</div></td><td class="point"><div class="cp">1332</div><div class="pp">30</div></td></tr>`;
  const fromHtml = parseChampionshipPointsPayload(cpHtml);
  assert(fromHtml.length === 1 && fromHtml[0].championshipPoints === 1332, "cp html uses .cp not .pp");

  results.push("all smoke tests passed");
  return results;
}
