import { Page } from "playwright";
import { config } from "../config";
import { closeOnboardingPopup } from "../helpers/closePopup";
import { RunLogger } from "../logging/runLogger";
import { ensureAuthenticatedPage } from "../login";
import {
  exportReportPdf,
  findExportSelectorForReport,
} from "../reports";
import {
  ControlFile,
  ControlRecord,
  PlannedReportItem,
} from "../types";
import { nowIso } from "../utils/dates";
import { fileExists, validatePdfFile } from "../utils/filesystem";
import { deriveExecutionStatus } from "../utils/status";

function createControlRecord(
  item: PlannedReportItem,
  runId: string
): ControlRecord {
  return {
    ...item,
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
    lastPlannedRunId: runId,
    lastExecutionRunId: null,
  };
}

function mergeFilterTrace(
  current: ControlRecord["filterTrace"],
  incoming: PlannedReportItem["filterTrace"]
): ControlRecord["filterTrace"] {
  const merged = [...current];

  for (const trace of incoming) {
    if (!merged.some((item) => item.scopeId === trace.scopeId)) {
      merged.push(trace);
    }
  }

  return merged;
}

function updateRecord(
  record: ControlRecord,
  patch: Partial<ControlRecord>,
  deriveStatus = true
): void {
  Object.assign(record, patch);
  record.lastUpdate = nowIso();
  if (deriveStatus) {
    record.executionStatus = deriveExecutionStatus(record);
  }
}

async function markExistingValidFile(
  record: ControlRecord,
  runId: string,
  logger: RunLogger
): Promise<boolean> {
  if (config.execution.overwriteExisting) {
    return false;
  }

  if (!(await fileExists(record.plannedPath))) {
    return false;
  }

  const validation = await validatePdfFile(record.plannedPath);
  if (!validation.valid) {
    await logger.warn(
      "validation",
      "Arquivo existente encontrado, mas invalidado. Item sera reprocessado.",
      { reason: validation.reason, plannedPath: record.plannedPath },
      record.reportId
    );
    return false;
  }

  updateRecord(record, {
    extractionStatus: "downloaded",
    downloadStatus: "downloaded",
    validationStatus: "validated",
    downloadedAt: record.downloadedAt ?? nowIso(),
    validatedAt: nowIso(),
    fileSizeBytes: validation.sizeBytes,
    skippedReason: "existing_valid_file",
    lastExecutionRunId: runId,
  });

  await logger.info(
    "validation",
    "Arquivo valido ja existia no destino. Item marcado como validado.",
    { plannedPath: record.plannedPath, sizeBytes: validation.sizeBytes },
    record.reportId
  );

  return true;
}

function resetRecordForRetry(record: ControlRecord): void {
  updateRecord(
    record,
    {
      extractionStatus: "queued",
      downloadStatus: "pending",
      validationStatus: "pending",
      exportRequestId: null,
      errorMessage: null,
      errorStage: null,
      skippedReason: null,
    },
    false
  );
  record.executionStatus = "planned";
}

export async function synchronizeControlState(
  controlFile: ControlFile,
  plannedItems: PlannedReportItem[],
  runId: string,
  logger: RunLogger
): Promise<ControlRecord[]> {
  const records: ControlRecord[] = [];

  for (const item of plannedItems) {
    const existing = controlFile.records[item.reportId];
    if (!existing) {
      const created = createControlRecord(item, runId);
      controlFile.records[item.reportId] = created;
      records.push(created);
      continue;
    }

    Object.assign(existing, item, {
      filterTrace: mergeFilterTrace(existing.filterTrace, item.filterTrace),
      planningStatus: "planned",
      lastPlannedRunId: runId,
    });

    if (
      ["request_created", "processing", "ready_to_download"].includes(
        existing.executionStatus
      )
    ) {
      resetRecordForRetry(existing);
    }

    if (
      existing.validationStatus === "validated" &&
      !(await fileExists(existing.plannedPath))
    ) {
      resetRecordForRetry(existing);
      await logger.warn(
        "planning",
        "Registro validado anteriormente perdeu o arquivo local. Item sera reprocessado.",
        { plannedPath: existing.plannedPath },
        existing.reportId
      );
    }

    records.push(existing);
  }

  return records;
}

export async function buildExecutionQueue(
  records: ControlRecord[],
  runId: string,
  logger: RunLogger
): Promise<ControlRecord[]> {
  const queue: ControlRecord[] = [];

  for (const record of records) {
    if (
      config.execution.skipValidated &&
      (record.validationStatus === "validated" ||
        record.executionStatus === "validated")
    ) {
      const skipped = await markExistingValidFile(record, runId, logger);
      if (skipped) {
        continue;
      }
    }

    const existingValidFile = await markExistingValidFile(record, runId, logger);
    if (existingValidFile) {
      continue;
    }

    if (
      record.executionStatus === "error" &&
      record.attemptCount >= config.execution.maxRetries
    ) {
      await logger.warn(
        "execution",
        "Item com limite de tentativas excedido ficou fora da fila.",
        { attemptCount: record.attemptCount },
        record.reportId
      );
      continue;
    }

    if (record.executionStatus === "validated") {
      continue;
    }

    queue.push(record);
  }

  return queue;
}

