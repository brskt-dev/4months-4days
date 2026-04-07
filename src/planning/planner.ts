import { Page } from "playwright";
import { config } from "../config";
import { closeOnboardingPopup } from "../helpers/closePopup";
import { RunLogger } from "../logging/runLogger";
import {
  applyFilters,
  extractFormTypes,
  extractRawRowsFromCurrentPage,
  extractTotalReports,
} from "../reports";
import {
  ExtractionPlanFile,
  ExtractionScope,
  FormType,
  PlannedReportItem,
  PlanningFailure,
  ScopePlanningSummary,
} from "../types";
import { nowIso } from "../utils/dates";
import { fileExists, readJsonFile } from "../utils/filesystem";
import {
  extractAssetNameFromRow,
  extractExportButtonId,
  extractFormNameFromRow,
  extractLocalNameFromRow,
  extractReportDateFromRow,
  extractReportIdFromRow,
} from "../utils/reportMetadata";
import { buildPlannedPath } from "../utils/reportPaths";
import { withPage } from "../utils/reportUrls";
import { buildScopeId } from "../utils/sanitize";

function buildScopeLabel(scope: Partial<ExtractionScope>): string {
  const form = scope.formName ?? scope.formId ?? "all-forms";
  const local = scope.localName ?? scope.localId ?? "all-locals";
  const period = `${scope.startDate ?? config.reports.defaultStartDate}_${scope.endDate ?? config.reports.defaultEndDate}`;
  return `${form}__${local}__${period}`;
}

function normalizeScope(
  scope: Partial<ExtractionScope>,
  index: number,
  formsById: Map<string, FormType>
): ExtractionScope {
  const formName =
    scope.formName ??
    (scope.formId ? formsById.get(scope.formId)?.name ?? null : null);

  const scopeLabel = buildScopeLabel({
    ...scope,
    formName,
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
    localName: scope.localName ?? null,
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
  const formsById = new Map(discoveredForms.map((form) => [form.id, form]));

  if (
    config.execution.extractionPlanFile &&
    (await fileExists(config.execution.extractionPlanFile))
  ) {
    const planFile = await readJsonFile<ExtractionPlanFile>(
      config.execution.extractionPlanFile,
      { scopes: [] }
    );

    const scopes = planFile.scopes.map((scope, index) =>
      normalizeScope(scope, index, formsById)
    );

    await logger.info("planning", "Plano de extracao carregado do arquivo.", {
      extractionPlanFile: config.execution.extractionPlanFile,
      scopes: scopes.length,
    });

    return scopes;
  }

  const autoScopes = discoveredForms.map((form, index) =>
    normalizeScope(
      {
        formId: form.id,
        formName: form.name,
        startDate: config.reports.defaultStartDate,
        endDate: config.reports.defaultEndDate,
      },
      index,
      formsById
    )
  );

  await logger.info(
    "planning",
    "Nenhum plano externo encontrado. Usando descoberta automatica por formulario.",
    { scopes: autoScopes.length }
  );

  return autoScopes;
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
  const uniqueItems = new Map<string, PlannedReportItem>();
  const planningFailures: PlanningFailure[] = [];
  const scopeSummaries: ScopePlanningSummary[] = [];

  for (const scope of scopes) {
    await logger.info("planning", "Aplicando escopo de planejamento.", {
      scopeId: scope.scopeId,
      scopeLabel: scope.scopeLabel,
    });

    const sourceUrl = await applyFilters(page, {
      formId: scope.formId,
      localId: scope.localId,
      assetId: scope.assetId,
      startDate: scope.startDate,
      endDate: scope.endDate,
      extraQueryParams: scope.extraQueryParams,
    });

    await closeOnboardingPopup(page);

    const totals = await extractTotalReports(page);
    let extractedRows = 0;
    const inconsistencies: string[] = [];

    for (let pageIndex = 1; pageIndex <= totals.totalPages; pageIndex++) {
      const pageUrl = withPage(sourceUrl, pageIndex);
      await page.goto(pageUrl, { waitUntil: "networkidle" });
      await closeOnboardingPopup(page);

      const rows = await extractRawRowsFromCurrentPage(page);
      extractedRows += rows.length;

      for (const row of rows) {
        const reportId = extractReportIdFromRow(row);
        const reportDateInfo = extractReportDateFromRow(row);

        if (!reportId) {
          planningFailures.push({
            scopeId: scope.scopeId,
            sourcePage: pageIndex,
            sourceRowIndex: row.rowIndex,
            rowText: row.rowText,
            reason: "Nao foi possivel identificar o report_id da linha.",
            discoveredAt: nowIso(),
          });
          continue;
        }

        if (!reportDateInfo) {
          planningFailures.push({
            scopeId: scope.scopeId,
            sourcePage: pageIndex,
            sourceRowIndex: row.rowIndex,
            rowText: row.rowText,
            reason: `Nao foi possivel identificar a data do relatorio para ${reportId}.`,
            discoveredAt: nowIso(),
          });
          continue;
        }

        const formName =
          extractFormNameFromRow(row) ??
          scope.formName ??
          scope.formId ??
          "UnknownForm";
        const localName =
          extractLocalNameFromRow(row) ??
          scope.localName ??
          scope.localId ??
          extractAssetNameFromRow(row) ??
          scope.assetName ??
          scope.assetId ??
          "UnknownLocal";
        const assetName =
          extractAssetNameFromRow(row) ?? scope.assetName ?? scope.assetId ?? null;
        const plannedPath = buildPlannedPath(
          formName,
          localName,
          reportDateInfo.year,
          reportId
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

        const existing = uniqueItems.get(reportId);
        if (existing) {
          if (
            !existing.filterTrace.some(
              (trace) => trace.scopeId === filterTrace.scopeId
            )
          ) {
            existing.filterTrace.push(filterTrace);
          }

          if (existing.plannedPath !== plannedPath.fullPath) {
            inconsistencies.push(
              `Report ${reportId} apareceu com destino divergente: ${existing.plannedPath} vs ${plannedPath.fullPath}.`
            );
          }

          continue;
        }

        uniqueItems.set(reportId, {
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
      }
    }

    if (totals.totalReports !== extractedRows) {
      inconsistencies.push(
        `Esperado ${totals.totalReports} itens, mas ${extractedRows} linhas foram extraidas.`
      );
    }

    scopeSummaries.push({
      scopeId: scope.scopeId,
      scopeLabel: scope.scopeLabel,
      sourceUrl,
      expectedTotalReports: totals.totalReports,
      extractedRows,
      totalPages: totals.totalPages,
      reportsPerPage: totals.reportsPerPage,
      lastPageCount: totals.lastPageCount,
      inconsistencies,
    });
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
