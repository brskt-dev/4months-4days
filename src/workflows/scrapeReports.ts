import { Page } from "playwright";
import { config } from "../config";
import { buildExecutionSummary } from "../execution/summary";
import {
  buildExecutionQueue,
  prepareControlRecordsForResume,
  processExecutionQueue,
  synchronizeControlState,
} from "../execution/reportExecutor";
import { RunLogger } from "../logging/runLogger";
import { closeBrowser, performLogin } from "../login";
import { planReportInventory } from "../planning/planner";
import { getShutdownSignal, isShutdownRequested } from "../runtime/shutdown";
import { goToReports } from "../reports";
import { prepareSharePointSession } from "../sharepoint/session";
import {
  getControlRecords,
  loadControlFile,
  appendControlRecordUpdates,
  saveControlFile,
} from "../storage/controlStore";
import {
  appendExecutionResultArtifacts,
  writeExecutionArtifacts,
  writePlanningArtifacts,
  writeRunArtifacts,
  writeSummaryArtifacts,
} from "../storage/runArtifacts";
import { ControlRecord } from "../types";
import { nowIso, buildRunId } from "../utils/dates";
import { ensureDir, fileExists } from "../utils/filesystem";
import { getRunDir } from "../utils/reportPaths";

const DOWNLOAD_RELEASE_POLL_MS = 5_000;

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function awaitDownloadExecutionRelease(
  logger: RunLogger
): Promise<boolean> {
  if (!config.execution.pauseBeforeDownloadExecution) {
    return true;
  }

  await logger.warn(
    "execution",
    "Execution state preparado. Aguardando liberacao manual antes de iniciar os downloads.",
    {
      releaseFile: config.paths.downloadExecutionReleaseFile,
    }
  );

  while (true) {
    if (isShutdownRequested()) {
      await logger.warn(
        "execution",
        "Shutdown solicitado enquanto a execucao aguardava liberacao manual para os downloads."
      );
      return false;
    }

    if (await fileExists(config.paths.downloadExecutionReleaseFile)) {
      await logger.info(
        "execution",
        "Liberacao manual detectada. Iniciando fila de downloads.",
        {
          releaseFile: config.paths.downloadExecutionReleaseFile,
        }
      );
      return true;
    }

    await sleep(DOWNLOAD_RELEASE_POLL_MS);
  }
}

