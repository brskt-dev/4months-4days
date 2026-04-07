import fs from "node:fs";
import path from "node:path";
import { Locator, Page } from "playwright";
import { ROUTES, SELECTORS, TIMEOUTS } from "./constants";
import { closeOnboardingPopup } from "./helpers/closePopup";
import {
  FormType,
  RawReportRow,
  ReportFilters,
  ReportTotals,
  ResourcePlace,
} from "./types";
import { extractExportButtonId, extractReportIdFromRow } from "./utils/reportMetadata";
import { buildReportsUrl, withPage } from "./utils/reportUrls";

function buildIdSelector(id: string): string {
  const escaped = id.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `[id="${escaped}"]`;
}

async function waitForResourcePlaceOptions(page: Page): Promise<boolean> {
  return page
    .waitForFunction(
      (selector) => {
        const element = document.querySelector(selector);
        if (!(element instanceof HTMLSelectElement)) {
          return false;
        }

        return [...element.options].some(
          (option) =>
            Boolean(option.value?.trim()) &&
            !Number.isNaN(Number(option.value.trim()))
        );
      },
      SELECTORS.reportResourcePlaceSelect,
      { timeout: 30_000, polling: 1_000 }
    )
    .then(() => true)
    .catch(() => false);
}

async function waitForReportTable(page: Page): Promise<void> {
  await page
    .waitForSelector(SELECTORS.reportRows, {
      timeout: TIMEOUTS.short,
    })
    .catch(() => undefined);
}

async function tryExtractExportRequestId(modal: Locator): Promise<string | null> {
  try {
    return await modal.evaluate((element) => {
      const attributes = Array.from(
        element.querySelectorAll(
          "[data-export-request-id], [data-request-id], input[type='hidden']"
        )
      )
        .flatMap((node) => {
          const result: string[] = [];
          if (node instanceof HTMLElement) {
            const exportRequestId = node.dataset.exportRequestId;
            const requestId = node.dataset.requestId;
            if (exportRequestId) result.push(exportRequestId);
            if (requestId) result.push(requestId);
          }
          if (node instanceof HTMLInputElement && node.value) {
            result.push(node.value);
          }
          return result;
        })
        .find((value) => /\d{4,}/.test(value));

      return attributes ?? null;
    });
  } catch {
    return null;
  }
}

async function waitForExportReady(
  page: Page,
  modal: Locator,
  pollingIntervalMs: number
): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < TIMEOUTS.exportReady) {
    if (
      await modal
        .locator(SELECTORS.exportReadyState)
        .isVisible()
        .catch(() => false)
    ) {
      return;
    }

    if (
      await modal
        .locator(SELECTORS.exportDownloadLink)
        .isVisible()
        .catch(() => false)
    ) {
      return;
    }

    await page.waitForTimeout(pollingIntervalMs);
  }

  throw new Error("Tempo limite excedido aguardando o arquivo ficar pronto.");
}

export async function goToReports(page: Page): Promise<Page> {
  await closeOnboardingPopup(page);
  await page.click(SELECTORS.workMenuButton);
  await page.waitForSelector(SELECTORS.reportsMenuLink, {
    timeout: TIMEOUTS.short,
  });
  await page.click(SELECTORS.reportsMenuLink);
  await page.waitForURL(`**${ROUTES.reports}`, { timeout: TIMEOUTS.navigation });
  await closeOnboardingPopup(page);
  return page;
}

export async function applyFilters(
  page: Page,
  filters: ReportFilters
): Promise<string> {
  const targetUrl = buildReportsUrl(filters);
  await closeOnboardingPopup(page);
  await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
  await closeOnboardingPopup(page);
  await waitForReportTable(page);
  return targetUrl;
}

export async function extractFormTypes(page: Page): Promise<FormType[]> {
  const dropdown = page.locator(SELECTORS.reportFormDropdown).first();
  await dropdown.click();
  await closeOnboardingPopup(page);
  const menu = dropdown
    .locator("xpath=following-sibling::ul[contains(@class, 'multiselect-container')]")
    .first();
  await menu.waitFor();

  const forms = await menu.locator("li label.checkbox").evaluateAll((labels) =>
    labels
      .map((label) => {
        const input = label.querySelector("input[type='checkbox']");
        const formId = input?.getAttribute("value") ?? "";
        const name = label.textContent?.replace(/\s+/g, " ").trim() ?? "";

        if (!formId || Number.isNaN(Number(formId))) {
          return null;
        }

        return { id: formId, name };
      })
      .filter((item): item is { id: string; name: string } => item !== null)
  );

  await dropdown.click();
  return forms;
}

