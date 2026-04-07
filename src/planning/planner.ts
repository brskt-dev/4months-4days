import { Page } from "playwright";
import { config } from "../config";
import { closeOnboardingPopup } from "../helpers/closePopup";
import { RunLogger } from "../logging/runLogger";
import {
  applyFilters,
  extractFormTypes,
  extractResourcePlaces,
  extractRawRowsFromCurrentPage,
  extractTotalReports,
} from "../reports";
import {
  ExtractionPlanFile,
  ExtractionScope,
  FormType,
  PlannedReportItem,
  PlanningFailure,
  ReportTotals,
  ResourcePlace,
  ScopePlanningSummary,
} from "../types";
import { mapWithConcurrency } from "../utils/concurrency";
import { nowIso } from "../utils/dates";
import { fileExists, readJsonFile } from "../utils/filesystem";
import {
  extractAssetNameFromRow,
  extractExportButtonId,
  extractFormNameFromRow,
  extractReportDateFromRow,
  extractReportIdFromRow,
} from "../utils/reportMetadata";
import { buildPlannedPath } from "../utils/reportPaths";
import { withPage } from "../utils/reportUrls";
import { buildScopeId } from "../utils/sanitize";

const UNKNOWN_YEAR = "UnknownYear";
const UNKNOWN_FORM = "UnknownForm";
const EXTRA_ORPHAN_PREFIX = ["Extra"];

function buildUnknownDateInfo() {
  return {
    raw: "",
    iso: "",
    year: UNKNOWN_YEAR,
  };
}

function getPlanningSpecificity(
  item: Pick<PlannedReportItem, "formName" | "filterFormId" | "localName" | "filterLocalId">
): number {
  const formScore =
    item.filterFormId && item.formName !== UNKNOWN_FORM ? 1_000 : 0;
  const localScore =
    (item.filterLocalId ? 1 : 0) + (item.localName.match(/>/g) ?? []).length;

  return formScore + localScore;
}

function buildScopeLabel(scope: Partial<ExtractionScope>): string {
  const form = scope.formName ?? scope.formId ?? "all-forms";
  const local = scope.localName ?? scope.localId ?? "all-locals";
  const period = `${scope.startDate ?? config.reports.defaultStartDate}_${scope.endDate ?? config.reports.defaultEndDate}`;
  return `${form}__${local}__${period}`;
}

function normalizeScope(
  scope: Partial<ExtractionScope>,
  index: number,
  formsById: Map<string, FormType>,
  resourcePlacesById: Map<string, ResourcePlace>
): ExtractionScope {
  const formName =
    scope.formName ??
    (scope.formId ? formsById.get(scope.formId)?.name ?? null : null);
  const localName =
    scope.localName ??
    (scope.localId ? resourcePlacesById.get(scope.localId)?.name ?? null : null);

  const scopeLabel =
    scope.scopeLabel?.trim() ||
    buildScopeLabel({
      ...scope,
      formName,
      localName,
    });

  return {
    scopeId:
      scope.scopeId ??
      buildScopeId(
        `scope-${index + 1}`,
        scope.formId ?? formName ?? "all-forms",
        scope.localId ?? scope.localName ?? "all-locals",
        scope.assetId ?? scope.assetName ?? "all-assets"
      ),
    scopeLabel,
    formId: scope.formId ?? null,
    formName: formName ?? null,
    localId: scope.localId ?? null,
    localName: localName ?? null,
    assetId: scope.assetId ?? null,
    assetName: scope.assetName ?? null,
    startDate: scope.startDate ?? config.reports.defaultStartDate,
    endDate: scope.endDate ?? config.reports.defaultEndDate,
    extraQueryParams: scope.extraQueryParams,
  };
}

