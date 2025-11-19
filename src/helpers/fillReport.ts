import { Page } from "playwright";
import { closeOnboardingPopup } from "./closePopup";

export async function fillReport(page: Page, workId: number): Promise<void> {
  console.log(`➡️ Abrindo atividade ${workId}...`);
  await page.goto(`https://app.produttivo.com.br/works/${workId}`, {
    waitUntil: "domcontentloaded",
  });

  await closeOnboardingPopup(page);

  console.log("➡️ Criando novo preenchimento...");
  await page.waitForSelector('a[href*="/form_fills/new"]');

  await Promise.all([
    page.waitForURL("**/form_fills/**/edit*"),
    page.click('a[href*="/form_fills/new"]'),
  ]);

  console.log("➡️ Tela de edição carregada.");
  await closeOnboardingPopup(page);

  console.log("➡️ Abrindo modal...");
  await page.click(".edit-field-value-button");
  await page.waitForSelector(".modal-dialog");

  console.log("➡️ Preenchendo resposta...");
  await page.fill("#fieldValueValue", "Resposta automática gerada pelo bot");

  console.log("➡️ Salvando...");
  await page.click("#saveFieldValueButton");

  // Modal some rápido, evitar traps
  await page.waitForTimeout(150);

  console.log("➡️ Recarregando página para novo preenchimento...");
  await page.reload({ waitUntil: "domcontentloaded" });

  await closeOnboardingPopup(page);

  console.log("✅ Preenchimento finalizado!");
}
