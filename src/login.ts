import { chromium, Page } from "playwright";
import { config } from "./config";
import { goToReports } from "./reports";
import { closeOnboardingPopup } from "./helpers/closePopup";

/** Realiza o login na aplicação e retorna a página autenticada.
 * @returns Playwright Page autenticada
 */
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

/**
 * Reinicia a sessão do usuário realizando logout e login novamente.
 * @param currentPage Página atual do Playwright
 * @param currentPageNumber Número da página atual (base 1) para logs
 * @returns Página autenticada após o login
 */
export async function safeSessionReset(
  currentPage: Page,
  currentPageNumber: number
): Promise<Page> {
  console.log("\n🔄 Reiniciando sessão (logout + login)...");

  try {
    // tenta clicar em sair
    await currentPage.click("#logout-button"); // confirme o seletor real depois
  } catch {
    console.warn(
      "⚠️ Não foi possível clicar em logout — talvez já estivesse desconectado."
    );
  }

  await new Promise((res) => setTimeout(res, 1500));

  const page = await performLogin();
  await closeOnboardingPopup(page);

  await goToReports(page);

  // volta para a página anterior
  await page.goto(
    `https://app.produttivo.com.br/form_fills?page=${currentPageNumber}`
  );

  await closeOnboardingPopup(page);

  console.log("✅ Sessão restabelecida com sucesso!");

  return page;
}