async function resolveExtractionScopes(
  page: Page,
  logger: RunLogger
): Promise<ExtractionScope[]> {
  const discoveredForms = await extractFormTypes(page);
  const discoveredResourcePlaces = await extractResourcePlaces(page);
  const formsById = new Map(discoveredForms.map((form) => [form.id, form]));
  const resourcePlacesById = new Map(
    discoveredResourcePlaces.map((resourcePlace) => [resourcePlace.id, resourcePlace])
  );

  if (
    config.execution.extractionPlanFile &&
    (await fileExists(config.execution.extractionPlanFile))
  ) {
    const planFile = await readJsonFile<ExtractionPlanFile>(
      config.execution.extractionPlanFile,
      { scopes: [] }
    );

    const scopes = planFile.scopes.map((scope, index) =>
      normalizeScope(scope, index, formsById, resourcePlacesById)
    );

    await logger.info("planning", "Plano de extracao carregado do arquivo.", {
      extractionPlanFile: config.execution.extractionPlanFile,
      scopes: scopes.length,
    });

    return scopes;
  }

  const autoScopeInputs =
    discoveredResourcePlaces.length > 0
      ? discoveredForms.flatMap((form) =>
          discoveredResourcePlaces.map((resourcePlace) => ({
            formId: form.id,
            formName: form.name,
            localId: resourcePlace.id,
            localName: resourcePlace.name,
            startDate: config.reports.defaultStartDate,
            endDate: config.reports.defaultEndDate,
          }))
        )
      : discoveredForms.map((form) => ({
          formId: form.id,
          formName: form.name,
          startDate: config.reports.defaultStartDate,
          endDate: config.reports.defaultEndDate,
        }));

  const autoScopes = autoScopeInputs.map((scope, index) =>
    normalizeScope(scope, index, formsById, resourcePlacesById)
  );

  await logger.info(
    "planning",
    "Nenhum plano externo encontrado. Usando descoberta automatica por formulario e resource_place.",
    {
      scopes: autoScopes.length,
      forms: discoveredForms.length,
      resourcePlaces: discoveredResourcePlaces.length,
    }
  );

  return autoScopes;
}

function buildOrphanRecoveryScopes(scopes: ExtractionScope[]): ExtractionScope[] {
  if (scopes.length === 0) {
    return [];
  }

  const periodKey = `${config.reports.defaultStartDate}_${config.reports.defaultEndDate}`;
  const uniqueLocals = new Map<string, Pick<ExtractionScope, "localId" | "localName">>();

  for (const scope of scopes) {
    if (!scope.localId && !scope.localName) {
      continue;
    }

    const key = scope.localId ?? scope.localName ?? "all-locals";
    if (!uniqueLocals.has(key)) {
      uniqueLocals.set(key, {
        localId: scope.localId ?? null,
        localName: scope.localName ?? null,
      });
    }
  }

  const localScopes = [...uniqueLocals.values()].map((localScope, index) => ({
    scopeId: buildScopeId(
      "extra-orphan-scope",
      localScope.localId ?? localScope.localName ?? `local-${index + 1}`,
      periodKey
    ),
    scopeLabel: `Extra__${UNKNOWN_FORM}__${localScope.localName ?? localScope.localId ?? "all-locals"}__${periodKey}`,
    formId: null,
    formName: UNKNOWN_FORM,
    localId: localScope.localId ?? null,
    localName: localScope.localName ?? null,
    assetId: null,
    assetName: null,
    startDate: config.reports.defaultStartDate,
    endDate: config.reports.defaultEndDate,
  }));

  if (localScopes.length > 0) {
    return localScopes;
  }

  return [
    {
      scopeId: buildScopeId("extra-orphan-scope", "all-locals", periodKey),
      scopeLabel: `Extra__${UNKNOWN_FORM}__all-locals__${periodKey}`,
      formId: null,
      formName: UNKNOWN_FORM,
      localId: null,
      localName: null,
      assetId: null,
      assetName: null,
      startDate: config.reports.defaultStartDate,
      endDate: config.reports.defaultEndDate,
    },
  ];
}

function buildScopeLocalKey(
  scope: Pick<ExtractionScope, "localId" | "localName">
): string {
  return scope.localId ?? scope.localName ?? "all-locals";
}

function buildItemLocalKey(
  item: Pick<PlannedReportItem, "filterLocalId" | "localName">
): string {
  return item.filterLocalId ?? item.localName ?? "all-locals";
}

function buildPageRanges(
  totalPages: number,
  maxWorkers: number
): Array<{ start: number; end: number }> {
  const workerCount = Math.max(1, Math.min(maxWorkers, totalPages));
  const pagesPerWorker = Math.ceil(totalPages / workerCount);
  const ranges: Array<{ start: number; end: number }> = [];

  for (let start = 1; start <= totalPages; start += pagesPerWorker) {
    ranges.push({
      start,
      end: Math.min(totalPages, start + pagesPerWorker - 1),
    });
  }

  return ranges;
}

