import fs from "node:fs";
import path from "node:path";
import { Locator, Page } from "playwright";
import { ROUTES, SELECTORS, TIMEOUTS } from "./constants";
import { closeOnboardingPopup } from "./helpers/closePopup";
import { FormType, RawReportRow, ReportFilters, ReportTotals } from "./types";
import { buildReportsUrl, withPage } from "./utils/reportUrls";
import { extractExportButtonId, extractReportIdFromRow } from "./utils/reportMetadata";

function buildIdSelector(id: string): string {
  const escaped = id.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `[id="${escaped}"]`;
}

async function waitForReportTable(page: Page): Promise<void> {
  await page.waitForTimeout(500);
  await page
    .waitForSelector(SELECTORS.reportRows, {
      timeout: TIMEOUTS.short,
    })
    .catch(() => undefined);
}

async function tryExtractExportRequestId(modal: Locator): Promise<string | null> {
  try {
    return await modal.evaluate((element) => {
      const attributes = Array.from(element.querySelectorAll("[data-export-request-id], [data-request-id], input[type='hidden']"))
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
    if (await modal.locator(SELECTORS.exportReadyState).isVisible().catch(() => false)) {
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
  await page.goto(targetUrl, { waitUntil: "networkidle" });
  await closeOnboardingPopup(page);
  await waitForReportTable(page);
  return targetUrl;
}

export async function extractFormTypes(page: Page): Promise<FormType[]> {
  await page.click(SELECTORS.reportFormDropdown);
  await closeOnboardingPopup(page);
  await page.waitForSelector(SELECTORS.reportFormOptions);

  const items = await page.$$(SELECTORS.reportFormOptions);
  const forms: FormType[] = [];

  for (const item of items) {
    const input = await item.$("input[type='checkbox']");
    if (!input) {
      continue;
    }

    const formId = await input.getAttribute("value");
    const label = (await item.innerText()).trim();
    if (!formId || Number.isNaN(Number(formId))) {
      continue;
    }

    if (label.toLowerCase().includes("projeto")) {
      continue;
    }

    forms.push({ id: formId, name: label });
  }

  await page.click(SELECTORS.reportFormDropdown);
  return forms;
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
      waitUntil: "networkidle",
    });
    await waitForReportTable(page);
    lastPageCount = await page.locator(SELECTORS.reportRows).count();
    totalReports = rowsCount * (totalPages - 1) + lastPageCount;
  }

  await page.goto(withPage(filteredUrl, 1), { waitUntil: "networkidle" });
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
    const headers = Array.from(
      document.querySelectorAll(selectors.reportHeaders)
    ).map((node) => node.textContent?.trim() ?? "");

    return Array.from(document.querySelectorAll(selectors.reportRows)).map(
      (row, rowIndex) => {
        const cells = Array.from(row.querySelectorAll("td")).map((cell, index) => ({
          header: headers[index] ?? `column_${index + 1}`,
          text: cell.textContent?.replace(/\s+/g, " ").trim() ?? "",
        }));

        const actions = Array.from(
          row.querySelectorAll("a, button, input[type='button'], input[type='submit']")
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
            href:
              element instanceof HTMLAnchorElement
                ? element.href
                : null,
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
          rowIndex: rowIndex + 1,
          rowText: row.textContent?.replace(/\s+/g, " ").trim() ?? "",
          rowHtml: row.outerHTML,
          rowDataset,
          cells,
          actions,
          links: Array.from(row.querySelectorAll("a"))
            .map((anchor) => anchor.href)
            .filter(Boolean),
        };
      }
    );
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
