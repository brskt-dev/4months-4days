import { Page } from "playwright";
import { buildAppUrl } from "../config";
import { ROUTES, SELECTORS } from "../constants";
import { closeOnboardingPopup } from "./closePopup";

export async function fillReport(
  page: Page,
  workId: number,
  answerText: string
): Promise<void> {
  console.log(`Abrindo atividade ${workId}...`);
  await page.goto(buildAppUrl(`${ROUTES.works}/${workId}`), {
    waitUntil: "domcontentloaded",
  });

  await closeOnboardingPopup(page);

  console.log("Criando novo preenchimento...");
  await page.waitForSelector(SELECTORS.newFillLink);

  await Promise.all([
    page.waitForURL("**/form_fills/**/edit*"),
    page.click(SELECTORS.newFillLink),
  ]);

  console.log("Tela de edicao carregada.");
  await closeOnboardingPopup(page);

  console.log("Abrindo modal...");
  await page.click(SELECTORS.editFieldButton);
  await page.waitForSelector(".modal-dialog");

  console.log("Preenchendo resposta...");
  await page.fill(SELECTORS.fieldValueInput, answerText);

  console.log("Salvando...");
  await page.click(SELECTORS.saveFieldValueButton);
  await page.waitForTimeout(150);

  console.log("Recarregando pagina para novo preenchimento...");
  await page.reload({ waitUntil: "domcontentloaded" });
  await closeOnboardingPopup(page);

  console.log("Preenchimento finalizado.");
}
