import { chromium, Page } from "playwright";
import { config } from "./config";

export async function performLogin(): Promise<Page> {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();

  // deixamos o goto simples, sem frescura
  await page.goto(`${config.baseUrl}/auth/sign_in`);

  // garante que o form carregou
  await page.waitForSelector('form#sign_in');

  // garante que os inputs existem antes de preencher
  await page.waitForSelector('input[name="user[email]"]');
  await page.waitForSelector('input[name="user[password]"]');

  // Campos do form (isso já estava ok)
  await page.fill('input[name="user[email]"]', config.email);
  await page.fill('input[name="user[password]"]', config.password);

  // 🔹 AQUI é o único ponto que de fato precisava mudar
  // Em vez de button[type="submit"], usamos o input do HTML real
  await page.waitForSelector('input.login-button');
  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle" }),
    page.click('input.login-button')
    // alternativas válidas:
    // page.click('input[type="submit"][value="Login"]')
  ]);

  // se o dashboard tiver uma URL mais específica, ajusta aqui
  // senão podemos validar só que não estamos mais na tela de login
  if (page.url().includes("/auth/sign_in")) {
    throw new Error("Login falhou: ainda estamos na tela de login.");
  }

  console.log("✅ Login realizado com sucesso!");
  return page
}