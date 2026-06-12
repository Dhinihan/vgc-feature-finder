import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const APP_URL =
  process.env.APP_URL ?? "https://vgc-featured-match-finder.lakebed.app/";
const EVENT_ID = "0000190";
const CONFIGURE_TIMEOUT_MS = 90_000;
const REFRESH_TIMEOUT_MS = 180_000;
const ARTIFACTS = process.env.ARTIFACTS ?? "/tmp/naic-validation";

async function main() {
  await mkdir(ARTIFACTS, { recursive: true }).catch(() => {});

  const chromePath =
    process.env.CHROME_PATH ??
    `${process.env.HOME}/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome`;
  const browser = await chromium.launch({
    headless: true,
    executablePath: chromePath
  });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const report = { url: APP_URL, steps: [], errors: [], consoleErrors: [] };
  page.on("console", (msg) => {
    if (msg.type() === "error") report.consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => report.consoleErrors.push(err.message));

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

    await page.getByPlaceholder(/0000190|standingsVGC/i).fill(EVENT_ID);
    await page.getByRole("button", { name: /Salvar evento/i }).click();
    await page.waitForTimeout(CONFIGURE_TIMEOUT_MS);
    report.steps.push("configured event");

    await page.screenshot({ path: join(ARTIFACTS, "02-event-configured.png"), fullPage: true });

    const eventText = await page.locator("body").innerText();
    report.hasNaic = /North America|0000190/i.test(eventText);
    if (!report.hasNaic) {
      report.errors.push("event title/id not visible after configure");
    }

    const refreshBtn = page.getByRole("button", { name: /Atualizar partidas/i });
    if (await refreshBtn.isEnabled()) {
      await refreshBtn.click();
      report.steps.push("clicked refresh");

      const updatingBtn = page.getByRole("button", { name: /Atualizando/i });
      const loadingStatus = page.getByText(/Buscando partidas no PokéData/i);
      const sawLoading =
        (await updatingBtn.isVisible({ timeout: 5_000 }).catch(() => false)) ||
        (await loadingStatus.isVisible({ timeout: 5_000 }).catch(() => false));
      report.sawRefreshLoadingIndicator = sawLoading;
      if (!sawLoading) {
        report.errors.push("no loading indicator after clicking Atualizar partidas");
      }

      await refreshBtn.waitFor({ state: "enabled", timeout: REFRESH_TIMEOUT_MS }).catch(() => {});
      await page.waitForTimeout(2_000);
    } else {
      report.steps.push("skipped refresh (button disabled)");
    }

    await page.screenshot({ path: join(ARTIFACTS, "03-after-refresh.png"), fullPage: true });

    const body = await page.locator("body").innerText();
    report.statusMessage =
      body.match(/Atualização concluída[^\n]*/)?.[0] ??
      body.match(/Atualização[\s\S]{0,200}/)?.[0] ??
      "";

    report.eventTitle =
      (await page.locator("text=Evento ativo").locator("..").locator(".text-lg").textContent())?.trim() ??
      "";
    report.roundNumber =
      (
        await page
          .locator("div")
          .filter({ has: page.locator("p", { hasText: "Rodada atual" }) })
          .locator("p.text-3xl")
          .textContent()
      )?.trim() ?? null;

    const statCards = page.locator("section").filter({ hasText: "Pendentes" }).locator(".text-2xl");
    const statValues = await statCards.allTextContents();
    const statusPairings =
      report.statusMessage.match(/,\s*([\d.,]+)\s+partidas/i) ??
      report.statusMessage.match(/([\d.,]+)\s+partidas/i);
    report.pendingPairings = statValues[1] ? Number(statValues[1].replace(/\D/g, "")) : 0;

    const cpMatch = body.match(/CP no banco:\s*([\d.,]+)\s*jogadores/i);
    report.cpMetaCount = cpMatch ? Number(cpMatch[1].replace(/\D/g, "")) : 0;

    const pairingsSection = page.locator("section").filter({ hasText: "Partidas em destaque" });

    await page.getByRole("button", { name: "Todas" }).click();
    await page.waitForTimeout(500);
    const allBody = await page.locator("body").innerText();
    report.tableRowsAll = await pairingsSection.locator("table tbody tr").count();
    report.allShowing = allBody.match(/Mostrando (\d+) de (\d+) partidas/);
    report.totalPairings = statusPairings
      ? Number(statusPairings[1].replace(/\D/g, ""))
      : report.allShowing
        ? Number(report.allShowing[2])
        : statValues[0]
          ? Number(statValues[0].replace(/\D/g, ""))
          : report.tableRowsAll;

    await page.getByRole("button", { name: "Top 25" }).click();
    await page.waitForTimeout(500);
    report.tableRows = await pairingsSection.locator("table tbody tr").count();
    const top25Body = await page.locator("body").innerText();
    const top25Showing = top25Body.match(/Mostrando (\d+) de (\d+) partidas/);
    report.top25Filter = top25Showing
      ? { shown: Number(top25Showing[1]), total: Number(top25Showing[2]) }
      : null;
    report.top25Works =
      report.tableRows > 0 && report.tableRows <= 25 && (report.top25Filter?.shown ?? 0) <= 25;

    await page.screenshot({ path: join(ARTIFACTS, "04-top25-filter.png"), fullPage: true });

    report.hasScore = /Relevância|CP ausente|CP não encontrado|\d[\d,]*\s*CP/i.test(top25Body);
    report.hasPairingsTable = report.tableRowsAll > 0 || report.tableRows > 0;
    report.statsSnippet = body.match(/Partidas[\s\S]{0,80}/)?.[0] ?? "";

    if (report.totalPairings < 500) {
      report.errors.push(`expected 500+ pairings, got ${report.totalPairings}`);
    }
    if (!report.top25Works) {
      report.errors.push("top25 filter did not limit pairings as expected");
    }
    if (!report.hasPairingsTable) {
      report.errors.push("no pairings table rows after refresh");
    }
  } catch (error) {
    report.errors.push(error instanceof Error ? error.message : String(error));
  } finally {
    await browser.close();
  }

  report.ok =
    report.errors.length === 0 && report.hasPairingsTable && report.totalPairings >= 500;
  await writeFile(
    join(ARTIFACTS, "validation-report.json"),
    JSON.stringify(report, null, 2)
  );
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}

main();