export async function prepareControlRecordsForResume(
  controlFile: ControlFile,
  runId: string,
  logger: RunLogger
): Promise<ControlRecord[]> {
  const records = Object.values(controlFile.records);

  for (const record of records) {
    record.lastPlannedRunId = runId;

    if (
      ["request_created", "processing", "ready_to_download"].includes(
        record.executionStatus
      )
    ) {
      const previousStatus = record.executionStatus;
      resetRecordForRetry(record);
      await logger.warn(
        "resume",
        "Item interrompido em fase parcial foi recolocado na fila.",
        { previousStatus },
        record.reportId
      );
    }

    if (
      record.validationStatus === "validated" &&
      !(await fileExists(record.plannedPath))
    ) {
      resetRecordForRetry(record);
      await logger.warn(
        "resume",
        "Item validado perdeu o arquivo local e sera reprocessado.",
        { plannedPath: record.plannedPath },
        record.reportId
      );
    }
  }

  return records;
}

async function processSingleRecord(
  page: Page,
  record: ControlRecord,
  runId: string,
  logger: RunLogger
): Promise<void> {
  let stage = "navigate";

  try {
    record.attemptCount += 1;
    updateRecord(
      record,
      {
        extractionStatus: "queued",
        downloadStatus: "pending",
        validationStatus: "pending",
        exportRequestId: null,
        errorMessage: null,
        errorStage: null,
        skippedReason: null,
        lastAttemptAt: nowIso(),
        lastExecutionRunId: runId,
      },
      true
    );

    await logger.info(
      "execution",
      "Iniciando processamento do item.",
      {
        attemptCount: record.attemptCount,
        sourceUrl: record.sourceUrl,
      },
      record.reportId
    );

    page = await ensureAuthenticatedPage(page, record.sourceUrl);
    await closeOnboardingPopup(page);

    const exportSelector = await findExportSelectorForReport(
      page,
      record.reportId,
      record.exportButtonId
    );

    if (!exportSelector) {
      throw new Error("Nao foi possivel localizar o botao de exportacao.");
    }

    stage = "export_request";
    const exportResult = await exportReportPdf(
      page,
      exportSelector,
      record.plannedPath,
      config.execution.pollingIntervalMs,
      {
        onRequestCreated: async (exportRequestId) => {
          updateRecord(record, {
            extractionStatus: "request_created",
            exportRequestId,
            lastExecutionRunId: runId,
          });

          await logger.info(
            "export",
            "Solicitacao de exportacao criada.",
            { exportRequestId },
            record.reportId
          );
        },
        onProcessing: async () => {
          updateRecord(record, {
            extractionStatus: "processing",
          });
        },
        onReadyToDownload: async () => {
          updateRecord(record, {
            extractionStatus: "ready_to_download",
          });

          await logger.info(
            "export",
            "Arquivo pronto para download.",
            undefined,
            record.reportId
          );
        },
      }
    );

    stage = "download";
    const downloadedValidation = await validatePdfFile(record.plannedPath);
    updateRecord(record, {
      extractionStatus: "downloaded",
      downloadStatus: downloadedValidation.valid ? "downloaded" : "error",
      downloadedAt: nowIso(),
      fileSizeBytes: downloadedValidation.sizeBytes,
    });

    await logger.info(
      "download",
      "Download concluido.",
      {
        suggestedFilename: exportResult.suggestedFilename,
        plannedPath: record.plannedPath,
        sizeBytes: downloadedValidation.sizeBytes,
      },
      record.reportId
    );

    stage = "validation";
    if (!downloadedValidation.valid) {
      throw new Error(downloadedValidation.reason ?? "Arquivo invalido.");
    }

    updateRecord(record, {
      validationStatus: "validated",
      validatedAt: nowIso(),
    });

    await logger.info(
      "validation",
      "Arquivo validado com sucesso.",
      { plannedPath: record.plannedPath },
      record.reportId
    );
  } catch (error) {
    updateRecord(record, {
      extractionStatus:
        stage === "navigate" || stage === "export_request"
          ? "error"
          : record.extractionStatus,
      downloadStatus: stage === "download" ? "error" : record.downloadStatus,
      validationStatus:
        stage === "validation" ? "error" : record.validationStatus,
      errorStage: stage,
      errorMessage: error instanceof Error ? error.message : String(error),
    });

    await logger.error(
      stage,
      "Falha ao processar item.",
      {
        error:
          error instanceof Error ? error.stack ?? error.message : String(error),
        attemptCount: record.attemptCount,
      },
      record.reportId
    );
  }
}

export async function processExecutionQueue(
  basePage: Page,
  queue: ControlRecord[],
  runId: string,
  logger: RunLogger,
  onRecordProcessed: () => Promise<void>
): Promise<void> {
  if (queue.length === 0) {
    return;
  }

  const workerCount = Math.min(config.execution.downloadConcurrency, queue.length);
  const pages = [basePage];

  for (let index = 1; index < workerCount; index++) {
    pages.push(await basePage.context().newPage());
  }

  let nextIndex = 0;
  await Promise.all(
    pages.map(async (page) => {
      while (true) {
        const currentIndex = nextIndex;
        nextIndex += 1;

        if (currentIndex >= queue.length) {
          break;
        }

        await processSingleRecord(page, queue[currentIndex], runId, logger);
        await onRecordProcessed();
      }
    })
  );

  for (const page of pages.slice(1)) {
    await page.close();
  }
}
