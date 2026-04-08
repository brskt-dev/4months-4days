import { runReportScraping } from "./workflows/scrapeReports";
import { installShutdownHandlers } from "./runtime/shutdown";

installShutdownHandlers();
runReportScraping().catch((error) => {
  console.error("Falha na execucao do scraper:", error);
  process.exitCode = 1;
});