export async function extractResourcePlaces(page: Page): Promise<ResourcePlace[]> {
  await page
    .locator(SELECTORS.reportResourcePlaceContainer)
    .waitFor({ state: "attached", timeout: TIMEOUTS.navigation })
    .catch(() => undefined);

  const select = page.locator(SELECTORS.reportResourcePlaceSelect).first();
  await select.waitFor({ state: "attached", timeout: TIMEOUTS.navigation });

  const hasOptions = await waitForResourcePlaceOptions(page);

  if (hasOptions) {
    return select.locator("option").evaluateAll((options) =>
      options
        .map((option) => {
          const value = option.getAttribute("value")?.trim() ?? "";
          const name = option.textContent?.replace(/\s+/g, " ").trim() ?? "";

          if (!value || Number.isNaN(Number(value)) || !name) {
            return null;
          }

          return { id: value, name };
        })
        .filter((item): item is { id: string; name: string } => item !== null)
    );
  }

  const dropdown = page.locator(SELECTORS.reportResourcePlaceDropdown).first();
  if ((await dropdown.count()) === 0) {
    return [];
  }

  await dropdown.click();
  await closeOnboardingPopup(page);
  const hasOptionsAfterOpen = await waitForResourcePlaceOptions(page);

  if (hasOptionsAfterOpen) {
    const resourcePlaces = await select.locator("option").evaluateAll((options) =>
      options
        .map((option) => {
          const value = option.getAttribute("value")?.trim() ?? "";
          const name = option.textContent?.replace(/\s+/g, " ").trim() ?? "";

          if (!value || Number.isNaN(Number(value)) || !name) {
            return null;
          }

          return { id: value, name };
        })
        .filter((item): item is { id: string; name: string } => item !== null)
    );

    await dropdown.click().catch(() => undefined);
    return resourcePlaces;
  }

  const menu = dropdown
    .locator("xpath=following::ul[contains(@class, 'multiselect-container')][1]")
    .first();
  await menu.waitFor({ state: "visible", timeout: TIMEOUTS.navigation }).catch(() => undefined);

  const resourcePlaces = await menu.locator("li label.checkbox").evaluateAll((labels) =>
    labels
      .map((label) => {
        const input = label.querySelector("input[type='checkbox']");
        const value = input?.getAttribute("value")?.trim() ?? "";
        const name = label.textContent?.replace(/\s+/g, " ").trim() ?? "";

        if (!value || Number.isNaN(Number(value)) || !name) {
          return null;
        }

        return { id: value, name };
      })
      .filter((item): item is { id: string; name: string } => item !== null)
  );

  await dropdown.click().catch(() => undefined);
  return resourcePlaces;
}

export async function extractTotalReports(page: Page): Promise<ReportTotals> {
  const filteredUrl = page.url();
  const rowsCount = await page.locator(SELECTORS.reportRows).count();
  const pageLinks = await page.locator(SELECTORS.paginationLinks).allInnerTexts();
  const pageNumbers = pageLinks
    .map((text) => parseInt(text.trim(), 10))
    .filter((value) => !Number.isNaN(value));

  const totalPages = Math.max(1, ...pageNumbers);
  let lastPageCount = rowsCount;
  let totalReports = rowsCount;

  if (totalPages > 1) {
    await page.goto(withPage(filteredUrl, totalPages), {
      waitUntil: "domcontentloaded",
    });
    await waitForReportTable(page);
    lastPageCount = await page.locator(SELECTORS.reportRows).count();
    totalReports = rowsCount * (totalPages - 1) + lastPageCount;
  }

  await page.goto(withPage(filteredUrl, 1), { waitUntil: "domcontentloaded" });
  await waitForReportTable(page);

  return {
    reportsPerPage: rowsCount,
    lastPageCount,
    totalPages,
    totalReports,
  };
}

