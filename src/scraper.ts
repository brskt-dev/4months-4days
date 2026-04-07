import { runReportScraping } from "./workflows/scrapeReports";

runReportScraping().catch((error) => {
  console.error("Falha na execucao do scraper:", error);
  process.exitCode = 1;
});
