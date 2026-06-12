#!/usr/bin/env node
/**
 * Fetches VG Championship Points from PokéData locally and uploads compact chunks
 * to the hosted Lakebed app via POST /api/cp/import.
 *
 * Usage:
 *   CP_IMPORT_SECRET=... APP_URL=https://vgc-featured-match-finder.lakebed.app node scripts/sync-cp-to-lakebed.mjs
 *   node scripts/sync-cp-to-lakebed.mjs --division masters
 *   node scripts/sync-cp-to-lakebed.mjs --event-id=0000190
 *   node scripts/sync-cp-to-lakebed.mjs --event-id 0000190 --division masters
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  divisionJsonFileName,
  extractStandingsPlayerNames,
  parseChampionshipPointsPayload
} from "../shared/parsing.ts";
import { compactCpPlayers, chunkCompactPlayers } from "../shared/cp-storage.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadEnvSecret() {
  if (process.env.CP_IMPORT_SECRET?.trim()) {
    return process.env.CP_IMPORT_SECRET.trim();
  }
  try {
    const envPath = resolve(__dirname, "../.env.lakebed.server");
    const raw = readFileSync(envPath, "utf8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^CP_IMPORT_SECRET=(.+)$/);
      if (m) {
        return m[1].trim();
      }
    }
  } catch {
    // optional local env file
  }
  return "";
}

const APP_URL = (process.env.APP_URL ?? "https://vgc-featured-match-finder.lakebed.app").replace(/\/$/, "");
const REGIONS = ["NA", "EU", "LA", "AP", "SO", "RU"];
const divisionArg = process.argv.find((arg) => arg.startsWith("--division="));
const division =
  divisionArg?.split("=")[1] ??
  (process.argv.includes("--division")
    ? process.argv[process.argv.indexOf("--division") + 1]
    : "masters");

const eventIdArg = process.argv.find((arg) => arg.startsWith("--event-id="));
const eventId =
  eventIdArg?.split("=")[1] ??
  (process.argv.includes("--event-id")
    ? process.argv[process.argv.indexOf("--event-id") + 1]
    : null);

function divisionLabel(value) {
  const normalized = value.trim().toLowerCase();
  if (normalized === "juniors") return "Juniors";
  if (normalized === "seniors") return "Seniors";
  return "Masters";
}

function standingsJsonUrl(externalEventId, div) {
  const divisionFile = divisionJsonFileName(div);
  return `https://www.pokedata.ovh/standingsVGC/${externalEventId}/${div.toLowerCase()}/${externalEventId}_${divisionFile}.json`;
}

async function fetchRegionHtml(region, divLabel) {
  const res = await fetch("https://www.pokedata.ovh/2026/", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `type=VG&region=${encodeURIComponent(region)}&division=${encodeURIComponent(divLabel)}`
  });
  if (!res.ok) {
    throw new Error(`PokéData ${region}: HTTP ${res.status}`);
  }
  const body = await res.text();
  if (!body.includes("<tr") && !body.includes("player(")) {
    console.warn(`  ${region}: resposta vazia (${body.length} bytes)`);
    return "";
  }
  console.log(`  ${region}: ${body.length.toLocaleString()} bytes`);
  return body;
}

async function fetchEventPlayerNames(externalEventId, div) {
  const url = standingsJsonUrl(externalEventId, div);
  console.log(`Buscando standings do evento ${externalEventId} (${div})...`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Standings ${externalEventId}: HTTP ${res.status}`);
  }
  const jsonBody = await res.text();
  const names = extractStandingsPlayerNames(jsonBody);
  console.log(`  ${names.size.toLocaleString()} jogadores no evento.`);
  return names;
}

async function main() {
  const secret = loadEnvSecret();
  if (!secret) {
    console.error("Defina CP_IMPORT_SECRET no ambiente ou em .env.lakebed.server");
    process.exit(1);
  }

  const divLabel = divisionLabel(division);
  console.log(`Buscando CP VG ${divLabel} em PokéData...`);

  const htmlParts = [];
  for (const region of REGIONS) {
    htmlParts.push(await fetchRegionHtml(region, divLabel));
  }

  const payload = htmlParts.join("\n");
  let players = parseChampionshipPointsPayload(payload);
  console.log(`Parseados ${players.length.toLocaleString()} jogadores (global).`);

  if (eventId) {
    const eventNames = await fetchEventPlayerNames(eventId, division);
    const before = players.length;
    players = players.filter((player) => eventNames.has(player.normalizedName));
    console.log(
      `Filtrado para evento ${eventId}: ${players.length.toLocaleString()} de ${before.toLocaleString()} jogadores.`
    );
  }

  if (players.length === 0) {
    console.error("Nenhum jogador parseado — abortando.");
    process.exit(1);
  }

  const compact = compactCpPlayers(players);
  const maxChunkBytes = eventId ? 80_000 : 55_000;
  const chunks = chunkCompactPlayers(compact, maxChunkBytes);
  console.log(`Enviando ${chunks.length} chunk(s) para ${APP_URL} ...`);

  for (let i = 0; i < chunks.length; i++) {
    const res = await fetch(`${APP_URL}/api/cp/import`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-cp-import-secret": secret
      },
      body: JSON.stringify({
        replace: i === 0,
        chunkIndex: i,
        chunkTotal: chunks.length,
        division,
        players: chunks[i]
      })
    });

    const bodyText = await res.text();
    let body;
    try {
      body = JSON.parse(bodyText);
    } catch {
      body = { raw: bodyText.slice(0, 200) };
    }

    if (!res.ok) {
      console.error(`Chunk ${i + 1}/${chunks.length} falhou:`, res.status, body);
      process.exit(1);
    }

    console.log(
      `  chunk ${i + 1}/${chunks.length}: ${body.rowsInChunk ?? chunks[i].length} jogadores` +
        (body.meta?.playerCount ? ` (total ${body.meta.playerCount})` : "")
    );
  }

  console.log("CP sincronizados com sucesso.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