export async function runReportScraping(): Promise<void> {
  const runId = buildRunId();
  const startedAt = nowIso();
  const runDir = getRunDir(runId);

  await ensureDir(runDir);

  const logger = new RunLogger(runId, runDir);
  let page: Page | null = null;
  let controlFile = await loadControlFile(config.paths.controlFile);
  let plannedItemCount = 0;
  let planningFailureCount = 0;
  let processedItemCount = 0;
  let scopeSummaries: ReturnType<typeof buildExecutionSummary>["filtersProcessed"] =
    [];
  let sharePointSession: Awaited<ReturnType<typeof prepareSharePointSession>> =
    null;
  let controlSaveQueue = Promise.resolve();

  const enqueueControlPersistence = async (
    taskFactory: () => Promise<void>
  ): Promise<void> => {
    const task = controlSaveQueue
      .catch(() => undefined)
      .then(taskFactory);

    controlSaveQueue = task.catch(() => undefined);
    await task;
  };

  const saveControlState = async (): Promise<void> =>
    enqueueControlPersistence(() =>
      saveControlFile(config.paths.controlFile, controlFile)
    );

  const appendExecutionState = async (
    records: ControlRecord[],
    outcomeType: "processed" | "skipped_before_queue"
  ): Promise<void> => {
    if (records.length === 0) {
      return;
    }

    await enqueueControlPersistence(async () => {
      await appendControlRecordUpdates(config.paths.controlFile, records);
      await appendExecutionResultArtifacts(runDir, runId, outcomeType, records);
    });
  };

  try {
    page = await performLogin();

    await writeRunArtifacts(runDir, {
      runId,
      startedAt,
      finishedAt: null,
      plannedItemCount: 0,
      processedItemCount: 0,
      planningFailures: 0,
      filtersProcessed: [],
    });

    await logger.info("startup", "Execucao iniciada.", {
      runId,
      downloadsDir: config.downloadsDir,
      downloadTempDir: config.downloadTempDir,
      artifactsDir: config.artifactsDir,
      concurrency: config.execution.downloadConcurrency,
      sharepointUploadConcurrency: config.execution.sharepointUploadConcurrency,
      maxRetries: config.execution.maxRetries,
      resumeFromControl: config.execution.resumeFromControl,
      deliveryMode: config.execution.deliveryMode,
    });

    let executionRecords;

    if (
      config.execution.resumeFromControl &&
      Object.keys(controlFile.records).length > 0
    ) {
      executionRecords = await prepareControlRecordsForResume(
        controlFile,
        runId,
        logger
      );
      plannedItemCount = executionRecords.length;
      planningFailureCount = 0;
      scopeSummaries = [];

      await logger.info(
        "resume",
        "Retomando execucao a partir do execution-state existente, sem refazer planejamento.",
        {
          records: executionRecords.length,
        }
      );
    } else {
      await goToReports(page);

      const planningResult = await planReportInventory(page, runId, logger, {
        knownReportIds:
          config.execution.extractionPlanFile ||
          config.execution.planningMode === "date-only-catchup"
          ? new Set(Object.keys(controlFile.records))
          : undefined,
      });
      await writePlanningArtifacts(
        runDir,
        planningResult.plannedItems,
        planningResult.planningFailures
      );

      plannedItemCount = planningResult.plannedItems.length;
      planningFailureCount = planningResult.planningFailures.length;
      scopeSummaries = planningResult.scopeSummaries;

      if (isShutdownRequested()) {
        await writePlanningArtifacts(
          runDir,
          planningResult.plannedItems,
          planningResult.planningFailures
        );
        await saveControlState();
        await logger.warn(
          "shutdown",
          "Shutdown gracioso solicitado durante o planning. Execucao sera encerrada antes da fila de download.",
          {
            signal: getShutdownSignal(),
            plannedItems: plannedItemCount,
            planningFailures: planningFailureCount,
          }
        );
        await writeRunArtifacts(runDir, {
          runId,
          startedAt,
          finishedAt: nowIso(),
          plannedItemCount,
          processedItemCount,
          planningFailures: planningFailureCount,
          filtersProcessed: scopeSummaries,
        });
        return;
      }

      executionRecords = await synchronizeControlState(
        controlFile,
        planningResult.plannedItems,
        runId,
        logger
      );
    }

    await saveControlState();

    const downloadReleaseGranted = await awaitDownloadExecutionRelease(logger);
    if (!downloadReleaseGranted) {
      await saveControlState();
      await writeRunArtifacts(runDir, {
        runId,
        startedAt,
        finishedAt: nowIso(),
        plannedItemCount,
        processedItemCount,
        planningFailures: planningFailureCount,
        filtersProcessed: scopeSummaries,
      });
      return;
    }

    const queue = await buildExecutionQueue(executionRecords, runId, logger);
    const queuedReportIds = new Set(queue.map((record) => record.reportId));
    const skippedBeforeQueue = executionRecords.filter(
      (record) =>
        record.lastPlannedRunId === runId &&
        !queuedReportIds.has(record.reportId)
    );

    await appendExecutionState(skippedBeforeQueue, "skipped_before_queue");

    await logger.info("execution", "Fila de execucao preparada.", {
      plannedItems: plannedItemCount,
      planningFailures: planningFailureCount,
      queueSize: queue.length,
      skippedBeforeQueue: skippedBeforeQueue.length,
      workerCount: Math.min(config.execution.downloadConcurrency, queue.length),
      sharepointUploadWorkers:
        config.execution.deliveryMode === "sharepoint-session-rest"
          ? Math.min(config.execution.sharepointUploadConcurrency, queue.length)
          : 0,
    });
    processedItemCount = queue.length;

    sharePointSession = await prepareSharePointSession(page, logger);
    if (
      config.execution.deliveryMode === "sharepoint-session-rest" &&
      !sharePointSession
    ) {
      await saveControlState();
      await writeRunArtifacts(runDir, {
        runId,
        startedAt,
        finishedAt: nowIso(),
        plannedItemCount,
        processedItemCount,
        planningFailures: planningFailureCount,
        filtersProcessed: scopeSummaries,
      });
      return;
    }

    await processExecutionQueue(page, queue, runId, logger, async (record) => {
      await appendExecutionState([record], "processed");
    }, {
      sharePointClient: sharePointSession?.client,
    });

    await saveControlState();

    if (isShutdownRequested()) {
      await logger.warn(
        "shutdown",
        "Shutdown gracioso concluido apos finalizar os itens em andamento.",
        {
          signal: getShutdownSignal(),
        }
      );
    }

    const finishedAt = nowIso();
    const summary = buildExecutionSummary(
      runId,
      startedAt,
      finishedAt,
      getControlRecords(controlFile),
      scopeSummaries
    );

    await writeRunArtifacts(runDir, {
      runId,
      startedAt,
      finishedAt,
      plannedItemCount,
      processedItemCount,
      planningFailures: planningFailureCount,
      filtersProcessed: scopeSummaries,
    });
    await writeExecutionArtifacts(runDir, runId, getControlRecords(controlFile));
    await writeSummaryArtifacts(runDir, summary);

    await logger.info("finish", "Execucao concluida.", {
      totalReportsIdentified: summary.totalReportsIdentified,
      totalValidated: summary.totalValidated,
      totalFailures: summary.totalFailures,
      totalPendingRetry: summary.totalPendingRetry,
    });
  } catch (error) {
    const finishedAt = nowIso();

    await saveControlState();
    await writeExecutionArtifacts(runDir, runId, getControlRecords(controlFile)).catch(
      () => undefined
    );
    await writeRunArtifacts(runDir, {
      runId,
      startedAt,
      finishedAt,
      plannedItemCount,
      processedItemCount,
      planningFailures: planningFailureCount,
      filtersProcessed: scopeSummaries,
    });
    await logger.error(
      "finish",
      "Execucao encerrada com falha.",
      {
        error: error instanceof Error ? error.stack ?? error.message : String(error),
      }
    );
    throw error;
  } finally {
    await sharePointSession?.close().catch(() => undefined);
    await closeBrowser(page);
  }
}
