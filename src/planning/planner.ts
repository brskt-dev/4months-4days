import { Page } from "playwright";
import { config } from "../config";
import { closeOnboardingPopup } from "../helpers/closePopup";
import { RunLogger } from "../logging/runLogger";
import {
  createEmptyPlanningCheckpoint,
  mergePlanningScopeResult,
} from "../planning/checkpointState";
import { isShutdownRequested } from "../runtime/shutdown";
import {
  applyFilters,
  extractFormTypes,
  extractPlanningPagination,
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
  PlanningScopeResult,
  ReportTotals,
  ResourcePlace,
  ScopePlanningSummary,
} from "../types";
import {
  appendPlanningCheckpointResult,
  clearPlanningCheckpoint,
  loadPlanningCheckpoint,
  replacePlanningCheckpoint,
} from "../storage/planningCheckpointStore";
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
const UNKNOWN_LOCAL = "UnknownLocal";
const UNKNOWN_CATCHUP = "UnknownCatchup";
const EXTRA_ORPHAN_PREFIX = ["Extra"];
const EXTRA_PLANNING_RELEASE_POLL_MS = 5_000;

function buildUnknownDateInfo() {
  return {
    raw: "",
    iso: "",
    year: UNKNOWN_YEAR,
  };
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
    pageRange: scope.pageRange,
  };
}

