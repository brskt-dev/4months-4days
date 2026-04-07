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
import { ensureDir } from "../utils/filesystem";
import { getRunDir } from "../utils/reportPaths";

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

      executionRecords = await synchronizeControlState(
        controlFile,
        planningResult.plannedItems,
        runId,
        logger
      );
    }

    await saveControlState();

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
