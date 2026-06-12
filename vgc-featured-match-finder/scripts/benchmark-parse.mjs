#!/usr/bin/env node
/**
 * Benchmark parseStandingsOnce against live NAIC 0000190 standings JSON.
 *
 * Usage: npx tsx scripts/benchmark-parse.mjs
 */
import { execFileSync } from "node:child_process";
import { divisionJsonFileName, parseStandingsOnce } from "../shared/parsing.ts";

const EVENT_ID = "0000190";
const DIVISION = "masters";
const EXPECTED_PAIRINGS = 542;

function standingsJsonUrl(externalEventId, division) {
  const divisionFile = divisionJsonFileName(division);
  return `https://www.pokedata.ovh/standingsVGC/${externalEventId}/${division}/${externalEventId}_${divisionFile}.json`;
}

async function fetchPayload(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return await res.text();
  } catch (error) {
    console.warn(`fetch failed (${error instanceof Error ? error.message : error}); trying curl...`);
    return execFileSync("curl", ["-fsSL", url], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  }
}

async function main() {
  const url = standingsJsonUrl(EVENT_ID, DIVISION);
  console.log(`Fetching ${url} ...`);

  const payload = await fetchPayload(url);
  console.log(`Payload: ${payload.length.toLocaleString()} bytes`);

  const start = performance.now();
  const parsed = parseStandingsOnce(payload);
  const elapsedMs = performance.now() - start;

  console.log(`parseStandingsOnce: ${elapsedMs.toFixed(2)} ms`);
  console.log(`currentRound: ${parsed.currentRound}`);
  console.log(`pairings: ${parsed.pairings.length}`);
  console.log(`standings rows: ${parsed.standings.length}`);

  if (parsed.currentRound < 1) {
    throw new Error(`expected currentRound >= 1, got ${parsed.currentRound}`);
  }

  if (parsed.pairings.length !== EXPECTED_PAIRINGS) {
    throw new Error(
      `expected ${EXPECTED_PAIRINGS} pairings, got ${parsed.pairings.length} (update EXPECTED_PAIRINGS if event progressed)`
    );
  }

  console.log("benchmark ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
