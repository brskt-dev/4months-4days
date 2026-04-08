import { PlanningCheckpoint } from "../types";
import { nowIso } from "../utils/dates";
import {
  deleteFileIfExists,
  readJsonFile,
  writeJsonAtomic,
} from "../utils/filesystem";

const EMPTY_PLANNING_CHECKPOINT: PlanningCheckpoint = {
  version: 1,
  updatedAt: "",
  scopeSignature: "",
  completedScopeIds: [],
  plannedItems: [],
  planningFailures: [],
  scopeSummaries: [],
};

export async function loadPlanningCheckpoint(
  filePath: string
): Promise<PlanningCheckpoint> {
  return readJsonFile(filePath, EMPTY_PLANNING_CHECKPOINT);
}

export async function savePlanningCheckpoint(
  filePath: string,
  checkpoint: PlanningCheckpoint
): Promise<void> {
  checkpoint.updatedAt = nowIso();
  await writeJsonAtomic(filePath, checkpoint);
}

export async function clearPlanningCheckpoint(filePath: string): Promise<void> {
  await deleteFileIfExists(filePath);
}
