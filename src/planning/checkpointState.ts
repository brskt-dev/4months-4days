import {
  PlannedReportItem,
  PlanningCheckpoint,
  PlanningFailure,
  PlanningScopeResult,
  ScopePlanningSummary,
} from "../types";

const UNKNOWN_FORM = "UnknownForm";

function getPlanningSpecificity(
  item: Pick<
    PlannedReportItem,
    "formName" | "filterFormId" | "localName" | "filterLocalId"
  >
): number {
  const formScore =
    item.filterFormId && item.formName !== UNKNOWN_FORM ? 1_000 : 0;
  const localScore =
    (item.filterLocalId ? 1 : 0) + (item.localName.match(/>/g) ?? []).length;

  return formScore + localScore;
}

export function createEmptyPlanningCheckpoint(
  scopeSignature: string
): PlanningCheckpoint {
  return {
    version: 1,
    updatedAt: "",
    scopeSignature,
    completedScopeIds: [],
    plannedItems: [],
    planningFailures: [],
    scopeSummaries: [],
  };
}

export function mergePlanningScopeResult(
  uniqueItems: Map<string, PlannedReportItem>,
  planningFailures: PlanningFailure[],
  scopeSummaries: ScopePlanningSummary[],
  result: PlanningScopeResult
): void {
  planningFailures.push(...result.failures);
  scopeSummaries.push(result.summary);

  for (const item of result.items) {
    const existing = uniqueItems.get(item.reportId);
    if (existing) {
      const trace = item.filterTrace[0];
      if (!existing.filterTrace.some((entry) => entry.scopeId === trace.scopeId)) {
        existing.filterTrace.push(trace);
      }

      if (existing.plannedPath !== item.plannedPath) {
        result.summary.inconsistencies.push(
          `Report ${item.reportId} apareceu com destino divergente: ${existing.plannedPath} vs ${item.plannedPath}.`
        );

        if (getPlanningSpecificity(item) > getPlanningSpecificity(existing)) {
          item.filterTrace = existing.filterTrace;
          uniqueItems.set(item.reportId, item);
        }
      }

      continue;
    }

    uniqueItems.set(item.reportId, item);
  }
}
