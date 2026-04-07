import { RawReportRow, ReportDateInfo } from "../types";
import { extractDateFromText } from "./dates";

const FORM_HEADERS = [/form/i, /modelo/i, /template/i];
const LOCAL_HEADERS = [/local/i, /cliente/i, /unidade/i, /site/i];
const ASSET_HEADERS = [/ativo/i, /asset/i, /equipamento/i];
const DATE_HEADERS = [/data/i, /preench/i, /realizado/i, /criacao/i];
const ID_HEADERS = [/^id$/i, /codigo/i, /c[oó]digo/i, /relat[oó]rio/i, /preench/i];

function normalizeHeader(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function findCellTextByHeader(
  row: RawReportRow,
  patterns: RegExp[]
): string | null {
  const cell = row.cells.find((item) =>
    patterns.some((pattern) => pattern.test(normalizeHeader(item.header)))
  );

  return cell?.text.trim() || null;
}

function collectNumericTokens(value: string): string[] {
  return value.match(/\b\d{4,}\b/g) ?? [];
}

export function extractReportIdFromRow(row: RawReportRow): string | null {
  const scored = new Map<string, number>();

  const idCellText = findCellTextByHeader(row, ID_HEADERS);
  if (idCellText) {
    for (const token of collectNumericTokens(idCellText)) {
      scored.set(token, Math.max(scored.get(token) ?? 0, 100));
    }
  }

  for (const action of row.actions) {
    const context = [
      action.id ?? "",
      action.href ?? "",
      action.text,
      ...Object.keys(action.dataset),
      ...Object.values(action.dataset),
    ].join(" ");

    const score = /form_fill|relatorio|report|fill/i.test(context) ? 90 : 70;
    for (const token of collectNumericTokens(context)) {
      scored.set(token, Math.max(scored.get(token) ?? 0, score));
    }

    const hrefMatch = action.href?.match(/form_fills\/(\d+)/i);
    if (hrefMatch) {
      scored.set(hrefMatch[1], Math.max(scored.get(hrefMatch[1]) ?? 0, 95));
    }
  }

  for (const token of collectNumericTokens(JSON.stringify(row.rowDataset))) {
    scored.set(token, Math.max(scored.get(token) ?? 0, 60));
  }

  for (const link of row.links) {
    const hrefMatch = link.match(/form_fills\/(\d+)/i);
    if (hrefMatch) {
      scored.set(hrefMatch[1], Math.max(scored.get(hrefMatch[1]) ?? 0, 85));
    }
  }

  const sorted = [...scored.entries()].sort((left, right) => {
    if (right[1] !== left[1]) {
      return right[1] - left[1];
    }

    return right[0].length - left[0].length;
  });

  return sorted[0]?.[0] ?? null;
}

export function extractFormNameFromRow(row: RawReportRow): string | null {
  return findCellTextByHeader(row, FORM_HEADERS);
}

export function extractLocalNameFromRow(row: RawReportRow): string | null {
  return findCellTextByHeader(row, LOCAL_HEADERS);
}

export function extractAssetNameFromRow(row: RawReportRow): string | null {
  return findCellTextByHeader(row, ASSET_HEADERS);
}

export function extractReportDateFromRow(row: RawReportRow): ReportDateInfo | null {
  const dateCellText = findCellTextByHeader(row, DATE_HEADERS);
  if (dateCellText) {
    const parsed = extractDateFromText(dateCellText);
    if (parsed) {
      return parsed;
    }
  }

  return extractDateFromText(row.rowText);
}

export function extractExportButtonId(row: RawReportRow): string | null {
  for (const action of row.actions) {
    if (
      action.id &&
      (/export/i.test(action.id) ||
        /download/i.test(action.id) ||
        /pdf/i.test(action.text) ||
        /export/i.test(action.text))
    ) {
      return action.id;
    }
  }

  return row.actions.find((action) => action.id)?.id ?? null;
}
