import { ReportDateInfo } from "../types";

const DATE_PATTERNS = [
  /^(\d{2})\/(\d{2})\/(\d{4})$/,
  /^(\d{4})-(\d{2})-(\d{2})$/,
];

export function toIsoDate(rawDate: string): string | null {
  const trimmed = rawDate.trim();

  const brazilianMatch = trimmed.match(DATE_PATTERNS[0]);
  if (brazilianMatch) {
    const [, day, month, year] = brazilianMatch;
    return `${year}-${month}-${day}`;
  }

  const isoMatch = trimmed.match(DATE_PATTERNS[1]);
  if (isoMatch) {
    return trimmed;
  }

  return null;
}

export function extractDateFromText(text: string): ReportDateInfo | null {
  const match = text.match(/\b\d{2}\/\d{2}\/\d{4}\b|\b\d{4}-\d{2}-\d{2}\b/);
  if (!match) {
    return null;
  }

  const iso = toIsoDate(match[0]);
  if (!iso) {
    return null;
  }

  return {
    raw: match[0],
    iso,
    year: iso.slice(0, 4),
  };
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function buildRunId(date = new Date()): string {
  const iso = date.toISOString();
  return iso.replace(/[:.]/g, "-");
}
