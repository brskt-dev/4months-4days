import { chromium, Page } from "playwright";
import { config } from "./config";

export async function performLogin(): Promise<Page> {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();

  await page.goto(`${config.baseUrl}/auth/sign_in`);

  await page.waitForSelector("form#sign_in");
  await page.waitForSelector('input[name="user[email]"]');
  await page.waitForSelector('input[name="user[password]"]');

  await page.fill('input[name="user[email]"]', config.email);
  await page.fill('input[name="user[password]"]', config.password);

  // clique sem waitForNavigation
  await page.waitForSelector("input.login-button");
  await page.click("input.login-button");

  // aqui sim esperamos a URL correta
  await page.waitForURL("**/works", { timeout: 20000 });

  console.log("✅ Login realizado com sucesso!");
  console.log("📄 URL:", page.url());

  return page;
}
