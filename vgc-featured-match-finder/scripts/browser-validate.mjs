import { chromium } from "playwright";

const DEPLOY_URL = process.env.DEPLOY_URL ?? "https://quiet-harbor-1973a2.lakebed.app";
const LOCAL_URL = process.env.LOCAL_URL ?? "http://localhost:3000/?lakebed_guest=vinicius";
const EVENT_ID = "0000187";

async function validateDeployed(page) {
  await page.goto(DEPLOY_URL, { waitUntil: "networkidle", timeout: 60_000 });
  const title = await page.locator("h1").first().textContent();
  const body = await page.locator("body").innerText();
  return {
    url: DEPLOY_URL,
    h1: title?.trim() ?? "",
    hasClaimRequired: /claim required/i.test(body),
    hasVgcApp: /Featured Match Finder/i.test(body)
  };
}

async function validateLocal(page) {
  await page.goto(LOCAL_URL, { waitUntil: "networkidle", timeout: 60_000 });
  await page.waitForSelector("h1", { timeout: 30_000 });

  await page.getByPlaceholder(/0000160|standingsVGC/i).fill(EVENT_ID);
  await page.getByRole("button", { name: /Salvar evento/i }).click();
  await page.waitForTimeout(1500);

  await page.getByRole("button", { name: /^Atualizar$/i }).click();
  await page.waitForTimeout(20_000);

  const body = await page.locator("body").innerText();
  const tableRows = await page.locator("table tbody tr").count();
  const eventTitle = await page.locator("text=Evento ativo").locator("..").innerText();

  return {
    url: LOCAL_URL,
    eventId: EVENT_ID,
    eventTitleSnippet: eventTitle.slice(0, 200),
    hasIndianapolis: /Indianapolis|0000187/i.test(body),
    tableRows,
    hasScoreColumn: /Score|completo|CP ausente/i.test(body),
    statusSnippet: body.match(/Atualização concluída[\s\S]{0,120}/)?.[0] ?? ""
  };
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

try {
  const deployed = await validateDeployed(page);
  const local = await validateLocal(page);
  console.log(JSON.stringify({ deployed, local }, null, 2));
} finally {
  await browser.close();
}
