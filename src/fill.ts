import { runFillWorkflow } from "./workflows/fillReports";

runFillWorkflow().catch((error) => {
  console.error("Falha na execucao do preenchimento:", error);
  process.exitCode = 1;
});
