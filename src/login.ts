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

function isRecoverablePageError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);

  return /page crashed|target page, context or browser has been closed|has been closed/i.test(
    message
  );
}

async function recyclePage(page: Page): Promise<Page> {
  const context = page.context();

  await page.close().catch(() => undefined);

  return context.newPage();
}

export async function performLogin(): Promise<Page> {
  const browser = await chromium.launch({ headless: config.browserHeadless });
  const context = await browser.newContext({ acceptDownloads: true });
  context.setDefaultNavigationTimeout(TIMEOUTS.navigation);
  context.setDefaultTimeout(TIMEOUTS.navigation);
  await context.route("**/*", async (route) => {
    const resourceType = route.request().resourceType();
    if (resourceType === "image" || resourceType === "media" || resourceType === "font") {
      await route.abort();
      return;
    }

    await route.continue();
  });
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
  let activePage = page;

  try {
    if (targetUrl) {
      await activePage.goto(targetUrl, { waitUntil: "domcontentloaded" });
    }

    if (await isAuthenticationRequired(activePage)) {
      console.warn("Sessao expirada detectada. Reautenticando...");
      await loginIntoPage(activePage);
      if (targetUrl) {
        await activePage.goto(targetUrl, { waitUntil: "domcontentloaded" });
      }
    }

    return activePage;
  } catch (error) {
    if (!isRecoverablePageError(error)) {
      throw error;
    }

    const browser = activePage.context().browser();
    if (!browser?.isConnected()) {
      throw error;
    }

    console.warn(
      "Pagina do Chromium foi encerrada ou crashou. Reciclando a aba autenticada."
    );

    activePage = await recyclePage(activePage);
    await loginIntoPage(activePage);

    if (targetUrl) {
      await activePage.goto(targetUrl, { waitUntil: "domcontentloaded" });
    }

    return activePage;
  }
}

export async function closeBrowser(page: Page | null | undefined): Promise<void> {
  if (!page) {
    return;
  }

  const context = page.context();
  const browser = context.browser();

  if (browser) {
    await browser.close().catch(() => undefined);
    return;
  }

  await context.close().catch(() => undefined);
}
