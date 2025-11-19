import { Page } from "playwright";
import { closeOnboardingPopup } from "./closePopup";

export async function fillReport(page: Page, workId: number): Promise<void> {
  console.log(`➡️ Abrindo atividade ${workId}...`);
  await page.goto(`https://app.produttivo.com.br/works/${workId}`);

  await closeOnboardingPopup(page);

  // --- CLICA EM NOVO PREENCHIMENTO ---
  console.log("➡️ Criando novo preenchimento...");

  await page.waitForSelector('a[href*="/form_fills/new"]');
  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle" }),
    page.click('a[href*="/form_fills/new"]'),
  ]);

  // --- AGUARDA TELA DE EDIÇÃO ---
  console.log("➡️ Aguardando tela de edição do preenchimento...");
  await page.waitForURL("**/form_fills/**/edit*", { timeout: 15000 });

  await closeOnboardingPopup(page);

  // --- ABRE O MODAL ---
  console.log("➡️ Abrindo modal de resposta...");
  await page.waitForSelector(".edit-field-value-button");
  await page.click(".edit-field-value-button");

  // --- ESPERA MODAL ---
  await page.waitForSelector(".modal-dialog");

  console.log("➡️ Preenchendo texto da resposta...");

  // Aguarda input estar disponível
  await page.waitForSelector("#fieldValueValue");

  // Preenche o texto
  await page.fill("#fieldValueValue", "Resposta automática gerada pelo bot");

  console.log("➡️ Salvando resposta...");

  await page.click("#saveFieldValueButton");

  // Aguarda o modal sumir visualmente
  await page.waitForSelector(".modal-dialog", {
    state: "hidden",
    timeout: 15000,
  });

  console.log("➡️ Resposta salva!");

  // --- VOLTA PARA TELA DA ATIVIDADE ---
  console.log("➡️ Voltando para a atividade...");
  await page.goto(`https://app.produttivo.com.br/works/${workId}`);

  await closeOnboardingPopup(page);

  console.log("✅ Preenchimento finalizado!");
}
