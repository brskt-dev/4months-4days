import fs from "node:fs";
import path from "node:path";
import { CSV_HEADERS } from "../constants";
import {
  ExecutionSummary,
  PlannedReportItem,
  PlanningFailure,
  RunArtifacts,
} from "../types";
import { writeCsvFile } from "../utils/csv";
import { ensureDir, writeJsonAtomic } from "../utils/filesystem";

export async function writeRunArtifacts(
  runDir: string,
  artifacts: RunArtifacts
): Promise<void> {
  await writeJsonAtomic(path.join(runDir, "run.json"), artifacts);
}

export async function writePlanningArtifacts(
  runDir: string,
  items: PlannedReportItem[],
  failures: PlanningFailure[]
): Promise<void> {
  await writeJsonAtomic(path.join(runDir, "planning.json"), {
    plannedItems: items,
    planningFailures: failures,
  });

  await writeCsvFile(
    path.join(runDir, "planning.csv"),
    CSV_HEADERS,
    items.map((item) => ({
      FormName: item.formName,
      LocalName: item.localName,
      ReportDate: item.reportDate,
      Year: item.year,
      ReportId: item.reportId,
      SourcePage: String(item.sourcePage),
      FilterFormId: item.filterFormId ?? "",
      FilterLocalId: item.filterLocalId ?? "",
      FilterAssetId: item.filterAssetId ?? "",
      PlannedPath: item.plannedPath,
      PlannedFileName: item.plannedFilename,
    }))
  );

  await writeJsonAtomic(path.join(runDir, "planning-failures.json"), failures);
}

export async function writeSummaryArtifacts(
  runDir: string,
  summary: ExecutionSummary
): Promise<void> {
  await writeJsonAtomic(path.join(runDir, "summary.json"), summary);

  const lines = [
    `RunId: ${summary.runId}`,
    `StartedAt: ${summary.startedAt}`,
    `FinishedAt: ${summary.finishedAt}`,
    `FiltersProcessed: ${summary.filtersProcessed.length}`,
    `ReportsIdentified: ${summary.totalReportsIdentified}`,
    `ExportRequestsCreated: ${summary.totalExportRequestsCreated}`,
    `DownloadsConcluded: ${summary.totalDownloadsConcluded}`,
    `Validated: ${summary.totalValidated}`,
    `Skipped: ${summary.totalSkipped}`,
    `Failures: ${summary.totalFailures}`,
    `PendingRetry: ${summary.totalPendingRetry}`,
    "",
    "PendingItems:",
    ...summary.pendingItems.map(
      (item) =>
        `- ${item.reportId} | ${item.executionStatus} | attempts=${item.attemptCount} | ${item.plannedPath} | ${item.errorMessage ?? "sem erro"}`
    ),
  ];

  const summaryPath = path.join(runDir, "summary.txt");
  await ensureDir(path.dirname(summaryPath));
  await fs.promises.writeFile(summaryPath, `${lines.join("\n")}\n`, "utf8");
}
