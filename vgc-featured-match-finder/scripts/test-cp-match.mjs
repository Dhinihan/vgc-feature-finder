import { readFileSync, writeFileSync } from "node:fs";
import { parseChampionshipPointsPayload, parsePlayerLabel } from "../shared/parsing.ts";
import { matchPlayerToChampionshipPoints } from "../shared/match-player.ts";

const standings = JSON.parse(readFileSync("/tmp/standings.json", "utf8"));

const res = await fetch("https://www.pokedata.ovh/2026/", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: "type=VG&region=NA&division=Masters"
});
const html = await res.text();
const leaderboard = parseChampionshipPointsPayload(html);
console.log("leaderboard size", leaderboard.length);

let matched = 0, notFound = 0, ambiguous = 0;
const misses = [];

for (const row of standings) {
  const label = parsePlayerLabel(String(row.name ?? ""));
  const result = matchPlayerToChampionshipPoints(label.displayName, label.country, leaderboard, []);
  if (result.match.status === "not-found") {
    notFound++;
    if (misses.length < 15) misses.push(row.name);
  } else if (result.match.status === "ambiguous") ambiguous++;
  else matched++;
}

console.log({ tournamentPlayers: standings.length, matched, notFound, ambiguous });
console.log("matchRate", ((matched / standings.length) * 100).toFixed(1) + "%");
console.log("misses", misses);
