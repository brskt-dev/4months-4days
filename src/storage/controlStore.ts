import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { ControlFile, ControlRecord } from "../types";
import { nowIso } from "../utils/dates";
import {
  deleteFileIfExists,
  ensureDir,
  fileExists,
  readJsonFile,
  writeJsonAtomic,
} from "../utils/filesystem";
import { deriveExecutionStatus } from "../utils/status";

const EMPTY_CONTROL_FILE: ControlFile = {
  version: 2,
  updatedAt: "",
  records: {},
};

type PersistedControlLogEntry = {
  type: "record";
  record: ControlRecord;
};

function getControlLogFilePath(filePath: string): string {
  const parsed = path.parse(filePath);
  return path.join(parsed.dir, `${parsed.name}.log.ndjson`);
}

function normalizeControlRecord(record: Partial<ControlRecord>): ControlRecord {
  const normalized: ControlRecord = {
    reportId: String(record.reportId ?? ""),
    formName: String(record.formName ?? "UnknownForm"),
    localName: String(record.localName ?? "UnknownLocal"),
    assetName: record.assetName ?? null,
    reportDate: String(record.reportDate ?? ""),
    reportDateRaw: String(record.reportDateRaw ?? record.reportDate ?? ""),
    year: String(record.year ?? ""),
    sourcePage: Number(record.sourcePage ?? 0),
    sourceRowIndex: Number(record.sourceRowIndex ?? 0),
    sourceUrl: String(record.sourceUrl ?? ""),
    exportButtonId: record.exportButtonId ?? null,
    filterFormId: record.filterFormId ?? null,
    filterLocalId: record.filterLocalId ?? null,
    filterAssetId: record.filterAssetId ?? null,
    filterStartDate: String(record.filterStartDate ?? ""),
    filterEndDate: String(record.filterEndDate ?? ""),
    plannedFolder: String(record.plannedFolder ?? ""),
    plannedFilename: String(record.plannedFilename ?? ""),
    plannedPath: String(record.plannedPath ?? ""),
    tempPath: record.tempPath ?? null,
    deliveryMode: record.deliveryMode ?? "local",
    remoteDeliveryPath: record.remoteDeliveryPath ?? null,
    remoteDeliveryUrl: record.remoteDeliveryUrl ?? null,
    remoteUploadedAt: record.remoteUploadedAt ?? null,
    discoveredAt: String(record.discoveredAt ?? ""),
    discoveredInRunId: String(record.discoveredInRunId ?? ""),
    planningStatus: record.planningStatus ?? "planned",
    extractionStatus: record.extractionStatus ?? "queued",
    downloadStatus: record.downloadStatus ?? "pending",
    validationStatus: record.validationStatus ?? "pending",
    executionStatus: record.executionStatus ?? "planned",
    attemptCount: Number(record.attemptCount ?? 0),
    exportRequestId: record.exportRequestId ?? null,
    errorMessage: record.errorMessage ?? null,
    errorStage: record.errorStage ?? null,
    lastUpdate: String(record.lastUpdate ?? ""),
    lastAttemptAt: record.lastAttemptAt ?? null,
    downloadedAt: record.downloadedAt ?? null,
    validatedAt: record.validatedAt ?? null,
    fileSizeBytes:
      record.fileSizeBytes === null || record.fileSizeBytes === undefined
        ? null
        : Number(record.fileSizeBytes),
    skippedReason: record.skippedReason ?? null,
    lastPlannedRunId: String(
      record.lastPlannedRunId ?? record.discoveredInRunId ?? ""
    ),
    lastExecutionRunId: record.lastExecutionRunId ?? null,
  };

  normalized.executionStatus = deriveExecutionStatus(normalized);
  if (record.executionStatus) {
    normalized.executionStatus = record.executionStatus;
  }

  return normalized;
}

function normalizeControlFile(controlFile: ControlFile): ControlFile {
  const records: Record<string, ControlRecord> = {};

  for (const [reportId, record] of Object.entries(controlFile.records ?? {})) {
    records[reportId] = normalizeControlRecord(record);
  }

  return {
    version: 2,
    updatedAt: controlFile.updatedAt ?? "",
    records,
  };
}

async function readControlLogEntries(
  filePath: string
): Promise<PersistedControlLogEntry[]> {
  if (!(await fileExists(filePath))) {
    return [];
  }

  const entries: PersistedControlLogEntry[] = [];
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const lineReader = readline.createInterface({
    input: stream,
    crlfDelay: Infinity,
  });

  try {
    for await (const line of lineReader) {
      const trimmedLine = line.trim();
      if (!trimmedLine) {
        continue;
      }

      entries.push(JSON.parse(trimmedLine) as PersistedControlLogEntry);
    }
  } finally {
    lineReader.close();
    stream.close();
  }

  return entries;
}

export async function loadControlFile(filePath: string): Promise<ControlFile> {
  const controlFile = normalizeControlFile(
    await readJsonFile(filePath, EMPTY_CONTROL_FILE)
  );
  const logEntries = await readControlLogEntries(getControlLogFilePath(filePath));

  for (const entry of logEntries) {
    if (entry.type !== "record") {
      continue;
    }

    controlFile.records[entry.record.reportId] = normalizeControlRecord(
      entry.record
    );
  }

  return controlFile;
}

export async function saveControlFile(
  filePath: string,
  controlFile: ControlFile
): Promise<void> {
  const normalized = normalizeControlFile(controlFile);
  normalized.updatedAt = nowIso();
  controlFile.version = normalized.version;
  controlFile.updatedAt = normalized.updatedAt;
  await writeJsonAtomic(filePath, normalized);
  await deleteFileIfExists(getControlLogFilePath(filePath));
}

export async function appendControlRecordUpdates(
  filePath: string,
  records: ControlRecord[]
): Promise<void> {
  if (records.length === 0) {
    return;
  }

  const logFile = getControlLogFilePath(filePath);
  await ensureDir(path.dirname(logFile));
  const lines = records.map((record) =>
    JSON.stringify({
      type: "record",
      record: normalizeControlRecord(record),
    } satisfies PersistedControlLogEntry)
  );
  await fs.promises.appendFile(logFile, `${lines.join("\n")}\n`, "utf8");
}

export function upsertControlRecord(
  controlFile: ControlFile,
  record: ControlRecord
): void {
  controlFile.records[record.reportId] = normalizeControlRecord(record);
  controlFile.updatedAt = nowIso();
}

export function getControlRecords(controlFile: ControlFile): ControlRecord[] {
  return Object.values(controlFile.records);
}
