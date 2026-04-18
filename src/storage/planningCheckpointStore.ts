import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import {
  createEmptyPlanningCheckpoint,
  mergePlanningScopeResult,
} from "../planning/checkpointState";
import { nowIso } from "../utils/dates";
import {
  deleteFileIfExists,
  ensureDir,
  fileExists,
  readJsonFile,
  writeJsonAtomic,
} from "../utils/filesystem";
import {
  PlannedReportItem,
  PlanningCheckpoint,
  PlanningFailure,
  PlanningScopeResult,
  ScopePlanningSummary,
} from "../types";

type PersistedPlanningCheckpointMeta = {
  version: number;
  updatedAt: string;
  scopeSignature: string;
  format: "segmented-v2";
};

type PersistedPlanningCheckpointLogEntry = {
  type: "scope-result";
  scopeId: string;
  result: PlanningScopeResult;
};

type PlanningCheckpointPaths = {
  manifestFile: string;
  completedScopesFile: string;
  plannedItemsFile: string;
  planningFailuresFile: string;
  scopeSummariesFile: string;
  logFile: string;
};

function getPlanningCheckpointPaths(filePath: string): PlanningCheckpointPaths {
  const parsed = path.parse(filePath);
  const prefix = path.join(parsed.dir, parsed.name);

  return {
    manifestFile: filePath,
    completedScopesFile: `${prefix}.completed-scopes.ndjson`,
    plannedItemsFile: `${prefix}.planned-items.ndjson`,
    planningFailuresFile: `${prefix}.planning-failures.ndjson`,
    scopeSummariesFile: `${prefix}.scope-summaries.ndjson`,
    logFile: `${prefix}.log.ndjson`,
  };
}

function buildPersistedMeta(
  checkpoint: Pick<PlanningCheckpoint, "version" | "scopeSignature">
): PersistedPlanningCheckpointMeta {
  return {
    version: checkpoint.version,
    updatedAt: nowIso(),
    scopeSignature: checkpoint.scopeSignature,
    format: "segmented-v2",
  };
}

function isPersistedPlanningCheckpointMeta(
  value: unknown
): value is PersistedPlanningCheckpointMeta {
  if (!value || typeof value !== "object") {
    return false;
  }

  return (
    "format" in value &&
    (value as PersistedPlanningCheckpointMeta).format === "segmented-v2"
  );
}

async function writeNdjsonAtomic<T>(
  filePath: string,
  values: Iterable<T>
): Promise<void> {
  await ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random()
    .toString(16)
    .slice(2)}.tmp`;
  const handle = await fs.promises.open(tempPath, "w");

  try {
    for (const value of values) {
      await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    }
  } finally {
    await handle.close();
  }

  try {
    await fs.promises.copyFile(tempPath, filePath);
  } finally {
    await fs.promises.unlink(tempPath).catch(() => undefined);
  }
}

async function appendNdjsonLine<T>(filePath: string, value: T): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await fs.promises.appendFile(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

async function readNdjsonFile<T>(filePath: string): Promise<T[]> {
  if (!(await fileExists(filePath))) {
    return [];
  }

  const values: T[] = [];
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

      values.push(JSON.parse(trimmedLine) as T);
    }
  } finally {
    lineReader.close();
    stream.close();
  }

  return values;
}

async function loadSegmentedPlanningCheckpoint(
  paths: PlanningCheckpointPaths,
  meta: PersistedPlanningCheckpointMeta
): Promise<PlanningCheckpoint> {
  const completedScopeIds = new Set(
    await readNdjsonFile<string>(paths.completedScopesFile)
  );
  const planningFailures = await readNdjsonFile<PlanningFailure>(
    paths.planningFailuresFile
  );
  const scopeSummaries = await readNdjsonFile<ScopePlanningSummary>(
    paths.scopeSummariesFile
  );
  const uniqueItems = new Map(
    (
      await readNdjsonFile<PlannedReportItem>(paths.plannedItemsFile)
    ).map((item) => [item.reportId, item] as const)
  );
  const logEntries = await readNdjsonFile<PersistedPlanningCheckpointLogEntry>(
    paths.logFile
  );

  for (const entry of logEntries) {
    if (entry.type !== "scope-result") {
      continue;
    }

    completedScopeIds.add(entry.scopeId);
    mergePlanningScopeResult(
      uniqueItems,
      planningFailures,
      scopeSummaries,
      entry.result
    );
  }

  return {
    version: meta.version,
    updatedAt: meta.updatedAt,
    scopeSignature: meta.scopeSignature,
    completedScopeIds: [...completedScopeIds],
    plannedItems: [...uniqueItems.values()],
    planningFailures,
    scopeSummaries,
  };
}

export async function loadPlanningCheckpoint(
  filePath: string
): Promise<PlanningCheckpoint> {
  if (!(await fileExists(filePath))) {
    return createEmptyPlanningCheckpoint("");
  }

  const rawCheckpoint = await readJsonFile<
    PlanningCheckpoint | PersistedPlanningCheckpointMeta
  >(filePath, createEmptyPlanningCheckpoint(""));

  if (isPersistedPlanningCheckpointMeta(rawCheckpoint)) {
    return loadSegmentedPlanningCheckpoint(
      getPlanningCheckpointPaths(filePath),
      rawCheckpoint
    );
  }

  return rawCheckpoint;
}

export async function replacePlanningCheckpoint(
  filePath: string,
  checkpoint: PlanningCheckpoint
): Promise<void> {
  const paths = getPlanningCheckpointPaths(filePath);

  await writeNdjsonAtomic(paths.completedScopesFile, checkpoint.completedScopeIds);
  await writeNdjsonAtomic(paths.plannedItemsFile, checkpoint.plannedItems);
  await writeNdjsonAtomic(
    paths.planningFailuresFile,
    checkpoint.planningFailures
  );
  await writeNdjsonAtomic(paths.scopeSummariesFile, checkpoint.scopeSummaries);
  await writeNdjsonAtomic(paths.logFile, []);
  await writeJsonAtomic(paths.manifestFile, buildPersistedMeta(checkpoint));
}

export async function appendPlanningCheckpointResult(
  filePath: string,
  scopeSignature: string,
  scopeId: string,
  result: PlanningScopeResult
): Promise<void> {
  const paths = getPlanningCheckpointPaths(filePath);

  await appendNdjsonLine(paths.logFile, {
    type: "scope-result",
    scopeId,
    result,
  } satisfies PersistedPlanningCheckpointLogEntry);

  await writeJsonAtomic(paths.manifestFile, {
    version: 1,
    updatedAt: nowIso(),
    scopeSignature,
    format: "segmented-v2",
  } satisfies PersistedPlanningCheckpointMeta);
}

export async function clearPlanningCheckpoint(filePath: string): Promise<void> {
  const paths = getPlanningCheckpointPaths(filePath);

  await deleteFileIfExists(paths.manifestFile);
  await deleteFileIfExists(paths.completedScopesFile);
  await deleteFileIfExists(paths.plannedItemsFile);
  await deleteFileIfExists(paths.planningFailuresFile);
  await deleteFileIfExists(paths.scopeSummariesFile);
  await deleteFileIfExists(paths.logFile);
}