async function inspectScopeTotals(
  page: Page,
  scope: ExtractionScope
): Promise<{
  sourceUrl: string;
  totals: Awaited<ReturnType<typeof extractTotalReports>>;
}> {
  const sourceUrl = await applyFilters(page, {
    formId: scope.formId,
    localId: scope.localId,
    assetId: scope.assetId,
    startDate: scope.startDate,
    endDate: scope.endDate,
    extraQueryParams: scope.extraQueryParams,
  });

  await closeOnboardingPopup(page);

  return {
    sourceUrl,
    totals: await extractTotalReports(page),
  };
}

async function processScopePlanning(
  page: Page,
  scope: ExtractionScope,
  runId: string,
  logger: RunLogger,
  options?: {
    plannedPathPrefixSegments?: string[];
    knownReportIds?: Set<string>;
    stopAfterNewItemsCount?: number;
    pageRange?: {
      start: number;
      end: number;
    };
    precomputedSourceUrl?: string;
    precomputedTotals?: ReportTotals;
  }
): Promise<{
  items: PlannedReportItem[];
  failures: PlanningFailure[];
  summary: ScopePlanningSummary;
}> {
  await logger.info("planning", "Aplicando escopo de planejamento.", {
    scopeId: scope.scopeId,
    scopeLabel: scope.scopeLabel,
    pageRange: options?.pageRange ?? null,
  });

  const sourceUrl =
    options?.precomputedSourceUrl ??
    (await applyFilters(page, {
      formId: scope.formId,
      localId: scope.localId,
      assetId: scope.assetId,
      startDate: scope.startDate,
      endDate: scope.endDate,
      extraQueryParams: scope.extraQueryParams,
    }));

  await closeOnboardingPopup(page);

  const totals = options?.precomputedTotals ?? (await extractTotalReports(page));
  let extractedRows = 0;
  const inconsistencies: string[] = [];
  const items: PlannedReportItem[] = [];
  const failures: PlanningFailure[] = [];
  let stopEarly = false;
  const startPage = options?.pageRange?.start ?? 1;
  const endPage = options?.pageRange?.end ?? totals.totalPages;

  for (let pageIndex = startPage; pageIndex <= endPage && !stopEarly; pageIndex++) {
    const pageUrl = withPage(sourceUrl, pageIndex);
    await page.goto(pageUrl, { waitUntil: "networkidle" });
    await closeOnboardingPopup(page);

    const rows = await extractRawRowsFromCurrentPage(page);
    extractedRows += rows.length;

    for (const row of rows) {
      const reportId = extractReportIdFromRow(row);
      const reportDateInfo = extractReportDateFromRow(row) ?? buildUnknownDateInfo();

      if (!reportId) {
        failures.push({
          scopeId: scope.scopeId,
          sourcePage: pageIndex,
          sourceRowIndex: row.rowIndex,
          rowText: row.rowText,
          reason: "Nao foi possivel identificar o report_id da linha.",
          discoveredAt: nowIso(),
        });
        continue;
      }

      if (options?.knownReportIds?.has(reportId)) {
        continue;
      }

      const formName =
        scope.formName ??
        extractFormNameFromRow(row) ??
        scope.formId ??
        "UnknownForm";
      const localName =
        scope.localName ??
        scope.localId ??
        "UnknownLocal";
      const assetName =
        extractAssetNameFromRow(row) ?? scope.assetName ?? scope.assetId ?? null;
      const plannedPath = buildPlannedPath(
        formName,
        localName,
        reportDateInfo.year,
        reportId,
        options?.plannedPathPrefixSegments
      );
      const filterTrace = {
        scopeId: scope.scopeId,
        scopeLabel: scope.scopeLabel,
        formId: scope.formId ?? null,
        localId: scope.localId ?? null,
        assetId: scope.assetId ?? null,
        startDate: scope.startDate,
        endDate: scope.endDate,
        sourceUrl: pageUrl,
      };

      items.push({
        reportId,
        formName,
        localName,
        assetName,
        reportDate: reportDateInfo.iso,
        reportDateRaw: reportDateInfo.raw,
        year: reportDateInfo.year,
        sourcePage: pageIndex,
        sourceRowIndex: row.rowIndex,
        sourceUrl: pageUrl,
        exportButtonId: extractExportButtonId(row),
        rowText: row.rowText,
        rowHtml: row.rowHtml,
        rowDataset: row.rowDataset,
        filterFormId: scope.formId ?? null,
        filterLocalId: scope.localId ?? null,
        filterAssetId: scope.assetId ?? null,
        filterStartDate: scope.startDate,
        filterEndDate: scope.endDate,
        plannedFolder: plannedPath.folder,
        plannedFilename: plannedPath.filename,
        plannedPath: plannedPath.fullPath,
        discoveredAt: nowIso(),
        discoveredInRunId: runId,
        filterTrace: [filterTrace],
      });

      if (
        options?.stopAfterNewItemsCount &&
        items.length >= options.stopAfterNewItemsCount
      ) {
        stopEarly = true;
        break;
      }
    }
  }

  if (stopEarly) {
    inconsistencies.push(
      `Leitura encerrada antecipadamente apos identificar ${items.length} itens extras esperados para o escopo.`
    );
  }

  if (!options?.pageRange && totals.totalReports !== extractedRows) {
    inconsistencies.push(
      `Esperado ${totals.totalReports} itens, mas ${extractedRows} linhas foram extraidas.`
    );
  }

  return {
    items,
    failures,
    summary: {
      scopeId: scope.scopeId,
      scopeLabel: scope.scopeLabel,
      sourceUrl,
      expectedTotalReports: totals.totalReports,
      extractedRows,
      totalPages: totals.totalPages,
      reportsPerPage: totals.reportsPerPage,
      lastPageCount: totals.lastPageCount,
      inconsistencies,
    },
  };
}

