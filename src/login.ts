import { chromium, Page } from "playwright";
import { buildAppUrl, config } from "./config";
import { ROUTES, SELECTORS, TIMEOUTS } from "./constants";

async function loginIntoPage(page: Page): Promise<void> {
  await page.goto(buildAppUrl(ROUTES.signIn), { waitUntil: "domcontentloaded" });

  await page.waitForSelector(SELECTORS.loginForm);
  await page.waitForSelector(SELECTORS.loginEmail);
  await page.waitForSelector(SELECTORS.loginPassword);

  await page.fill(SELECTORS.loginEmail, config.email);
  await page.fill(SELECTORS.loginPassword, config.password);
  await page.click(SELECTORS.loginButton);
  await page.waitForURL(`**${ROUTES.works}`, { timeout: TIMEOUTS.login });
}

export async function performLogin(): Promise<Page> {
  const browser = await chromium.launch({ headless: config.browserHeadless });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();

  await loginIntoPage(page);

  console.log("Login realizado com sucesso.");
  console.log("URL:", page.url());

  return page;
}

export async function isAuthenticationRequired(page: Page): Promise<boolean> {
  if (page.url().includes(ROUTES.signIn)) {
    return true;
  }

  try {
    return await page.locator(SELECTORS.loginForm).isVisible();
  } catch {
    return false;
  }
}

export async function ensureAuthenticatedPage(
  page: Page,
  targetUrl?: string
): Promise<Page> {
  if (targetUrl) {
    await page.goto(targetUrl, { waitUntil: "networkidle" });
  }

  if (await isAuthenticationRequired(page)) {
    console.warn("Sessao expirada detectada. Reautenticando...");
    await loginIntoPage(page);
    if (targetUrl) {
      await page.goto(targetUrl, { waitUntil: "networkidle" });
    }
  }

  return page;
}

export async function closeBrowser(page: Page): Promise<void> {
  await page.context().browser()?.close();
}
