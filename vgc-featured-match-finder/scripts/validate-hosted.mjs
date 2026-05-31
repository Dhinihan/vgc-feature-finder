import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const APP_URL =
  process.env.APP_URL ?? "https://vgc-featured-match-finder.lakebed.app/";
const EVENT_ID = process.env.EVENT_ID ?? "0000187";
const POKE_DATA_PAGE = `https://www.pokedata.ovh/standingsVGC/${EVENT_ID}/masters/`;
const ARTIFACTS = process.env.ARTIFACTS_DIR ?? "/opt/cursor/artifacts/screenshots";

async function fetchExpectedRound() {
  const response = await fetch(POKE_DATA_PAGE);
  if (!response.ok) {
    throw new Error(`PokéData HTTP ${response.status}`);
  }
  const html = await response.text();
  const match = html.match(/Round\s+(\d+)\s*\/\s*(\d+)/i);
  if (!match) {
    throw new Error("could not parse Round N/M from PokéData HTML");
  }
  return {
    current: Number.parseInt(match[1], 10),
    total: Number.parseInt(match[2], 10)
  };
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
  const match = body.match(/Atualização concluída\.\s*Rodada\s+(\d+)/i);
  return match ? Number.parseInt(match[1], 10) : null;
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

    const roundAfterConfigure = await waitForRound(page, expected.current, 30_000);
    report.roundAfterConfigure = roundAfterConfigure;

    if (roundAfterConfigure !== expected.current) {
      report.errors.push(
        `after configure: UI shows rodada ${roundAfterConfigure}, PokéData is ${expected.current}`
      );
    }

    await page.screenshot({ path: join(ARTIFACTS, "02-event-configured.png"), fullPage: true });

    const refreshBtn = page.getByRole("button", { name: /^Atualizar partidas$/ });
    if (!(await refreshBtn.isEnabled())) {
      report.errors.push("Atualizar partidas disabled after configure");
    } else {
      await refreshBtn.click();
      report.steps.push("clicked refresh");

      const updatingBtn = page.getByRole("button", { name: /Atualizando/i });
      const loadingStatus = page.getByText(/Buscando partidas no PokéData/i);
      report.sawRefreshLoadingIndicator =
        (await updatingBtn.isVisible({ timeout: 5_000 }).catch(() => false)) ||
        (await loadingStatus.isVisible({ timeout: 5_000 }).catch(() => false));

      if (!report.sawRefreshLoadingIndicator) {
        report.errors.push("no loading indicator after clicking Atualizar partidas");
      }

      await page.waitForFunction(
        () => {
          const buttons = Array.from(document.querySelectorAll("button"));
          return buttons.some(
            (button) =>
              button.textContent?.trim() === "Atualizar partidas" && !button.disabled
          );
        },
        null,
        { timeout: 180_000 }
      );
      await page.waitForTimeout(1_500);
    }

    const roundAfterRefresh = await waitForRound(page, expected.current, 30_000);
    report.roundAfterRefresh = roundAfterRefresh;
    report.statusRound = await readStatusRound(page);
    report.partidasStat = await readPartidasStat(page);
    report.featuredPairingsRows = await readFeaturedPairingsRowCount(page);
    report.tableRows = report.featuredPairingsRows;
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

    await page.screenshot({ path: join(ARTIFACTS, "03-after-refresh.png"), fullPage: true });

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("text=VGC Featured Match Finder", { timeout: 60_000 });
    await page.waitForTimeout(2_000);

    const roundAfterReload = await readDisplayedRound(page);
    report.roundAfterReload = roundAfterReload;
    report.steps.push("reloaded page");

    if (roundAfterReload !== expected.current) {
      report.errors.push(
        `after reload: UI shows rodada ${roundAfterReload}, PokéData is ${expected.current}`
      );
    }

    const refreshOnlyBtn = page.getByRole("button", { name: /^Atualizar partidas$/ });
    if (await refreshOnlyBtn.isEnabled()) {
      await refreshOnlyBtn.click();
      await page.waitForFunction(
        () => {
          const buttons = Array.from(document.querySelectorAll("button"));
          return buttons.some(
            (button) =>
              button.textContent?.trim() === "Atualizar partidas" && !button.disabled
          );
        },
        null,
        { timeout: 180_000 }
      );
      const roundRefreshOnly = await waitForRound(page, expected.current, 30_000);
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
    report.roundAfterRefresh === expected.current &&
    report.hasPairingsTable;

  await writeFile(join(ARTIFACTS, "validation-report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}

main();