export async function planReportInventory(
  page: Page,
  runId: string,
  logger: RunLogger
): Promise<{
  scopes: ExtractionScope[];
  plannedItems: PlannedReportItem[];
  planningFailures: PlanningFailure[];
  scopeSummaries: ScopePlanningSummary[];
}> {
  const scopes = await resolveExtractionScopes(page, logger);
  const usingExternalPlan =
    Boolean(config.execution.extractionPlanFile) &&
    (await fileExists(config.execution.extractionPlanFile));
  const uniqueItems = new Map<string, PlannedReportItem>();
  const planningFailures: PlanningFailure[] = [];
  const scopeSummaries: ScopePlanningSummary[] = [];
  const planningConcurrency = Math.min(
    scopes.length || 1,
    config.execution.planningConcurrency
  );

  await logger.info("planning", "Iniciando processamento paralelo dos escopos.", {
    scopes: scopes.length,
    planningConcurrency,
  });

  const scopeResults = await mapWithConcurrency(
    scopes,
    planningConcurrency,
    async (scope) => {
      const scopePage = await page.context().newPage();

      try {
        return await processScopePlanning(scopePage, scope, runId, logger);
      } finally {
        await scopePage.close().catch(() => undefined);
      }
    }
  );

  for (const result of scopeResults) {
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

  if (!usingExternalPlan) {
    const orphanRecoveryScopes = buildOrphanRecoveryScopes(scopes);
    const primaryCountsByLocalKey = new Map<string, number>();

    for (const item of uniqueItems.values()) {
      const localKey = buildItemLocalKey(item);
      primaryCountsByLocalKey.set(
        localKey,
        (primaryCountsByLocalKey.get(localKey) ?? 0) + 1
      );
    }

    await logger.info(
      "planning",
      "Inspecionando diferencas por local para o passe extra de relatorios sem tipo de formulario vinculado.",
      { orphanRecoveryScopes: orphanRecoveryScopes.length }
    );

    const orphanInspections = await mapWithConcurrency(
      orphanRecoveryScopes,
      planningConcurrency,
      async (scope) => {
        const scopePage = await page.context().newPage();

        try {
          const inspection = await inspectScopeTotals(scopePage, scope);
          const localKey = buildScopeLocalKey(scope);
          const primaryCount = primaryCountsByLocalKey.get(localKey) ?? 0;
          const expectedOrphanCount = Math.max(
            0,
            inspection.totals.totalReports - primaryCount
          );

          await logger.info(
            "planning",
            "Auditoria por local do passe extra.",
            {
              scopeId: scope.scopeId,
              scopeLabel: scope.scopeLabel,
              localId: scope.localId ?? null,
              localName: scope.localName ?? null,
              totalWithoutFormFilter: inspection.totals.totalReports,
              totalWithFormFilter: primaryCount,
              expectedOrphanCount,
            }
          );

          return {
            scope,
            sourceUrl: inspection.sourceUrl,
            totals: inspection.totals,
            primaryCount,
            expectedOrphanCount,
          };
        } finally {
          await scopePage.close().catch(() => undefined);
        }
      }
    );

    const orphanScopesToScan = orphanInspections.filter(
      (inspection) => inspection.expectedOrphanCount > 0
    );

    await logger.info(
      "planning",
      "Passe extra reduzido aos locais com divergencia real.",
      {
        inspectedScopes: orphanInspections.length,
        scopesWithDifference: orphanScopesToScan.length,
        expectedOrphanReports: orphanScopesToScan.reduce(
          (total, inspection) => total + inspection.expectedOrphanCount,
          0
        ),
      }
    );

    const orphanKnownReportIds = new Set(uniqueItems.keys());
    const orphanResults = await mapWithConcurrency(
      orphanScopesToScan,
      planningConcurrency,
      async (inspection) => {
        if (inspection.totals.totalPages <= 1) {
          const scopePage = await page.context().newPage();

          try {
            return await processScopePlanning(
              scopePage,
              inspection.scope,
              runId,
              logger,
              {
                plannedPathPrefixSegments: EXTRA_ORPHAN_PREFIX,
                knownReportIds: orphanKnownReportIds,
                stopAfterNewItemsCount: inspection.expectedOrphanCount,
                precomputedSourceUrl: inspection.sourceUrl,
                precomputedTotals: inspection.totals,
              }
            );
          } finally {
            await scopePage.close().catch(() => undefined);
          }
        }

        const pageRanges = buildPageRanges(
          inspection.totals.totalPages,
          planningConcurrency
        );

        await logger.info(
          "planning",
          "Passe extra sera processado em faixas paralelas.",
          {
            scopeId: inspection.scope.scopeId,
            totalPages: inspection.totals.totalPages,
            pageRanges: pageRanges.length,
          }
        );

        const chunkResults = await mapWithConcurrency(
          pageRanges,
          planningConcurrency,
          async (pageRange) => {
            const chunkPage = await page.context().newPage();

            try {
              return await processScopePlanning(
                chunkPage,
                inspection.scope,
                runId,
                logger,
                {
                  plannedPathPrefixSegments: EXTRA_ORPHAN_PREFIX,
                  knownReportIds: orphanKnownReportIds,
                  pageRange,
                  precomputedSourceUrl: inspection.sourceUrl,
                  precomputedTotals: inspection.totals,
                }
              );
            } finally {
              await chunkPage.close().catch(() => undefined);
            }
          }
        );

        return {
          items: chunkResults.flatMap((chunk) => chunk.items),
          failures: chunkResults.flatMap((chunk) => chunk.failures),
          summary: {
            scopeId: inspection.scope.scopeId,
            scopeLabel: inspection.scope.scopeLabel,
            sourceUrl: inspection.sourceUrl,
            expectedTotalReports: inspection.totals.totalReports,
            extractedRows: chunkResults.reduce(
              (total, chunk) => total + chunk.summary.extractedRows,
              0
            ),
            totalPages: inspection.totals.totalPages,
            reportsPerPage: inspection.totals.reportsPerPage,
            lastPageCount: inspection.totals.lastPageCount,
            inconsistencies: chunkResults.flatMap(
              (chunk) => chunk.summary.inconsistencies
            ),
          },
        };
      }
    );

    for (const result of orphanResults) {
      planningFailures.push(...result.failures);
      scopeSummaries.push(result.summary);

      for (const item of result.items) {
        const existing = uniqueItems.get(item.reportId);
        if (existing) {
          const trace = item.filterTrace[0];
          if (!existing.filterTrace.some((entry) => entry.scopeId === trace.scopeId)) {
            existing.filterTrace.push(trace);
          }

          continue;
        }

        uniqueItems.set(item.reportId, item);
      }
    }
  }

  return {
    scopes,
    plannedItems: [...uniqueItems.values()].sort((left, right) =>
      left.reportId.localeCompare(right.reportId)
    ),
    planningFailures,
    scopeSummaries,
  };
}
