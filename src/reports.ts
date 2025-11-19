import { Page } from "playwright";

export async function goToReports(page: Page): Promise<Page> {
  console.log("➡️ Abrindo menu 'Gestão de Serviços'...");

  // abre o dropdown do menu
  await page.click("#work-menu-button");

  // espera o item ficar visível
  await page.waitForSelector('a[href="/form_fills"]', { timeout: 5000 });

  console.log("➡️ Acessando 'Preenchimentos Realizados / Relatórios'...");

  await page.click('a[href="/form_fills"]');

  // confirma a navegação
  await page.waitForURL("**/form_fills", { timeout: 15000 });

  console.log("✅ Página de relatórios aberta com sucesso!");
  console.log("📄 URL:", page.url());

  return page;
}