export async function extractRawRowsFromCurrentPage(
  page: Page
): Promise<RawReportRow[]> {
  await waitForReportTable(page);

  return page.evaluate((selectors) => {
    const rows = Array.from(document.querySelectorAll(".formFill-card table")).flatMap(
      (table) => {
        const headers = Array.from(table.querySelectorAll("thead th")).map(
          (node) => node.textContent?.trim() ?? ""
        );

        return Array.from(table.querySelectorAll("tbody tr")).map((row) => {
          const cells = Array.from(row.querySelectorAll("td")).map((cell, index) => ({
            header: headers[index] ?? `column_${index + 1}`,
            text: cell.textContent?.replace(/\s+/g, " ").trim() ?? "",
          }));

          const actions = Array.from(
            row.querySelectorAll(
              "a, button, input[type='button'], input[type='submit']"
            )
          ).map((element) => {
            const dataset: Record<string, string> = {};
            Object.entries((element as HTMLElement).dataset ?? {}).forEach(
              ([key, value]) => {
                if (typeof value === "string") {
                  dataset[key] = value;
                }
              }
            );

            return {
              id: (element as HTMLElement).id || null,
              text: element.textContent?.replace(/\s+/g, " ").trim() ?? "",
              href: element instanceof HTMLAnchorElement ? element.href : null,
              dataset,
            };
          });

          const rowDataset: Record<string, string> = {};
          Object.entries((row as HTMLElement).dataset ?? {}).forEach(
            ([key, value]) => {
              if (typeof value === "string") {
                rowDataset[key] = value;
              }
            }
          );

          return {
            rowText: row.textContent?.replace(/\s+/g, " ").trim() ?? "",
            rowHtml: row.outerHTML,
            rowDataset,
            cells,
            actions,
            links: Array.from(row.querySelectorAll("a"))
              .map((anchor) => anchor.href)
              .filter(Boolean),
          };
        });
      }
    );

    return rows.map((row, rowIndex) => ({
      rowIndex: rowIndex + 1,
      ...row,
    }));
  }, SELECTORS);
}

export async function findExportSelectorForReport(
  page: Page,
  reportId: string,
  exportButtonId: string | null
): Promise<string | null> {
  if (exportButtonId) {
    const directSelector = buildIdSelector(exportButtonId);
    if ((await page.locator(directSelector).count()) > 0) {
      return directSelector;
    }
  }

  const rows = await extractRawRowsFromCurrentPage(page);
  const matchedRow = rows.find((row) => extractReportIdFromRow(row) === reportId);
  if (!matchedRow) {
    return null;
  }

  const resolvedButtonId = extractExportButtonId(matchedRow);
  return resolvedButtonId ? buildIdSelector(resolvedButtonId) : null;
}

export async function exportReportPdf(
  page: Page,
  exportButtonSelector: string,
  destinationPath: string,
  pollingIntervalMs: number,
  hooks?: {
    onRequestCreated?: (exportRequestId: string | null) => Promise<void>;
    onProcessing?: () => Promise<void>;
    onReadyToDownload?: () => Promise<void>;
  }
): Promise<{ exportRequestId: string | null; suggestedFilename: string }> {
  await closeOnboardingPopup(page);
  await page.click(exportButtonSelector);
  await page.waitForSelector(SELECTORS.exportModalTitle, {
    timeout: TIMEOUTS.navigation,
  });

  const modal = page.locator(SELECTORS.exportModalContent);
  await modal.locator(SELECTORS.exportProfileSelect).waitFor();

  const options = await modal
    .locator(`${SELECTORS.exportProfileSelect} option`)
    .all();
  if (options.length === 0) {
    throw new Error("Nenhuma opcao de exportacao disponivel.");
  }

  const firstValue = await options[0].getAttribute("value");
  await modal.locator(SELECTORS.exportProfileSelect).selectOption(firstValue!);
  await modal.locator(SELECTORS.confirmExportButton).click();

  const exportRequestId = await tryExtractExportRequestId(modal);
  await hooks?.onRequestCreated?.(exportRequestId);
  await hooks?.onProcessing?.();

  await modal
    .locator(SELECTORS.exportLoadingState)
    .waitFor({ state: "visible", timeout: TIMEOUTS.short })
    .catch(() => undefined);
  await waitForExportReady(page, modal, pollingIntervalMs);
  await hooks?.onReadyToDownload?.();

  const downloadPromise = page.waitForEvent("download");
  await modal.locator(SELECTORS.exportDownloadLink).click();
  const download = await downloadPromise;

  await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true });
  await download.saveAs(destinationPath);

  await modal.waitFor({ state: "hidden", timeout: TIMEOUTS.navigation }).catch(
    () => undefined
  );
  await closeOnboardingPopup(page);

  return {
    exportRequestId,
    suggestedFilename: download.suggestedFilename(),
  };
}
