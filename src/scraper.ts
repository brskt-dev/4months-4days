import { chromium } from "playwright";

export async function scrapeExample() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  await page.goto("https://example.com");

  const headline = await page.locator("h1").innerText();
  console.log("Headline encontrada:", headline);

  await browser.close();
}

scrapeExample();
