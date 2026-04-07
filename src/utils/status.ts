import {
  ControlRecord,
  DownloadStatus,
  ExecutionStatus,
  ExtractionStatus,
  ValidationStatus,
} from "../types";

export function deriveExecutionStatus(record: {
  planningStatus: "planned" | "error";
  extractionStatus: ExtractionStatus;
  downloadStatus: DownloadStatus;
  validationStatus: ValidationStatus;
}): ExecutionStatus {
  if (record.planningStatus === "error") {
    return "error";
  }

  if (record.validationStatus === "validated") {
    return "validated";
  }

  if (
    record.validationStatus === "error" ||
    record.downloadStatus === "error" ||
    record.extractionStatus === "error"
  ) {
    return "error";
  }

  if (
    record.validationStatus === "skipped" ||
    record.downloadStatus === "skipped" ||
    record.extractionStatus === "skipped"
  ) {
    return "skipped";
  }

  if (record.downloadStatus === "downloaded") {
    return "downloaded";
  }

  if (record.extractionStatus === "ready_to_download") {
    return "ready_to_download";
  }

  if (record.extractionStatus === "processing") {
    return "processing";
  }

  if (record.extractionStatus === "request_created") {
    return "request_created";
  }

  if (record.extractionStatus === "queued") {
    return "queued";
  }

  return "planned";
}

export function canRetryRecord(
  record: ControlRecord,
  maxRetries: number
): boolean {
  if (record.executionStatus === "validated") {
    return false;
  }

  if (record.executionStatus === "skipped") {
    return false;
  }

  return record.attemptCount < maxRetries;
}
