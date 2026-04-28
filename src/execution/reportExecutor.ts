import fs from "node:fs";
import path from "node:path";
import { Page } from "playwright";
import { config } from "../config";
import { closeOnboardingPopup } from "../helpers/closePopup";
import { RunLogger } from "../logging/runLogger";
import { ensureAuthenticatedPage } from "../login";
import { isShutdownRequested } from "../runtime/shutdown";
import { SharePointSessionRestClient } from "../sharepoint/session";
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
import {
  deleteFileIfExists,
  ensureDir,
  fileExists,
  validatePdfFile,
  validatePdfFileWithOptions,
} from "../utils/filesystem";
import { mapWithConcurrency } from "../utils/concurrency";
import {
  buildSharePointRemotePath,
  buildTempDownloadPath,
} from "../utils/reportPaths";
import { deriveExecutionStatus } from "../utils/status";

function isOutOfSpaceError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);

  return /ENOSPC|no space left on device/i.test(message);
}

function createControlRecord(
  item: PlannedReportItem,
  runId: string
): ControlRecord {
  return {
    ...extractControlFields(item),
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

function extractControlFields(
  item: PlannedReportItem
): Omit<
  ControlRecord,
  | "planningStatus"
  | "extractionStatus"
  | "downloadStatus"
  | "validationStatus"
  | "executionStatus"
  | "attemptCount"
  | "exportRequestId"
  | "errorMessage"
  | "errorStage"
  | "lastUpdate"
  | "lastAttemptAt"
  | "downloadedAt"
  | "validatedAt"
  | "fileSizeBytes"
  | "skippedReason"
  | "lastPlannedRunId"
  | "lastExecutionRunId"
> {
  return {
    reportId: item.reportId,
    formName: item.formName,
    localName: item.localName,
    assetName: item.assetName,
    reportDate: item.reportDate,
    reportDateRaw: item.reportDateRaw,
    year: item.year,
    sourcePage: item.sourcePage,
    sourceRowIndex: item.sourceRowIndex,
    sourceUrl: item.sourceUrl,
    exportButtonId: item.exportButtonId,
    filterFormId: item.filterFormId,
    filterLocalId: item.filterLocalId,
    filterAssetId: item.filterAssetId,
    filterStartDate: item.filterStartDate,
    filterEndDate: item.filterEndDate,
    plannedFolder: item.plannedFolder,
    plannedFilename: item.plannedFilename,
    plannedPath: item.plannedPath,
    tempPath: buildTempDownloadPath(item),
    deliveryMode: config.execution.deliveryMode as ControlRecord["deliveryMode"],
    remoteDeliveryPath:
      config.execution.deliveryMode === "sharepoint-session-rest"
        ? buildSharePointRemotePath(item)
        : null,
    remoteDeliveryUrl: null,
    remoteUploadedAt: null,
    discoveredAt: item.discoveredAt,
    discoveredInRunId: item.discoveredInRunId,
  };
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
  logger: RunLogger,
  options?: {
    trustPriorValidation?: boolean;
    logValidatedReuse?: boolean;
  }
): Promise<boolean> {
  if (record.deliveryMode === "sharepoint-session-rest") {
    return false;
  }

  if (config.execution.overwriteExisting) {
    return false;
  }

  const validation = await validatePdfFileWithOptions(record.plannedPath, {
    skipSignatureCheck: options?.trustPriorValidation ?? false,
  });
  if (!validation.valid) {
    if (validation.reason !== "Arquivo nao encontrado.") {
      await logger.warn(
        "validation",
        "Arquivo existente encontrado, mas invalidado. Item sera reprocessado.",
        { reason: validation.reason, plannedPath: record.plannedPath },
        record.reportId
      );
    }
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

  if (options?.logValidatedReuse !== false) {
    await logger.info(
      "validation",
      "Arquivo valido ja existia no destino. Item marcado como validado.",
      { plannedPath: record.plannedPath, sizeBytes: validation.sizeBytes },
      record.reportId
    );
  }

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

async function shouldBypassRetryCap(record: ControlRecord): Promise<boolean> {
  if (record.validationStatus === "validated") {
    return false;
  }

  if (record.errorStage === "remote_upload") {
    return true;
  }

  if (
    record.errorStage === "export_request" &&
    record.errorMessage?.includes("Nenhuma opcao de exportacao disponivel")
  ) {
    return true;
  }

  if (
    record.deliveryMode === "sharepoint-session-rest" &&
    record.tempPath &&
    (await validatePdfFile(record.tempPath)).valid
  ) {
    return true;
  }

  return false;
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

    const refreshedFields = extractControlFields(item);
    Object.assign(existing, refreshedFields, {
      tempPath: refreshedFields.tempPath ?? existing.tempPath,
      remoteDeliveryPath:
        refreshedFields.remoteDeliveryPath ?? existing.remoteDeliveryPath,
      remoteDeliveryUrl: existing.remoteDeliveryUrl,
      remoteUploadedAt: existing.remoteUploadedAt,
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
  const decisions = await mapWithConcurrency(
    records,
    config.execution.preflightConcurrency,
    async (record) => {
      const previouslyValidated =
        config.execution.skipValidated &&
        (record.validationStatus === "validated" ||
          record.executionStatus === "validated");

      if (previouslyValidated) {
        const skipped = await markExistingValidFile(record, runId, logger, {
          trustPriorValidation: true,
          logValidatedReuse: false,
        });
        if (skipped) {
          return {
            enqueue: false,
            fastValidatedReuse: true,
          };
        }
      }

      const existingValidFile = await markExistingValidFile(record, runId, logger);
      if (existingValidFile) {
        return {
          enqueue: false,
          fastValidatedReuse: false,
        };
      }

      if (
        record.executionStatus === "error" &&
        record.attemptCount >= config.execution.maxRetries
      ) {
        if (await shouldBypassRetryCap(record)) {
          await logger.warn(
            "execution",
            "Item excedeu o limite de tentativas, mas sera reenfileirado por se tratar de falha transiente ou arquivo temporario reaproveitavel.",
            {
              attemptCount: record.attemptCount,
              errorStage: record.errorStage,
              errorMessage: record.errorMessage,
              tempPath: record.tempPath,
            },
            record.reportId
          );
          return {
            enqueue: true,
            fastValidatedReuse: false,
          };
        }

        await logger.warn(
          "execution",
          "Item com limite de tentativas excedido ficou fora da fila.",
          { attemptCount: record.attemptCount },
          record.reportId
        );
        return {
          enqueue: false,
          fastValidatedReuse: false,
        };
      }

      if (record.executionStatus === "validated") {
        return {
          enqueue: false,
          fastValidatedReuse: false,
        };
      }

      return {
        enqueue: true,
        fastValidatedReuse: false,
      };
    }
  );

  const queue: ControlRecord[] = [];
  let fastValidatedReuseCount = 0;

  for (const [index, decision] of decisions.entries()) {
    if (decision.fastValidatedReuse) {
      fastValidatedReuseCount += 1;
    }

    if (decision.enqueue) {
      queue.push(records[index]);
    }
  }

  if (fastValidatedReuseCount > 0) {
    await logger.info(
      "execution",
      "Arquivos previamente validados foram reaproveitados com verificacao rapida durante a montagem da fila.",
      {
        count: fastValidatedReuseCount,
        preflightConcurrency: config.execution.preflightConcurrency,
      }
    );
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
    record.deliveryMode =
      config.execution.deliveryMode as ControlRecord["deliveryMode"];
    record.tempPath = buildTempDownloadPath(record);
    if (config.execution.deliveryMode === "sharepoint-session-rest") {
      record.remoteDeliveryPath =
        record.remoteDeliveryPath ?? buildSharePointRemotePath(record);
    } else {
      record.remoteDeliveryPath = null;
      record.remoteDeliveryUrl = null;
      record.remoteUploadedAt = null;
    }

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
      record.deliveryMode !== "sharepoint-session-rest" &&
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

async function ensureTempDownloadForRemoteRecord(
  page: Page,
  record: ControlRecord,
  runId: string,
  logger: RunLogger
): Promise<Page> {
  const tempPath = record.tempPath;
  if (!tempPath) {
    throw new Error("Registro remoto sem caminho temporario configurado.");
  }

  const existingTempValidation = await validatePdfFile(tempPath);
  updateRecord(
    record,
    {
      validationStatus: "pending",
      errorMessage: null,
      errorStage: null,
      skippedReason: null,
      lastAttemptAt: nowIso(),
      lastExecutionRunId: runId,
    },
    true
  );

  if (
    record.downloadStatus === "downloaded" &&
    record.downloadedAt &&
    existingTempValidation.valid
  ) {
    await logger.info(
      "download",
      "Arquivo temporario reutilizado para envio ao SharePoint.",
      {
        tempPath,
        sizeBytes: existingTempValidation.sizeBytes,
      },
      record.reportId
    );
    return page;
  }

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
        remoteDeliveryUrl: null,
        remoteUploadedAt: null,
      },
      true
    );

    await logger.info(
      "execution",
      "Iniciando download temporario do item para envio remoto.",
      {
        attemptCount: record.attemptCount,
        sourceUrl: record.sourceUrl,
        tempPath,
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
      tempPath,
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
            "Arquivo temporario pronto para download.",
            undefined,
            record.reportId
          );
        },
      }
    );

    stage = "download";
    const downloadedValidation = await validatePdfFile(tempPath);
    updateRecord(record, {
      extractionStatus: "downloaded",
      downloadStatus: downloadedValidation.valid ? "downloaded" : "error",
      downloadedAt: nowIso(),
      fileSizeBytes: downloadedValidation.sizeBytes,
    });

    await logger.info(
      "download",
      "Download temporario concluido.",
      {
        suggestedFilename: exportResult.suggestedFilename,
        tempPath,
        sizeBytes: downloadedValidation.sizeBytes,
      },
      record.reportId
    );

    if (!downloadedValidation.valid) {
      stage = "validation";
      throw new Error(downloadedValidation.reason ?? "Arquivo invalido.");
    }

    return page;
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
      "Falha ao preparar arquivo temporario para entrega remota.",
      {
        error:
          error instanceof Error ? error.stack ?? error.message : String(error),
        attemptCount: record.attemptCount,
        tempPath,
      },
      record.reportId
    );

    if (isOutOfSpaceError(error)) {
      throw error;
    }

    return page;
  }
}

async function uploadRemoteRecord(
  client: SharePointSessionRestClient,
  record: ControlRecord,
  runId: string,
  logger: RunLogger
): Promise<void> {
  const tempPath = record.tempPath;
  const remotePath = record.remoteDeliveryPath;
  if (!tempPath || !remotePath) {
    updateRecord(record, {
      validationStatus: "error",
      errorStage: "remote_upload",
      errorMessage:
        "Registro remoto sem tempPath ou remoteDeliveryPath configurado.",
    });
    return;
  }

  const tempValidation = await validatePdfFile(tempPath);
  if (!tempValidation.valid) {
    updateRecord(record, {
      downloadStatus: "error",
      validationStatus: "error",
      errorStage: "remote_upload",
      errorMessage:
        tempValidation.reason ?? "Arquivo temporario nao esta disponivel.",
    });

    await logger.error(
      "remote_upload",
      "Arquivo temporario ausente ou invalido antes do upload remoto.",
      {
        tempPath,
        reason: tempValidation.reason,
      },
      record.reportId
    );
    return;
  }

  try {
    const uploadResult = await client.uploadFile(tempPath, remotePath);
    updateRecord(record, {
      validationStatus: "validated",
      validatedAt: nowIso(),
      remoteDeliveryPath: uploadResult.remoteDeliveryPath,
      remoteDeliveryUrl: uploadResult.remoteDeliveryUrl,
      remoteUploadedAt: uploadResult.remoteUploadedAt,
      lastExecutionRunId: runId,
      errorMessage: null,
      errorStage: null,
    });

    if (config.execution.deleteTempAfterRemoteUpload) {
      await deleteFileIfExists(tempPath);
    }

    await logger.info(
      "remote_upload",
      "Upload remoto para o SharePoint concluido.",
      {
        tempPath,
        remoteDeliveryPath: uploadResult.remoteDeliveryPath,
        remoteDeliveryUrl: uploadResult.remoteDeliveryUrl,
        deletedTempFile: config.execution.deleteTempAfterRemoteUpload,
      },
      record.reportId
    );
  } catch (error) {
    updateRecord(record, {
      validationStatus: "error",
      errorStage: "remote_upload",
      errorMessage: error instanceof Error ? error.message : String(error),
      lastExecutionRunId: runId,
    });

    await logger.error(
      "remote_upload",
      "Falha ao enviar arquivo para o SharePoint.",
      {
        error:
          error instanceof Error ? error.stack ?? error.message : String(error),
        tempPath,
        remoteDeliveryPath: remotePath,
      },
      record.reportId
    );
  }
}

async function promoteExistingTempDownload(
  record: ControlRecord,
  runId: string,
  logger: RunLogger
): Promise<boolean> {
  const tempPath = record.tempPath;
  if (!tempPath) {
    return false;
  }

  const tempValidation = await validatePdfFile(tempPath);
  if (!tempValidation.valid) {
    return false;
  }

  await ensureDir(path.dirname(record.plannedPath));
  await fs.promises.copyFile(tempPath, record.plannedPath);
  const plannedValidation = await validatePdfFile(record.plannedPath);

  if (!plannedValidation.valid) {
    throw new Error(
      plannedValidation.reason ??
        "Falha ao promover arquivo temporario para o destino final."
    );
  }

  updateRecord(record, {
    extractionStatus: "downloaded",
    downloadStatus: "downloaded",
    validationStatus: "validated",
    downloadedAt: record.downloadedAt ?? nowIso(),
    validatedAt: nowIso(),
    fileSizeBytes: plannedValidation.sizeBytes,
    skippedReason: "reused_temp_file",
    errorMessage: null,
    errorStage: null,
    lastExecutionRunId: runId,
  });

  await logger.info(
    "download",
    "Arquivo temporario reaproveitado no destino final local.",
    {
      tempPath,
      plannedPath: record.plannedPath,
      sizeBytes: plannedValidation.sizeBytes,
    },
    record.reportId
  );

  return true;
}

async function processSingleRecord(
  page: Page,
  record: ControlRecord,
  runId: string,
  logger: RunLogger
): Promise<Page> {
  let stage = "navigate";

  try {
    if (config.execution.deliveryMode === "local") {
      const reusedTempDownload = await promoteExistingTempDownload(
        record,
        runId,
        logger
      );
      if (reusedTempDownload) {
        return page;
      }
    }

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

    return page;
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

    if (isOutOfSpaceError(error)) {
      throw error;
    }

    return page;
  }
}

export async function processExecutionQueue(
  basePage: Page,
  queue: ControlRecord[],
  runId: string,
  logger: RunLogger,
  onRecordProcessed: (record: ControlRecord) => Promise<void>,
  options?: {
    sharePointClient?: SharePointSessionRestClient | null;
  }
): Promise<void> {
  if (queue.length === 0) {
    return;
  }

  if (config.execution.deliveryMode === "sharepoint-session-rest") {
    const sharePointClient = options?.sharePointClient;
    if (!sharePointClient) {
      throw new Error(
        "Modo remoto SharePoint ativo sem SharePointSessionRestClient."
      );
    }

    const downloadWorkerCount = Math.min(
      config.execution.downloadConcurrency,
      queue.length
    );
    const uploadWorkerCount = Math.min(
      config.execution.sharepointUploadConcurrency,
      queue.length
    );
    const pages = [basePage];

    for (let index = 1; index < downloadWorkerCount; index++) {
      const page = await basePage.context().newPage();
      pages.push(page);
    }

    let nextIndex = 0;
    let fatalError: Error | null = null;
    let downloadsFinished = false;
    const readyForUpload: ControlRecord[] = [];
    const uploadWaiters: Array<(value: ControlRecord | null) => void> = [];

    const enqueueUpload = (record: ControlRecord): void => {
      const waiter = uploadWaiters.shift();
      if (waiter) {
        waiter(record);
        return;
      }

      readyForUpload.push(record);
    };

    const closeUploadQueue = (): void => {
      downloadsFinished = true;
      while (uploadWaiters.length > 0) {
        const waiter = uploadWaiters.shift();
        waiter?.(null);
      }
    };

    const takeUploadRecord = async (): Promise<ControlRecord | null> => {
      if (readyForUpload.length > 0) {
        return readyForUpload.shift() ?? null;
      }

      if (downloadsFinished) {
        return null;
      }

      return new Promise<ControlRecord | null>((resolve) => {
        uploadWaiters.push(resolve);
      });
    };

    const downloadWorkersPromise = Promise.all(
      pages.map(async (initialPage, pageIndex) => {
        let page = initialPage;

        while (true) {
          if (fatalError || isShutdownRequested()) {
            break;
          }

          const currentIndex = nextIndex;
          nextIndex += 1;

          if (currentIndex >= queue.length) {
            break;
          }

          try {
            const record = queue[currentIndex];
            page = await ensureTempDownloadForRemoteRecord(
              page,
              record,
              runId,
              logger
            );
            await onRecordProcessed(record);

            if (
              record.downloadStatus === "downloaded" &&
              record.executionStatus !== "error"
            ) {
              enqueueUpload(record);
            }
          } catch (error) {
            fatalError =
              error instanceof Error ? error : new Error(String(error));
            break;
          }
        }

        if (pageIndex > 0) {
          await page.close().catch(() => undefined);
        }
      })
    );
    const uploadWorkersPromise = Promise.all(
      Array.from({ length: uploadWorkerCount }, async () => {
        while (true) {
          if (fatalError) {
            break;
          }

          const record = await takeUploadRecord();
          if (!record) {
            break;
          }

          try {
            await uploadRemoteRecord(sharePointClient, record, runId, logger);
            await onRecordProcessed(record);
          } catch (error) {
            fatalError =
              error instanceof Error ? error : new Error(String(error));
            break;
          }
        }
      })
    );

    await downloadWorkersPromise;
    closeUploadQueue();
    await uploadWorkersPromise;

    if (fatalError) {
      throw fatalError;
    }
    return;
  }

  const workerCount = Math.min(config.execution.downloadConcurrency, queue.length);
  const pages = [basePage];

  for (let index = 1; index < workerCount; index++) {
    const page = await basePage.context().newPage();
    pages.push(page);
  }

  let nextIndex = 0;
  let fatalError: Error | null = null;

  await Promise.all(
    pages.map(async (initialPage, pageIndex) => {
      let page = initialPage;

      while (true) {
        if (fatalError) {
          break;
        }

        if (isShutdownRequested()) {
          break;
        }

        const currentIndex = nextIndex;
        nextIndex += 1;

        if (currentIndex >= queue.length) {
          break;
        }

        try {
          page = await processSingleRecord(
            page,
            queue[currentIndex],
            runId,
            logger
          );
          await onRecordProcessed(queue[currentIndex]);
        } catch (error) {
          fatalError =
            error instanceof Error ? error : new Error(String(error));
          break;
        }
      }

      if (pageIndex > 0) {
        await page.close().catch(() => undefined);
      }
    })
  );

  if (fatalError) {
    throw fatalError;
  }
}
