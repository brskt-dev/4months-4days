const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const dotenv = require("dotenv");

dotenv.config();

const repoRoot = path.resolve(__dirname, "..");
const artifactsDir = process.env.AUTOMATION_ARTIFACTS_DIR || "automation-artifacts";
const controlDir = path.join(repoRoot, artifactsDir, "control");
const controlFilePath = path.join(controlDir, "execution-state.json");
const controlLogPath = path.join(controlDir, "execution-state.log.ndjson");
const auditCsvPath = path.join(repoRoot, "audit", "audit-planning.csv");
const downloadTempDir = path.resolve(repoRoot, process.env.DOWNLOAD_TEMP_DIR || path.join("temp", "download-staging"));
const targetDownloadsDir = process.env.DOWNLOADS_DIR || "";

if (!targetDownloadsDir) {
  throw new Error("DOWNLOADS_DIR ausente no .env.");
}

function nowIso() {
  return new Date().toISOString();
}

function ensureDir(dirPath) {
  return fs.promises.mkdir(dirPath, { recursive: true });
}

function parseCsvLine(line) {
  const values = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];

    if (inQuotes) {
      if (char === '"') {
        if (line[index + 1] === '"') {
          current += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      continue;
    }

    if (char === ",") {
      values.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  values.push(current);
  return values;
}

async function loadAuditPlanningMap() {
  const stream = fs.createReadStream(auditCsvPath, { encoding: "utf8" });
  const lineReader = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const rows = new Map();
  let headers = null;

  try {
    for await (const rawLine of lineReader) {
      const line = rawLine.trim();
      if (!line) {
        continue;
      }

      if (!headers) {
        headers = parseCsvLine(line);
        continue;
      }

      const values = parseCsvLine(line);
      const row = {};
      headers.forEach((header, index) => {
        row[header] = values[index] ?? "";
      });

      if (row.ReportId) {
        rows.set(String(row.ReportId), row);
      }
    }
  } finally {
    lineReader.close();
    stream.close();
  }

  return rows;
}

async function loadControlRecordsMap() {
  const raw = await fs.promises.readFile(controlFilePath, "utf8");
  const base = JSON.parse(raw);
  const records = new Map(Object.entries(base.records || {}));

  if (fs.existsSync(controlLogPath)) {
    const stream = fs.createReadStream(controlLogPath, { encoding: "utf8" });
    const lineReader = readline.createInterface({ input: stream, crlfDelay: Infinity });

    try {
      for await (const rawLine of lineReader) {
        const line = rawLine.trim();
        if (!line) {
          continue;
        }

        const entry = JSON.parse(line);
        const record = entry && entry.record ? entry.record : null;
        if (record && record.reportId) {
          records.set(String(record.reportId), record);
        }
      }
    } finally {
      lineReader.close();
      stream.close();
    }
  }

  return records;
}

function deriveRelativePlanningPath(plannedPath) {
  const normalized = String(plannedPath || "").replace(/\//g, "\\");
  const downloadsPrefix = /^downloads[\\/]+/i;
  if (downloadsPrefix.test(normalized)) {
    return normalized.replace(downloadsPrefix, "");
  }

  const rootName = path.basename(process.env.DOWNLOADS_DIR || "downloads");
  const dynamicPrefix = new RegExp(`^${rootName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\\\/]+`, "i");
  if (dynamicPrefix.test(normalized)) {
    return normalized.replace(dynamicPrefix, "");
  }

  return normalized.replace(/^[A-Za-z]:[\\/]+/, "");
}

function buildLocalRecord(record, auditRow, rebuildRunId) {
  const canonicalPlannedPath = auditRow?.PlannedPath || record.plannedPath;
  const relativePlanningPath = deriveRelativePlanningPath(canonicalPlannedPath);
  const plannedPath = path.join(targetDownloadsDir, relativePlanningPath);
  const tempPath = path.join(downloadTempDir, relativePlanningPath);

  return {
    ...record,
    formName: auditRow?.FormName || record.formName || "UnknownForm",
    localName: auditRow?.LocalName || record.localName || "UnknownLocal",
    reportDate:
      (auditRow?.ReportDate && String(auditRow.ReportDate).trim()) ||
      record.reportDate ||
      "",
    reportDateRaw:
      (auditRow?.ReportDate && String(auditRow.ReportDate).trim()) ||
      record.reportDateRaw ||
      record.reportDate ||
      "",
    year: auditRow?.Year || record.year || "",
    plannedFolder: path.dirname(plannedPath),
    plannedFilename: path.basename(plannedPath),
    plannedPath,
    tempPath,
    deliveryMode: "local",
    remoteDeliveryPath: null,
    remoteDeliveryUrl: null,
    remoteUploadedAt: null,
    planningStatus: "planned",
    extractionStatus: "queued",
    downloadStatus: "pending",
    validationStatus: "pending",
    executionStatus: "planned",
    attemptCount: 0,
    exportRequestId: null,
    errorMessage: null,
    errorStage: null,
    lastUpdate: nowIso(),
    lastAttemptAt: null,
    downloadedAt: null,
    validatedAt: null,
    fileSizeBytes: null,
    skippedReason: null,
    lastPlannedRunId: rebuildRunId,
    lastExecutionRunId: null,
  };
}

async function backupCurrentControlState() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = path.join(controlDir, "backups", `pre-gdrive-reset-${stamp}`);
  await ensureDir(backupDir);

  await fs.promises.copyFile(controlFilePath, path.join(backupDir, "execution-state.json"));
  if (fs.existsSync(controlLogPath)) {
    await fs.promises.copyFile(controlLogPath, path.join(backupDir, "execution-state.log.ndjson"));
  }

  return backupDir;
}

async function main() {
  const rebuildRunId = `local-reset-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const [auditMap, controlRecords] = await Promise.all([
    loadAuditPlanningMap(),
    loadControlRecordsMap(),
  ]);

  const backupDir = await backupCurrentControlState();
  const rebuiltRecords = {};
  let missingAuditRows = 0;

  for (const [reportId, record] of controlRecords.entries()) {
    const auditRow = auditMap.get(reportId);
    if (!auditRow) {
      missingAuditRows += 1;
    }

    rebuiltRecords[reportId] = buildLocalRecord(record, auditRow, rebuildRunId);
  }

  const rebuiltControlFile = {
    version: 2,
    updatedAt: nowIso(),
    records: rebuiltRecords,
  };

  await fs.promises.writeFile(
    controlFilePath,
    `${JSON.stringify(rebuiltControlFile, null, 2)}\n`,
    "utf8"
  );

  await fs.promises.rm(controlLogPath, { force: true });

  const summary = {
    rebuiltAt: rebuiltControlFile.updatedAt,
    rebuildRunId,
    targetDownloadsDir,
    downloadTempDir,
    recordCount: Object.keys(rebuiltRecords).length,
    missingAuditRows,
    backupDir,
  };

  await fs.promises.writeFile(
    path.join(controlDir, "execution-state.local-reset.summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
    "utf8"
  );

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
