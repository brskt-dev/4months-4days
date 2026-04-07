import { config } from "../config";
import { closeOnboardingPopup } from "../helpers/closePopup";
import { fillReport } from "../helpers/fillReport";
import { performLogin } from "../login";
import { FillWorkflowOptions } from "../types";

export async function runFillWorkflow(
  options: Partial<FillWorkflowOptions> = {}
): Promise<void> {
  const workId = options.workId ?? config.fill.workId;
  const repeatCount = options.repeatCount ?? config.fill.repeatCount;
  const answerText = options.answerText ?? config.fill.answerText;

  if (!workId) {
    throw new Error(
      "Defina FILL_WORK_ID no .env ou informe um workId para executar o preenchimento."
    );
  }

  const page = await performLogin();
  await closeOnboardingPopup(page);

  for (let index = 1; index <= repeatCount; index++) {
    console.log(`\n[${index}/${repeatCount}] Preenchendo atividade ${workId}...`);

    try {
      await fillReport(page, workId, answerText);
      console.log(`Preenchimento ${index} concluido.`);
    } catch (error) {
      console.error(`Erro no preenchimento ${index}:`, error);
    }
  }

  console.log("Fluxo de preenchimento finalizado.");
}
