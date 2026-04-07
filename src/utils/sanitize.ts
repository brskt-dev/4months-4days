const INVALID_FILE_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g;
const WHITESPACE = /\s+/g;

export function sanitizePathSegment(value: string, fallback = "unknown"): string {
  const sanitized = value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(INVALID_FILE_CHARS, "_")
    .replace(WHITESPACE, " ")
    .trim()
    .replace(/[. ]+$/, "");

  return sanitized || fallback;
}

export function sanitizeFileName(value: string, fallback = "file"): string {
  const sanitized = sanitizePathSegment(value, fallback).replace(/\s+/g, "_");
  return sanitized || fallback;
}

export function buildScopeId(...parts: Array<string | null | undefined>): string {
  return parts
    .filter(Boolean)
    .map((part) => sanitizeFileName(String(part)))
    .join("__")
    .toLowerCase();
}
