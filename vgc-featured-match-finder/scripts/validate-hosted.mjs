import { chromium } from "playwright";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const APP_URL =
  process.env.APP_URL ?? "https://vgc-featured-match-finder.lakebed.app/";
const EVENT_ID = process.env.EVENT_ID ?? "0000187";
const POKE_DATA_PAGE = `https://www.pokedata.ovh/standingsVGC/${EVENT_ID}/masters/`;
const ARTIFACTS = process.env.ARTIFACTS_DIR ?? "/opt/cursor/artifacts/screenshots";

function parseRoundFromHtml(html) {
  const match = html.match(/Round\s+(\d+)\s*\/\s*(\d+)/i);
  if (!match) {
    throw new Error("could not parse Round N/M from PokéData HTML");
  }
  return {
    current: Number.parseInt(match[1], 10),
    total: Number.parseInt(match[2], 10)
  };
}

async function fetchExpectedRound() {
  const envRound = Number.parseInt(process.env.EXPECTED_ROUND ?? "", 10);
  if (!Number.isNaN(envRound) && envRound > 0) {
    return { current: envRound, total: 12 };
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(POKE_DATA_PAGE, {
        signal: AbortSignal.timeout(90_000)
      });
      if (!response.ok) {
        throw new Error(`PokéData HTTP ${response.status}`);
      }
      return parseRoundFromHtml(await response.text());
    } catch (error) {
      if (attempt === 2) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 4_000 * (attempt + 1)));
    }
  }

  const { stdout } = await execFileAsync(
    "curl",
    ["-s", "--max-time", "90", POKE_DATA_PAGE],
    { maxBuffer: 10 * 1024 * 1024 }
  );
  return parseRoundFromHtml(stdout);
}

async function readDisplayedRound(page) {
  const value = await page
    .locator("text=Rodada atual")
    .locator("..")
    .locator("p.text-3xl")
    .first()
    .textContent();
  const parsed = Number.parseInt(String(value ?? "").trim(), 10);
  return Number.isNaN(parsed) ? null : parsed;
}

async function readStatusRound(page) {
  const body = await page.locator("body").innerText();
  const match = body.match(
    /(?:Atualização concluída|Evento configurado)\.\s*Rodada\s+(\d+)/i
  );
  return match ? Number.parseInt(match[1], 10) : null;
}

async function readTournamentRecordBadgeCount(page) {
  const badges = await page.locator("span.rounded.bg-slate-800").allTextContents();
  return badges.filter((text) => /^\d+-\d+(-\d+)?$/.test(text.trim())).length;
}

async function waitForRefreshButtonReady(page, timeoutMs) {
  await page.waitForFunction(
    () => {
      const buttons = Array.from(document.querySelectorAll("button"));
      return buttons.some(
        (button) => button.textContent?.trim() === "Atualizar partidas" && !button.disabled
      );
    },
    null,
    { timeout: timeoutMs }
  );
}

async function waitForPartidasStat(page, minCount, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const count = await readPartidasStat(page);
    if (count !== null && count >= minCount) {
      return count;
    }
    await page.waitForTimeout(2_000);
  }
  return readPartidasStat(page);
}

async function readPartidasStat(page) {
  const label = page.locator("p.text-xs.uppercase", { hasText: /^Partidas$/ });
  const value = await label.locator("..").locator("p.text-2xl").first().textContent().catch(() => null);
  const parsed = Number.parseInt(String(value ?? "").trim(), 10);
  return Number.isNaN(parsed) ? null : parsed;
}

async function readFeaturedPairingsRowCount(page) {
  const table = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: /Partidas em destaque/i }) })
    .locator("table tbody tr");
  return table.count();
}

async function waitForRound(page, expectedRound, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const round = await readDisplayedRound(page);
    if (round === expectedRound) {
      return round;
    }
    await page.waitForTimeout(2_000);
  }
  return readDisplayedRound(page);
}

