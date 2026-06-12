#!/usr/bin/env node
/**
 * Compare NAIC event players vs global PokéData CP leaderboard.
 * Usage: node scripts/analyze-cp-coverage.mjs --event-id=0000190
 */
import { readFileSync, writeFileSync } from "node:fs";
import { parseChampionshipPointsPayload, parseStandingsOnce } from "../shared/parsing.ts";
import { normalizePlayerName } from "../shared/normalize-player-name.ts";
import { createLeaderboardIndex, matchPlayerWithLeaderboardIndex } from "../shared/leaderboard-index.ts";

const eventId = process.argv.find((a) => a.startsWith("--event-id="))?.split("=")[1] ?? "0000190";
const division = "masters";
const REGIONS = ["NA", "EU", "LA", "AP", "SO", "RU"];

function standingsUrl(id, div) {
  const label = div === "juniors" ? "Juniors" : div === "seniors" ? "Seniors" : "Masters";
  return `https://www.pokedata.ovh/standingsVGC/${id}/${div}/${id}_${label}.json`;
}

async function fetchCpRegion(region) {
  const res = await fetch("https://www.pokedata.ovh/2026/", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `type=VG&region=${encodeURIComponent(region)}&division=Masters`
  });
  if (!res.ok) throw new Error(`CP ${region}: HTTP ${res.status}`);
  return res.text();
}

function extractEventPlayers(jsonBody) {
  const standings = JSON.parse(jsonBody);
  const players = new Map();
  for (const row of standings) {
    const raw = String(row.name ?? "").trim();
    if (!raw) continue;
    const bracket = raw.match(/^(.+?)\s*\[([A-Za-z]{2,3})\]\s*$/);
    const display = bracket ? bracket[1].trim() : raw;
    const country = bracket ? bracket[2].toUpperCase() : "";
    const key = normalizePlayerName(display);
    if (!players.has(key)) players.set(key, { display, country, raw });
  }
  return players;
}

async function main() {
  console.log(`Fetching standings ${eventId}...`);
  const standingsRes = await fetch(standingsUrl(eventId, division));
  const jsonBody = await standingsRes.text();
  writeFileSync("/tmp/naic-standings.json", jsonBody);

  const { pairings, currentRound } = parseStandingsOnce(jsonBody);
  const eventPlayers = extractEventPlayers(jsonBody);

  console.log("Fetching global CP (6 regions)...");
  const allCp = [];
  for (const region of REGIONS) {
    const html = await fetchCpRegion(region);
    const parsed = parseChampionshipPointsPayload(html);
    console.log(`  ${region}: ${parsed.length} players`);
    allCp.push(...parsed);
  }

  const deduped = new Map();
  for (const p of allCp) {
    const k = `${p.normalizedName}|${p.country || "*"}`;
    const ex = deduped.get(k);
    if (!ex || p.championshipPoints > ex.championshipPoints) deduped.set(k, p);
  }
  const globalCp = [...deduped.values()];
  const index = createLeaderboardIndex(globalCp);

  const stats = { exact: 0, normalized: 0, ambiguous: 0, notFound: 0 };
  const notFound = [];
  const matched = [];

  for (const [, player] of eventPlayers) {
    const result = matchPlayerWithLeaderboardIndex(player.display, player.country, index, []);
    const status = result.match.status;
    if (status === "exact" || status === "normalized-name" || status === "manual-override") {
      stats[status === "exact" ? "exact" : "normalized"]++;
      matched.push({ ...player, cp: result.championshipPoints, status });
    } else if (status === "ambiguous") {
      stats.ambiguous++;
    } else {
      stats.notFound++;
      if (notFound.length < 20) notFound.push(player);
    }
  }

  const eventCpFiltered = globalCp.filter((p) => eventPlayers.has(p.normalizedName));

  const report = {
    eventId,
    division,
    round: currentRound,
    pairings: pairings.length,
    uniqueEventPlayers: eventPlayers.size,
    globalCpPlayers: globalCp.length,
    eventPlayersWithAnyCpInGlobal: eventCpFiltered.length,
    eventPlayersWithAnyCpRate: `${((eventCpFiltered.length / eventPlayers.size) * 100).toFixed(1)}%`,
    matchAfterNameLogic: stats,
    matchRate: `${(((stats.exact + stats.normalized) / eventPlayers.size) * 100).toFixed(1)}%`,
    notFoundRate: `${((stats.notFound / eventPlayers.size) * 100).toFixed(1)}%`,
    partialSyncWouldImport: eventCpFiltered.length,
    notFoundSamples: notFound.slice(0, 15),
    topMatchedSamples: matched
      .sort((a, b) => (b.cp ?? 0) - (a.cp ?? 0))
      .slice(0, 5)
      .map((p) => ({ name: p.raw, cp: p.cp }))
  };

  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