async function resolveExtractionScopes(
  page: Page,
  logger: RunLogger
): Promise<ExtractionScope[]> {
  if (config.execution.planningMode === "date-only-catchup") {
    const periodKey = `${config.reports.defaultStartDate}_${config.reports.defaultEndDate}`;
    const scope: ExtractionScope = {
      scopeId: buildScopeId("date-only-catchup-scope", periodKey),
      scopeLabel: `${UNKNOWN_CATCHUP}__${UNKNOWN_CATCHUP}__${periodKey}`,
      formId: null,
      formName: UNKNOWN_CATCHUP,
      localId: null,
      localName: UNKNOWN_CATCHUP,
      assetId: null,
      assetName: null,
      startDate: config.reports.defaultStartDate,
      endDate: config.reports.defaultEndDate,
    };

    await logger.info(
      "planning",
      "Modo de planning por data habilitado. A listagem global sera varrida sem filtros de formulario ou local.",
      {
        scopeId: scope.scopeId,
        startDate: scope.startDate,
        endDate: scope.endDate,
      }
    );

    return [scope];
  }

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

function isExtraOrphanScope(
  scope: Pick<ExtractionScope, "scopeId">
): boolean {
  return scope.scopeId.startsWith("extra-orphan-scope__");
}

function isExtraUnknownLocalScope(
  scope: Pick<ExtractionScope, "scopeId">
): boolean {
  return scope.scopeId.startsWith("extra-unknown-local-scope__");
}

function buildScopeSignature(scopes: ExtractionScope[]): string {
  return JSON.stringify(
    scopes.map((scope) => ({
      scopeId: scope.scopeId,
      scopeLabel: scope.scopeLabel,
      formId: scope.formId ?? null,
      localId: scope.localId ?? null,
      assetId: scope.assetId ?? null,
      startDate: scope.startDate,
      endDate: scope.endDate,
      extraQueryParams: scope.extraQueryParams ?? null,
      pageRange: scope.pageRange ?? null,
    }))
  );
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function appendAll<T>(target: T[], source: readonly T[]): void {
  for (const item of source) {
    target.push(item);
  }
}

async function awaitExtraPlanningRelease(logger: RunLogger): Promise<boolean> {
  if (!config.execution.pauseBeforeExtraPlanning) {
    return true;
  }

  await logger.warn(
    "planning",
    "Planning principal concluido. Aguardando liberacao manual antes de iniciar os passes extras.",
    {
      releaseFile: config.paths.extraPlanningReleaseFile,
    }
  );

  while (true) {
    if (isShutdownRequested()) {
      await logger.warn(
        "planning",
        "Shutdown solicitado enquanto o planning aguardava liberacao manual para os passes extras."
      );
      return false;
    }

    if (await fileExists(config.paths.extraPlanningReleaseFile)) {
      await logger.info(
        "planning",
        "Liberacao manual detectada. Iniciando os passes extras.",
        {
          releaseFile: config.paths.extraPlanningReleaseFile,
        }
      );
      return true;
    }

    await sleep(EXTRA_PLANNING_RELEASE_POLL_MS);
  }
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

function buildUnknownLocalRecoveryScope(): ExtractionScope {
  const periodKey = `${config.reports.defaultStartDate}_${config.reports.defaultEndDate}`;

  return {
    scopeId: buildScopeId("extra-unknown-local-scope", periodKey),
    scopeLabel: `Extra__all-forms__${UNKNOWN_LOCAL}__${periodKey}`,
    formId: null,
    formName: null,
    localId: null,
    localName: UNKNOWN_LOCAL,
    assetId: null,
    assetName: null,
    startDate: config.reports.defaultStartDate,
    endDate: config.reports.defaultEndDate,
  };
}

function buildDateOnlyCatchupScopes(
  scope: ExtractionScope,
  totalPages: number
): ExtractionScope[] {
  const pageRanges = buildPageRanges(
    totalPages,
    config.execution.planningConcurrency
  );

  return pageRanges.map((pageRange) => ({
    ...scope,
    scopeId: buildScopeId(scope.scopeId, `pages_${pageRange.start}_${pageRange.end}`),
    scopeLabel: `${scope.scopeLabel}__pages_${pageRange.start}_${pageRange.end}`,
    pageRange,
  }));
}

function buildChunkedScopePlanningResult(
  scope: Pick<ExtractionScope, "scopeId" | "scopeLabel">,
  sourceUrl: string,
  totals: ReportTotals,
  chunkResults: PlanningScopeResult[]
): PlanningScopeResult {
  return {
    items: chunkResults.flatMap((chunk) => chunk.items),
    failures: chunkResults.flatMap((chunk) => chunk.failures),
    summary: {
      scopeId: scope.scopeId,
      scopeLabel: scope.scopeLabel,
      sourceUrl,
      expectedTotalReports: totals.totalReports,
      extractedRows: chunkResults.reduce(
        (total, chunk) => total + chunk.summary.extractedRows,
        0
      ),
      totalPages: totals.totalPages,
      reportsPerPage: totals.reportsPerPage,
      lastPageCount: totals.lastPageCount,
      inconsistencies: chunkResults.flatMap(
        (chunk) => chunk.summary.inconsistencies
      ),
    },
  };
}

async function processRetryPlanExtraScope(
  page: Page,
  scope: ExtractionScope,
  runId: string,
  logger: RunLogger,
  planningConcurrency: number,
  knownReportIds: Set<string>
): Promise<PlanningScopeResult> {
  let inspection: Awaited<ReturnType<typeof inspectScopeTotals>>;

  try {
    inspection = await inspectScopeTotals(page, scope);
  } catch (error) {
    const reason =
      error instanceof Error ? error.stack ?? error.message : String(error);

    await logger.error(
      "planning",
      isExtraUnknownLocalScope(scope)
        ? "Falha ao auditar local desconhecido do plano externo. Escopo sera ignorado."
        : "Falha ao auditar escopo extra do plano externo. Escopo sera ignorado.",
      {
        scopeId: scope.scopeId,
        scopeLabel: scope.scopeLabel,
        error: reason,
      }
    );

    return {
      items: [],
      failures: [
        {
          scopeId: scope.scopeId,
          sourcePage: 0,
          sourceRowIndex: 0,
          rowText: "",
          reason: `Falha ao processar escopo: ${error instanceof Error ? error.message : String(error)}`,
          discoveredAt: nowIso(),
        },
      ],
      summary: {
        scopeId: scope.scopeId,
        scopeLabel: scope.scopeLabel,
        sourceUrl: "",
        expectedTotalReports: 0,
        extractedRows: 0,
        totalPages: 0,
        reportsPerPage: 0,
        lastPageCount: 0,
        inconsistencies: [],
      },
    };
  }

  if (inspection.totals.totalPages <= 1) {
    return await processScopePlanningSafely(page, scope, runId, logger, {
      plannedPathPrefixSegments: EXTRA_ORPHAN_PREFIX,
      knownReportIds,
      precomputedSourceUrl: inspection.sourceUrl,
      precomputedTotals: inspection.totals,
    });
  }

  const pageRanges = buildPageRanges(
    inspection.totals.totalPages,
    planningConcurrency
  );

  await logger.info(
    "planning",
    isExtraUnknownLocalScope(scope)
      ? "Passe final de local desconhecido sera processado em faixas paralelas."
      : "Passe extra sera processado em faixas paralelas.",
    {
      scopeId: scope.scopeId,
      totalPages: inspection.totals.totalPages,
      pageRanges: pageRanges.length,
    }
  );

  const chunkResults = await mapWithPagePool(
    page,
    pageRanges,
    planningConcurrency,
    async (chunkPage, pageRange) => {
      return await processScopePlanningSafely(
        chunkPage,
        scope,
        runId,
        logger,
        {
          plannedPathPrefixSegments: EXTRA_ORPHAN_PREFIX,
          knownReportIds,
          pageRange,
          precomputedSourceUrl: inspection.sourceUrl,
          precomputedTotals: inspection.totals,
        }
      );
    }
  );

  return buildChunkedScopePlanningResult(
    scope,
    inspection.sourceUrl,
    inspection.totals,
    chunkResults
  );
}

function buildPlanningReturn(
  scopes: ExtractionScope[],
  uniqueItems: Map<string, PlannedReportItem>,
  planningFailures: PlanningFailure[],
  scopeSummaries: ScopePlanningSummary[]
): {
  scopes: ExtractionScope[];
  plannedItems: PlannedReportItem[];
  planningFailures: PlanningFailure[];
  scopeSummaries: ScopePlanningSummary[];
} {
  return {
    scopes,
    plannedItems: [...uniqueItems.values()].sort((left, right) =>
      left.reportId.localeCompare(right.reportId)
    ),
    planningFailures,
    scopeSummaries,
  };
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
): Promise<PlanningScopeResult> {
  await logger.info("planning", "Aplicando escopo de planejamento.", {
    scopeId: scope.scopeId,
    scopeLabel: scope.scopeLabel,
    pageRange: options?.pageRange ?? null,
  });

  const scopeStartedAt = Date.now();
  let pageNavigationMs = 0;
  let popupHandlingMs = 0;
  let rowExtractionMs = 0;
  let rowProcessingMs = 0;
  let pagesVisited = 0;

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

  const popupAfterFiltersStartedAt = Date.now();
  await closeOnboardingPopup(page);
  popupHandlingMs += Date.now() - popupAfterFiltersStartedAt;

  const totalsInspectionStartedAt = Date.now();
  const planningPagination =
    options?.precomputedTotals ?? (await extractPlanningPagination(page));
  const totalsInspectionMs =
    options?.precomputedTotals ? 0 : Date.now() - totalsInspectionStartedAt;
  let extractedRows = 0;
  const inconsistencies: string[] = [];
  const items: PlannedReportItem[] = [];
  const failures: PlanningFailure[] = [];
  let stopEarly = false;
  const startPage = options?.pageRange?.start ?? scope.pageRange?.start ?? 1;
  const endPage =
    options?.pageRange?.end ?? scope.pageRange?.end ?? planningPagination.totalPages;
  let lastProcessedPageRowCount = 0;

  for (let pageIndex = startPage; pageIndex <= endPage && !stopEarly; pageIndex++) {
    const pageUrl = withPage(sourceUrl, pageIndex);
    const navigationStartedAt = Date.now();
    await page.goto(pageUrl, { waitUntil: "domcontentloaded" });
    pageNavigationMs += Date.now() - navigationStartedAt;

    const popupAfterNavigationStartedAt = Date.now();
    await closeOnboardingPopup(page);
    popupHandlingMs += Date.now() - popupAfterNavigationStartedAt;

    const rowExtractionStartedAt = Date.now();
    const rows = await extractRawRowsFromCurrentPage(page);
    rowExtractionMs += Date.now() - rowExtractionStartedAt;
    extractedRows += rows.length;
    pagesVisited += 1;
    lastProcessedPageRowCount = rows.length;

    const rowProcessingStartedAt = Date.now();
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
    rowProcessingMs += Date.now() - rowProcessingStartedAt;
  }

  const summaryTotals: ReportTotals = options?.precomputedTotals ?? {
    reportsPerPage: planningPagination.reportsPerPage,
    lastPageCount: lastProcessedPageRowCount,
    totalPages: planningPagination.totalPages,
    totalReports: extractedRows,
  };

  if (stopEarly) {
    inconsistencies.push(
      `Leitura encerrada antecipadamente apos identificar ${items.length} itens extras esperados para o escopo.`
    );
  }

  if (!options?.pageRange && summaryTotals.totalReports !== extractedRows) {
    inconsistencies.push(
      `Esperado ${summaryTotals.totalReports} itens, mas ${extractedRows} linhas foram extraidas.`
    );
  }

  const summary: ScopePlanningSummary = {
    scopeId: scope.scopeId,
    scopeLabel: scope.scopeLabel,
    sourceUrl,
    expectedTotalReports: summaryTotals.totalReports,
    extractedRows,
    totalPages: summaryTotals.totalPages,
    reportsPerPage: summaryTotals.reportsPerPage,
    lastPageCount: summaryTotals.lastPageCount,
    inconsistencies,
    telemetry: {
      totalsInspectionMs,
      pageNavigationMs,
      tableWaitMs: 0,
      rowExtractionMs,
      rowProcessingMs,
      totalScopeMs: Date.now() - scopeStartedAt,
      pagesVisited,
    },
  };

  await logger.info("planning", "Telemetria do escopo de planejamento.", {
    scopeId: scope.scopeId,
    scopeLabel: scope.scopeLabel,
    expectedTotalReports: summaryTotals.totalReports,
    extractedRows,
    totalPages: summaryTotals.totalPages,
    pagesVisited,
    totalsInspectionMs,
    pageNavigationMs,
    popupHandlingMs,
    rowExtractionMs,
    rowProcessingMs,
    totalScopeMs: summary.telemetry?.totalScopeMs ?? null,
    avgNavigationMsPerPage:
      pagesVisited > 0 ? Math.round(pageNavigationMs / pagesVisited) : 0,
    avgPopupHandlingMsPerPage:
      pagesVisited > 0 ? Math.round(popupHandlingMs / (pagesVisited + 1)) : popupHandlingMs,
    avgRowExtractionMsPerPage:
      pagesVisited > 0 ? Math.round(rowExtractionMs / pagesVisited) : 0,
    avgRowProcessingMsPerPage:
      pagesVisited > 0 ? Math.round(rowProcessingMs / pagesVisited) : 0,
  });

  return {
    items,
    failures,
    summary,
  };
}

async function processScopePlanningSafely(
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
): Promise<PlanningScopeResult> {
  try {
    return await processScopePlanning(page, scope, runId, logger, options);
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.stack ?? error.message : String(error);

    await logger.error(
      "planning",
      "Falha ao processar escopo de planejamento. Escopo sera ignorado.",
      {
        scopeId: scope.scopeId,
        scopeLabel: scope.scopeLabel,
        error: errorMessage,
      }
    );

    return {
      items: [],
      failures: [
        {
          scopeId: scope.scopeId,
          sourcePage: 0,
          sourceRowIndex: 0,
          rowText: "",
          reason: `Falha ao processar escopo: ${error instanceof Error ? error.message : String(error)}`,
          discoveredAt: nowIso(),
        },
      ],
      summary: {
        scopeId: scope.scopeId,
        scopeLabel: scope.scopeLabel,
        sourceUrl: options?.precomputedSourceUrl ?? "",
        expectedTotalReports: 0,
        extractedRows: 0,
        totalPages: 0,
        reportsPerPage: 0,
        lastPageCount: 0,
        inconsistencies: [
          `Falha no escopo: ${error instanceof Error ? error.message : String(error)}`,
        ],
        telemetry: {
          totalsInspectionMs: 0,
          pageNavigationMs: 0,
          tableWaitMs: 0,
          rowExtractionMs: 0,
          rowProcessingMs: 0,
          totalScopeMs: 0,
          pagesVisited: 0,
        },
      },
    };
  }
}

async function mapWithPagePool<T, R>(
  basePage: Page,
  items: T[],
  concurrency: number,
  worker: (page: Page, item: T, index: number) => Promise<R>,
  onResult?: (item: T, result: R, index: number) => Promise<void>
): Promise<R[]> {
  const poolSize = Math.max(1, Math.min(concurrency, items.length || 1));
  const pages = await Promise.all(
    Array.from({ length: poolSize }, async () => basePage.context().newPage())
  );

  try {
    const results: R[] = new Array(items.length);
    let nextIndex = 0;

    await Promise.all(
      pages.map(async (workerPage) => {
        while (true) {
          if (isShutdownRequested()) {
            return;
          }

          const currentIndex = nextIndex;
          nextIndex += 1;

          if (currentIndex >= items.length) {
            return;
          }

          results[currentIndex] = await worker(
            workerPage,
            items[currentIndex],
            currentIndex
          );
          await onResult?.(items[currentIndex], results[currentIndex], currentIndex);
        }
      })
    );

    return results;
  } finally {
    await Promise.all(pages.map((poolPage) => poolPage.close().catch(() => undefined)));
  }
}

export async function planReportInventory(
  page: Page,
  runId: string,
  logger: RunLogger,
  options?: {
    knownReportIds?: Set<string>;
  }
): Promise<{
  scopes: ExtractionScope[];
  plannedItems: PlannedReportItem[];
  planningFailures: PlanningFailure[];
  scopeSummaries: ScopePlanningSummary[];
}> {
  const isDateOnlyCatchupMode =
    config.execution.planningMode === "date-only-catchup";
  const checkpointFile = isDateOnlyCatchupMode
    ? config.paths.dateOnlyCatchupPlanningCheckpointFile
    : config.paths.planningCheckpointFile;
  const resolvedScopes = await resolveExtractionScopes(page, logger);
  let scopes = resolvedScopes;

  if (isDateOnlyCatchupMode && resolvedScopes.length === 1) {
    try {
      const inspection = await inspectScopeTotals(page, resolvedScopes[0]);
      scopes = buildDateOnlyCatchupScopes(
        resolvedScopes[0],
        inspection.totals.totalPages
      );

      await logger.info(
        "planning",
        "Planning por data particionado em faixas paralelas.",
        {
          totalPages: inspection.totals.totalPages,
          chunkScopes: scopes.length,
          planningConcurrency: config.execution.planningConcurrency,
        }
      );
    } catch (error) {
      await logger.warn(
        "planning",
        "Falha ao inspecionar a listagem global do planning por data. A execucao seguira sem particionamento em faixas.",
        {
          scopeId: resolvedScopes[0].scopeId,
          error: error instanceof Error ? error.message : String(error),
        }
      );
    }
  }

  const scopeSignature = buildScopeSignature(scopes);
  const usingExternalPlan =
    !isDateOnlyCatchupMode &&
    Boolean(config.execution.extractionPlanFile) &&
    (await fileExists(config.execution.extractionPlanFile));
  const uniqueItems = new Map<string, PlannedReportItem>();
  const planningFailures: PlanningFailure[] = [];
  const scopeSummaries: ScopePlanningSummary[] = [];
  const planningConcurrency = Math.min(
    scopes.length || 1,
    config.execution.planningConcurrency
  );
  const externallyKnownReportIds = options?.knownReportIds ?? new Set<string>();
  let checkpoint = createEmptyPlanningCheckpoint(scopeSignature);

  if (scopes.length > 0) {
    const loadedCheckpoint = await loadPlanningCheckpoint(
      checkpointFile
    );

    if (loadedCheckpoint.scopeSignature === scopeSignature) {
      checkpoint = loadedCheckpoint;

      for (const item of checkpoint.plannedItems) {
        uniqueItems.set(item.reportId, item);
      }

      appendAll(planningFailures, checkpoint.planningFailures);
      appendAll(scopeSummaries, checkpoint.scopeSummaries);

      await logger.info("planning", "Checkpoint de planejamento carregado.", {
        completedScopes: checkpoint.completedScopeIds.length,
        restoredItems: checkpoint.plannedItems.length,
        restoredFailures: checkpoint.planningFailures.length,
      });
    } else {
      await logger.info(
        "planning",
        "Checkpoint de planejamento reiniciado para o conjunto atual de escopos.",
        {
          scopes: scopes.length,
        }
      );
    }

    await replacePlanningCheckpoint(checkpointFile, checkpoint);
  }

  const completedScopeIds = new Set(checkpoint.completedScopeIds);
  const pendingScopes = scopes.filter((scope) => !completedScopeIds.has(scope.scopeId));
  const standardPendingScopes = usingExternalPlan
    ? pendingScopes.filter(
        (scope) =>
          !isExtraOrphanScope(scope) && !isExtraUnknownLocalScope(scope)
      )
    : pendingScopes;
  const retryExtraOrphanScopes = usingExternalPlan
    ? pendingScopes.filter((scope) => isExtraOrphanScope(scope))
    : [];
  const retryExtraUnknownScopes = usingExternalPlan
    ? pendingScopes.filter((scope) => isExtraUnknownLocalScope(scope))
    : [];
  let checkpointSaveQueue = Promise.resolve();

  const appendScopeResult = async (
    scopeId: string,
    result: PlanningScopeResult
  ): Promise<void> => {
    mergePlanningScopeResult(uniqueItems, planningFailures, scopeSummaries, result);
    completedScopeIds.add(scopeId);

    checkpointSaveQueue = checkpointSaveQueue
      .catch(() => undefined)
      .then(() =>
        appendPlanningCheckpointResult(
          checkpointFile,
          scopeSignature,
          scopeId,
          result
        )
      );

    await checkpointSaveQueue;
  };

  const buildRetryKnownReportIds = (): Set<string> =>
    new Set([...externallyKnownReportIds, ...uniqueItems.keys()]);

  await logger.info("planning", "Iniciando processamento paralelo dos escopos.", {
    scopes: scopes.length,
    pendingScopes: pendingScopes.length,
    planningConcurrency,
  });

  if (usingExternalPlan) {
    await logger.info(
      "planning",
      "Plano externo particionado em escopos principais e escopos extras para preservar a semantica de retry.",
      {
        standardScopes: standardPendingScopes.length,
        extraOrphanScopes: retryExtraOrphanScopes.length,
        extraUnknownScopes: retryExtraUnknownScopes.length,
        knownReportsFromExecutionState: externallyKnownReportIds.size,
      }
    );
  }

  await mapWithPagePool(
    page,
    standardPendingScopes,
    planningConcurrency,
    async (scopePage, scope) => {
      const retryKnownReportIds = usingExternalPlan
        ? buildRetryKnownReportIds()
        : undefined;

      return await processScopePlanningSafely(scopePage, scope, runId, logger, {
        knownReportIds: retryKnownReportIds,
      });
    },
    async (scope, result) => {
      await appendScopeResult(scope.scopeId, result);
    }
  );

  if (isShutdownRequested()) {
    await checkpointSaveQueue.catch(() => undefined);
    return buildPlanningReturn(
      scopes,
      uniqueItems,
      planningFailures,
      scopeSummaries
    );
  }

  if (usingExternalPlan && retryExtraOrphanScopes.length > 0) {
    const retryKnownReportIds = buildRetryKnownReportIds();

    await logger.info(
      "planning",
      "Reprocessando escopos extras de orfaos do plano externo com deduplicacao contra o inventario ja conhecido.",
      {
        scopes: retryExtraOrphanScopes.length,
        knownReports: retryKnownReportIds.size,
      }
    );

    await mapWithPagePool(
      page,
      retryExtraOrphanScopes,
      planningConcurrency,
      async (scopePage, scope) => {
        return await processRetryPlanExtraScope(
          scopePage,
          scope,
          runId,
          logger,
          planningConcurrency,
          retryKnownReportIds
        );
      },
      async (scope, result) => {
        await appendScopeResult(scope.scopeId, result);
      }
    );
  }

  if (isShutdownRequested()) {
    await checkpointSaveQueue.catch(() => undefined);
    return buildPlanningReturn(
      scopes,
      uniqueItems,
      planningFailures,
      scopeSummaries
    );
  }

  if (usingExternalPlan && retryExtraUnknownScopes.length > 0) {
    const retryKnownReportIds = buildRetryKnownReportIds();

    await logger.info(
      "planning",
      "Reprocessando o passe final de local desconhecido a partir do plano externo.",
      {
        scopes: retryExtraUnknownScopes.length,
        knownReports: retryKnownReportIds.size,
      }
    );

    await mapWithPagePool(
      page,
      retryExtraUnknownScopes,
      planningConcurrency,
      async (scopePage, scope) => {
        return await processRetryPlanExtraScope(
          scopePage,
          scope,
          runId,
          logger,
          planningConcurrency,
          retryKnownReportIds
        );
      },
      async (scope, result) => {
        await appendScopeResult(scope.scopeId, result);
      }
    );
  }

  if (isShutdownRequested()) {
    await checkpointSaveQueue.catch(() => undefined);
    return buildPlanningReturn(
      scopes,
      uniqueItems,
      planningFailures,
      scopeSummaries
    );
  }

  if (!usingExternalPlan && !isDateOnlyCatchupMode) {
    const releaseGranted = await awaitExtraPlanningRelease(logger);
    if (!releaseGranted) {
      await checkpointSaveQueue.catch(() => undefined);
      return buildPlanningReturn(
        scopes,
        uniqueItems,
        planningFailures,
        scopeSummaries
      );
    }

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

    const orphanInspections = await mapWithPagePool(
      page,
      orphanRecoveryScopes,
      planningConcurrency,
      async (scopePage, scope) => {
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
        } catch (error) {
          const reason =
            error instanceof Error ? error.stack ?? error.message : String(error);

          planningFailures.push({
            scopeId: scope.scopeId,
            sourcePage: 0,
            sourceRowIndex: 0,
            rowText: "",
            reason: `Falha ao processar escopo: ${error instanceof Error ? error.message : String(error)}`,
            discoveredAt: nowIso(),
          });

          await logger.error(
            "planning",
            "Falha ao auditar local do passe extra. Escopo sera ignorado.",
            {
              scopeId: scope.scopeId,
              scopeLabel: scope.scopeLabel,
              error: reason,
            }
          );

          return {
            scope,
            sourceUrl: "",
            totals: {
              reportsPerPage: 0,
              lastPageCount: 0,
              totalPages: 0,
              totalReports: 0,
            },
            primaryCount: 0,
            expectedOrphanCount: 0,
          };
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
    const orphanResults = await mapWithPagePool(
      page,
      orphanScopesToScan,
      planningConcurrency,
      async (scopePage, inspection) => {
        if (inspection.totals.totalPages <= 1) {
          return await processScopePlanningSafely(
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

        const chunkResults = await mapWithPagePool(
          page,
          pageRanges,
          planningConcurrency,
          async (chunkPage, pageRange) => {
            return await processScopePlanningSafely(
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
      mergePlanningScopeResult(uniqueItems, planningFailures, scopeSummaries, result);

      checkpointSaveQueue = checkpointSaveQueue
        .catch(() => undefined)
        .then(() =>
          appendPlanningCheckpointResult(
            checkpointFile,
            scopeSignature,
            result.summary.scopeId,
            result
          )
        );

      await checkpointSaveQueue;
    }

    if (config.execution.enableUnknownLocalExtra && !isShutdownRequested()) {
      const unknownLocalScope = buildUnknownLocalRecoveryScope();

      await logger.info(
        "planning",
        "Iniciando passe final sem filtro de local para capturar relatorios com local desconhecido.",
        {
          scopeId: unknownLocalScope.scopeId,
          knownReportsBeforePass: uniqueItems.size,
        }
      );

      try {
        const inspection = await inspectScopeTotals(page, unknownLocalScope);
        const unknownLocalKnownReportIds = new Set(uniqueItems.keys());
        let unknownLocalResult: PlanningScopeResult | undefined;

        if (inspection.totals.totalPages <= 1) {
          unknownLocalResult = await processScopePlanningSafely(
            page,
            unknownLocalScope,
            runId,
            logger,
            {
              plannedPathPrefixSegments: EXTRA_ORPHAN_PREFIX,
              knownReportIds: unknownLocalKnownReportIds,
              precomputedSourceUrl: inspection.sourceUrl,
              precomputedTotals: inspection.totals,
            }
          );
        } else {
          const pageRanges = buildPageRanges(
            inspection.totals.totalPages,
            planningConcurrency
          );

          await logger.info(
            "planning",
            "Passe final de local desconhecido sera processado em faixas paralelas.",
            {
              scopeId: unknownLocalScope.scopeId,
              totalPages: inspection.totals.totalPages,
              pageRanges: pageRanges.length,
            }
          );

          const chunkResults = await mapWithPagePool(
            page,
            pageRanges,
            planningConcurrency,
            async (chunkPage, pageRange) => {
              return await processScopePlanningSafely(
                chunkPage,
                unknownLocalScope,
                runId,
                logger,
                {
                  plannedPathPrefixSegments: EXTRA_ORPHAN_PREFIX,
                  knownReportIds: unknownLocalKnownReportIds,
                  pageRange,
                  precomputedSourceUrl: inspection.sourceUrl,
                  precomputedTotals: inspection.totals,
                }
              );
            }
          );

          unknownLocalResult = {
            items: chunkResults.flatMap((chunk) => chunk.items),
            failures: chunkResults.flatMap((chunk) => chunk.failures),
            summary: {
              scopeId: unknownLocalScope.scopeId,
              scopeLabel: unknownLocalScope.scopeLabel,
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

        if (unknownLocalResult) {
          mergePlanningScopeResult(
            uniqueItems,
            planningFailures,
            scopeSummaries,
            unknownLocalResult
          );

          checkpointSaveQueue = checkpointSaveQueue
            .catch(() => undefined)
            .then(() =>
              appendPlanningCheckpointResult(
                checkpointFile,
                scopeSignature,
                unknownLocalResult.summary.scopeId,
                unknownLocalResult
              )
            );

          await checkpointSaveQueue;

          await logger.info(
            "planning",
            "Passe final de local desconhecido concluido.",
            {
              scopeId: unknownLocalScope.scopeId,
              addedItems: unknownLocalResult.items.length,
              failures: unknownLocalResult.failures.length,
            }
          );
        }
      } catch (error) {
        planningFailures.push({
          scopeId: unknownLocalScope.scopeId,
          sourcePage: 0,
          sourceRowIndex: 0,
          rowText: "",
          reason: `Falha ao processar escopo: ${error instanceof Error ? error.message : String(error)}`,
          discoveredAt: nowIso(),
        });

        await logger.error(
          "planning",
          "Falha no passe final sem filtro de local. O passe sera ignorado.",
          {
            scopeId: unknownLocalScope.scopeId,
            error: error instanceof Error ? error.stack ?? error.message : String(error),
          }
        );
      }
    }
  }

  await checkpointSaveQueue.catch(() => undefined);
  if (!isShutdownRequested()) {
    await clearPlanningCheckpoint(checkpointFile);
  }

  return buildPlanningReturn(
    scopes,
    uniqueItems,
    planningFailures,
    scopeSummaries
  );
}