async function main() {
  await mkdir(ARTIFACTS, { recursive: true }).catch(() => {});

  const expected = await fetchExpectedRound();
  const report = {
    url: APP_URL,
    eventId: EVENT_ID,
    pokeDataRound: expected,
    steps: [],
    errors: []
  };

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

  try {
    await page.goto(APP_URL, { waitUntil: "domcontentloaded", timeout: 90_000 });
    await page.waitForSelector("text=VGC Featured Match Finder", { timeout: 60_000 });
    report.steps.push("loaded home");

    const title = await page.getByRole("heading", { name: /Featured Match Finder/i }).textContent();
    report.title = title?.trim() ?? "";
    if (!/Featured Match Finder/i.test(report.title)) {
      report.errors.push(`unexpected title: ${report.title}`);
    }

    const claimWall = await page.getByText(/claim required/i).count();
    if (claimWall > 0) {
      report.errors.push("still showing claim required screen");
    }

    await page.screenshot({ path: join(ARTIFACTS, "01-home.png"), fullPage: true });

    await page.getByPlaceholder(/0000160|standingsVGC/i).fill(EVENT_ID);
    await page.getByRole("button", { name: /Salvar evento/i }).click();
    report.steps.push("configured event");

    report.sawAutoImportIndicator = await page
      .getByText(/Configurando evento|Baixando standings|Importando partidas|Sincronizando partidas/i)
      .first()
      .isVisible({ timeout: 10_000 })
      .catch(() => false);

    await waitForRefreshButtonReady(page, 360_000);
    report.steps.push("import finished after configure");

    const roundAfterConfigure = await waitForRound(page, expected.current, 30_000);
    report.roundAfterConfigure = roundAfterConfigure;
    report.partidasAfterConfigure = await waitForPartidasStat(page, 1, 10_000);
    report.recordBadgesAfterConfigure = await readTournamentRecordBadgeCount(page);

    if (roundAfterConfigure !== expected.current) {
      report.errors.push(
        `after configure: UI shows rodada ${roundAfterConfigure}, PokéData is ${expected.current}`
      );
    }

    if (report.partidasAfterConfigure !== null && report.partidasAfterConfigure < 1) {
      report.errors.push("Partidas stat is zero after configure/import");
    }

    if (report.recordBadgesAfterConfigure < 4) {
      report.errors.push(
        `expected tournament record badges after configure, got ${report.recordBadgesAfterConfigure}`
      );
    }

    const statusAfterConfigure = await page.locator("[role='status']").innerText().catch(() => "");
    if (/Source runtime exceeded|runtime exceeded/i.test(statusAfterConfigure)) {
      report.errors.push("Lakebed runtime error visible after configure");
    }

    await page.screenshot({ path: join(ARTIFACTS, "02-event-configured.png"), fullPage: true });

    const refreshBtn = page.getByRole("button", { name: /^Atualizar partidas$/ });
    if (!(await refreshBtn.isEnabled())) {
      report.errors.push("Atualizar partidas disabled after configure");
    } else {
      await refreshBtn.click();
      report.steps.push("clicked refresh");

      const updatingBtn = page.getByRole("button", { name: /Atualizando/i });
      const loadingStatus = page.getByText(/Buscando partidas no PokéData|Importando partidas/i);
      report.sawRefreshLoadingIndicator =
        (await updatingBtn.isVisible({ timeout: 5_000 }).catch(() => false)) ||
        (await loadingStatus.isVisible({ timeout: 5_000 }).catch(() => false));

      if (!report.sawRefreshLoadingIndicator) {
        report.errors.push("no loading indicator after clicking Atualizar partidas");
      }

      await waitForRefreshButtonReady(page, 360_000);
      await page.waitForTimeout(1_500);
    }

    const roundAfterRefresh = await waitForRound(page, expected.current, 30_000);
    report.roundAfterRefresh = roundAfterRefresh;
    report.statusRound = await readStatusRound(page);
    report.partidasStat = await readPartidasStat(page);
    report.featuredPairingsRows = await readFeaturedPairingsRowCount(page);
    report.tableRows = report.featuredPairingsRows;
    report.recordBadges = await readTournamentRecordBadgeCount(page);
    report.hasScore = /Relevância|completo|CP ausente/i.test(await page.locator("body").innerText());
    report.hasPairingsTable = report.featuredPairingsRows > 1;

    if (roundAfterRefresh !== expected.current) {
      report.errors.push(
        `after refresh: UI shows rodada ${roundAfterRefresh}, PokéData is ${expected.current}`
      );
    }

    if (report.statusRound !== null && report.statusRound !== expected.current) {
      report.errors.push(
        `status message says rodada ${report.statusRound}, PokéData is ${expected.current}`
      );
    }

    if (report.partidasStat !== null && report.partidasStat < 1) {
      report.errors.push("Partidas stat is zero after refresh");
    }

    if (!report.hasPairingsTable) {
      report.errors.push("no table rows after refresh");
    }

    if (report.recordBadges < 4) {
      report.errors.push(`expected tournament record badges, got ${report.recordBadges}`);
    }

    await page.screenshot({ path: join(ARTIFACTS, "03-after-refresh.png"), fullPage: true });

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("text=VGC Featured Match Finder", { timeout: 60_000 });
    await waitForPartidasStat(page, 1, 120_000);

    const roundAfterReload = await readDisplayedRound(page);
    report.roundAfterReload = roundAfterReload;
    report.partidasAfterReload = await readPartidasStat(page);
    report.recordBadgesAfterReload = await readTournamentRecordBadgeCount(page);
    report.steps.push("reloaded page");

    if (roundAfterReload !== expected.current) {
      report.errors.push(
        `after reload: UI shows rodada ${roundAfterReload}, PokéData is ${expected.current}`
      );
    }

    if (report.partidasAfterReload !== null && report.partidasAfterReload < 1) {
      report.errors.push("Partidas stat is zero after reload");
    }

    const refreshOnlyBtn = page.getByRole("button", { name: /^Atualizar partidas$/ });
    if (await refreshOnlyBtn.isEnabled()) {
      await refreshOnlyBtn.click();
      await waitForRefreshButtonReady(page, 360_000);
      const roundRefreshOnly = await waitForRound(page, expected.current, 30_000);
      report.partidasRefreshOnly = await readPartidasStat(page);
      report.roundAfterRefreshOnly = roundRefreshOnly;
      report.steps.push("refresh without reconfigure");

      if (roundRefreshOnly !== expected.current) {
        report.errors.push(
          `refresh-only: UI shows rodada ${roundRefreshOnly}, PokéData is ${expected.current}`
        );
      }
    }
  } catch (error) {
    report.errors.push(error instanceof Error ? error.message : String(error));
  } finally {
    await browser.close();
  }

  report.ok =
    report.errors.length === 0 &&
    report.roundAfterConfigure === expected.current &&
    report.roundAfterRefresh === expected.current &&
    report.hasPairingsTable &&
    (report.partidasStat ?? 0) >= 1 &&
    (report.recordBadges ?? 0) >= 4;

  await writeFile(join(ARTIFACTS, "validation-report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}

main();
