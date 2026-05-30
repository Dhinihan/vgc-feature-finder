import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const APP_URL =
  process.env.APP_URL ?? "https://vgc-featured-match-finder.lakebed.app/";
const EVENT_ID = "0000187";
const ARTIFACTS = "/opt/cursor/artifacts/screenshots";

async function main() {
  await mkdir(ARTIFACTS, { recursive: true }).catch(() => {});

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const report = { url: APP_URL, steps: [], errors: [] };

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
    await page.waitForTimeout(3000);
    report.steps.push("configured event");

    await page.screenshot({ path: join(ARTIFACTS, "02-event-configured.png"), fullPage: true });

    const eventText = await page.locator("body").innerText();
    report.hasIndianapolis = /Indianapolis|0000187/i.test(eventText);

    await page.getByRole("button", { name: /^Atualizar$/i }).click();
    report.steps.push("clicked refresh");

    await page.waitForTimeout(35_000);

    await page.screenshot({ path: join(ARTIFACTS, "03-after-refresh.png"), fullPage: true });

    const body = await page.locator("body").innerText();
    report.statusMessage = body.match(/Atualização[\s\S]{0,200}/)?.[0] ?? "";
    report.tableRows = await page.locator("table tbody tr").count();
    report.hasScore = /Score|completo|CP ausente/i.test(body);
    report.hasPairingsTable = report.tableRows > 0;
    report.statsSnippet = body.match(/Partidas[\s\S]{0,80}/)?.[0] ?? "";

    if (!report.hasPairingsTable) {
      report.errors.push("no table rows after refresh");
    }
  } catch (error) {
    report.errors.push(error instanceof Error ? error.message : String(error));
  } finally {
    await browser.close();
  }

  report.ok = report.errors.length === 0 && report.hasPairingsTable;
  await writeFile(
    join(ARTIFACTS, "validation-report.json"),
    JSON.stringify(report, null, 2)
  );
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}

main();
