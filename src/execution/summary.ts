import { config } from "../config";
import { ControlRecord, ExecutionSummary, SummaryBucket } from "../types";

function buildBuckets(
  records: ControlRecord[],
  runId: string,
  selector: (record: ControlRecord) => string
): SummaryBucket[] {
  const buckets = new Map<string, SummaryBucket>();

  for (const record of records) {
    const key = selector(record);
    const bucket = buckets.get(key) ?? {
      key,
      planned: 0,
      downloaded: 0,
      validated: 0,
      skipped: 0,
      error: 0,
      pendingRetry: 0,
    };

    bucket.planned += 1;

    if (record.downloadStatus === "downloaded") {
      bucket.downloaded += 1;
    }

    if (record.validationStatus === "validated") {
      bucket.validated += 1;
    }

    if (record.skippedReason && record.lastExecutionRunId === runId) {
      bucket.skipped += 1;
    }

    if (record.executionStatus === "error") {
      bucket.error += 1;
      if (record.attemptCount < config.execution.maxRetries) {
        bucket.pendingRetry += 1;
      }
    }

    buckets.set(key, bucket);
  }

  return [...buckets.values()].sort((left, right) =>
    left.key.localeCompare(right.key)
  );
}

export function buildExecutionSummary(
  runId: string,
  startedAt: string,
  finishedAt: string,
  records: ControlRecord[],
  filtersProcessed: ExecutionSummary["filtersProcessed"]
): ExecutionSummary {
  const plannedRecords = records.filter((record) => record.lastPlannedRunId === runId);
  const pendingItems = plannedRecords
    .filter(
      (record) =>
        record.executionStatus === "error" &&
        record.attemptCount < config.execution.maxRetries
    )
    .map((record) => ({
      reportId: record.reportId,
      executionStatus: record.executionStatus,
      attemptCount: record.attemptCount,
      errorMessage: record.errorMessage,
      plannedPath: record.plannedPath,
    }));

  return {
    runId,
    startedAt,
    finishedAt,
    filtersProcessed,
    totalReportsIdentified: plannedRecords.length,
    totalExportRequestsCreated: plannedRecords.filter(
      (record) =>
        record.exportRequestId !== null ||
        ["processing", "ready_to_download", "downloaded", "validated"].includes(
          record.executionStatus
        )
    ).length,
    totalDownloadsConcluded: plannedRecords.filter(
      (record) => record.downloadStatus === "downloaded"
    ).length,
    totalValidated: plannedRecords.filter(
      (record) => record.validationStatus === "validated"
    ).length,
    totalFailures: plannedRecords.filter(
      (record) => record.executionStatus === "error"
    ).length,
    totalSkipped: plannedRecords.filter(
      (record) => record.skippedReason && record.lastExecutionRunId === runId
    ).length,
    totalPendingRetry: pendingItems.length,
    pendingItems,
    byForm: buildBuckets(plannedRecords, runId, (record) => record.formName),
    byLocal: buildBuckets(plannedRecords, runId, (record) => record.localName),
    byYear: buildBuckets(plannedRecords, runId, (record) => record.year),
  };
}
