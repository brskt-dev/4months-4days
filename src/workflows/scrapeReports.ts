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
import {
  getControlRecords,
  loadControlFile,
  saveControlFile,
} from "../storage/controlStore";
import {
  writePlanningArtifacts,
  writeRunArtifacts,
  writeSummaryArtifacts,
} from "../storage/runArtifacts";
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
  const page = await performLogin();
  let controlFile = await loadControlFile(config.paths.controlFile);
  let plannedItemCount = 0;
  let planningFailureCount = 0;
  let processedItemCount = 0;
  let scopeSummaries: ReturnType<typeof buildExecutionSummary>["filtersProcessed"] =
    [];
  let controlSaveQueue = Promise.resolve();
  let processedSinceLastSave = 0;

  const saveControlState = async (): Promise<void> => {
    const task = controlSaveQueue
      .catch(() => undefined)
      .then(() => saveControlFile(config.paths.controlFile, controlFile));

    controlSaveQueue = task.catch(() => undefined);
    await task;
  };

  try {
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
      artifactsDir: config.artifactsDir,
      concurrency: config.execution.downloadConcurrency,
      maxRetries: config.execution.maxRetries,
      resumeFromControl: config.execution.resumeFromControl,
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

      const planningResult = await planReportInventory(page, runId, logger);
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
    await logger.info("execution", "Fila de execucao preparada.", {
      plannedItems: plannedItemCount,
      planningFailures: planningFailureCount,
      queueSize: queue.length,
    });
    processedItemCount = queue.length;

    await processExecutionQueue(page, queue, runId, logger, async () => {
      processedSinceLastSave += 1;

      if (processedSinceLastSave >= 10) {
        processedSinceLastSave = 0;
        await saveControlState();
      }
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
    await closeBrowser(page);
  }
}
