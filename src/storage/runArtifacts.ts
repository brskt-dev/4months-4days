import fs from "node:fs";
import path from "node:path";
import { CSV_HEADERS } from "../constants";
import {
  ControlRecord,
  ExecutionResultArtifactEntry,
  ExecutionSummary,
  PlannedReportItem,
  PlanningFailure,
  RunArtifacts,
} from "../types";
import { writeCsvFile } from "../utils/csv";
import { ensureDir, writeJsonAtomic } from "../utils/filesystem";
import { nowIso } from "../utils/dates";

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
  await writeJsonAtomic(
    path.join(runDir, "planning-errors.json"),
    failures.filter((failure) =>
      failure.reason.startsWith("Falha ao processar escopo:")
    )
  );
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

function buildExecutionResultEntry(
  runId: string,
  outcomeType: ExecutionResultArtifactEntry["outcomeType"],
  record: ControlRecord
): ExecutionResultArtifactEntry {
  return {
    timestamp: nowIso(),
    runId,
    outcomeType,
    reportId: record.reportId,
    formName: record.formName,
    localName: record.localName,
    year: record.year,
    sourceUrl: record.sourceUrl,
    plannedPath: record.plannedPath,
    tempPath: record.tempPath,
    deliveryMode: record.deliveryMode,
    remoteDeliveryPath: record.remoteDeliveryPath,
    remoteDeliveryUrl: record.remoteDeliveryUrl,
    remoteUploadedAt: record.remoteUploadedAt,
    executionStatus: record.executionStatus,
    extractionStatus: record.extractionStatus,
    downloadStatus: record.downloadStatus,
    validationStatus: record.validationStatus,
    attemptCount: record.attemptCount,
    errorStage: record.errorStage,
    errorMessage: record.errorMessage,
    skippedReason: record.skippedReason,
    fileSizeBytes: record.fileSizeBytes,
    lastAttemptAt: record.lastAttemptAt,
    downloadedAt: record.downloadedAt,
    validatedAt: record.validatedAt,
  };
}

export async function appendExecutionResultArtifacts(
  runDir: string,
  runId: string,
  outcomeType: ExecutionResultArtifactEntry["outcomeType"],
  records: ControlRecord[]
): Promise<void> {
  if (records.length === 0) {
    return;
  }

  const filePath = path.join(runDir, "download-results.ndjson");
  await ensureDir(path.dirname(filePath));
  const lines = records.map((record) =>
    JSON.stringify(buildExecutionResultEntry(runId, outcomeType, record))
  );
  await fs.promises.appendFile(filePath, `${lines.join("\n")}\n`, "utf8");
}

export async function writeExecutionArtifacts(
  runDir: string,
  runId: string,
  records: ControlRecord[]
): Promise<void> {
  const runRecords = records.filter((record) => record.lastPlannedRunId === runId);
  const entries = runRecords.map((record) =>
    buildExecutionResultEntry(
      runId,
      record.skippedReason && record.lastExecutionRunId === runId
        ? "skipped_before_queue"
        : "processed",
      record
    )
  );

  await writeJsonAtomic(path.join(runDir, "download-results.json"), entries);
  await writeCsvFile(
    path.join(runDir, "download-results.csv"),
    [
      "ReportId",
      "FormName",
      "LocalName",
      "Year",
      "DeliveryMode",
      "ExecutionStatus",
      "ExtractionStatus",
      "DownloadStatus",
      "ValidationStatus",
      "AttemptCount",
      "PlannedPath",
      "TempPath",
      "RemoteDeliveryPath",
      "RemoteDeliveryUrl",
      "RemoteUploadedAt",
      "ErrorStage",
      "ErrorMessage",
      "SkippedReason",
      "FileSizeBytes",
      "LastAttemptAt",
      "DownloadedAt",
      "ValidatedAt",
      "SourceUrl",
    ],
    entries.map((entry) => ({
      ReportId: entry.reportId,
      FormName: entry.formName,
      LocalName: entry.localName,
      Year: entry.year,
      DeliveryMode: entry.deliveryMode,
      ExecutionStatus: entry.executionStatus,
      ExtractionStatus: entry.extractionStatus,
      DownloadStatus: entry.downloadStatus,
      ValidationStatus: entry.validationStatus,
      AttemptCount: String(entry.attemptCount),
      PlannedPath: entry.plannedPath,
      TempPath: entry.tempPath ?? "",
      RemoteDeliveryPath: entry.remoteDeliveryPath ?? "",
      RemoteDeliveryUrl: entry.remoteDeliveryUrl ?? "",
      RemoteUploadedAt: entry.remoteUploadedAt ?? "",
      ErrorStage: entry.errorStage ?? "",
      ErrorMessage: entry.errorMessage ?? "",
      SkippedReason: entry.skippedReason ?? "",
      FileSizeBytes:
        entry.fileSizeBytes === null ? "" : String(entry.fileSizeBytes),
      LastAttemptAt: entry.lastAttemptAt ?? "",
      DownloadedAt: entry.downloadedAt ?? "",
      ValidatedAt: entry.validatedAt ?? "",
      SourceUrl: entry.sourceUrl,
    }))
  );
}
