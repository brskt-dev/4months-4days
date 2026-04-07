import path from "node:path";
import { config } from "../config";
import { PlannedReportItem } from "../types";
import { sanitizeFileName, sanitizePathSegment } from "./sanitize";

export function buildPlannedFolder(
  formName: string,
  localName: string,
  year: string,
  prefixSegments: string[] = []
): string {
  return path.join(
    config.downloadsDir,
    ...prefixSegments.map((segment) => sanitizePathSegment(segment, "Extra")),
    sanitizePathSegment(formName, "UnknownForm"),
    sanitizePathSegment(localName, "UnknownLocal"),
    sanitizePathSegment(year, "UnknownYear")
  );
}

export function buildPlannedFileName(reportId: string): string {
  return `${sanitizeFileName(reportId, "report")}.pdf`;
}

export function buildPlannedPath(
  formName: string,
  localName: string,
  year: string,
  reportId: string,
  prefixSegments: string[] = []
): {
  folder: string;
  filename: string;
  fullPath: string;
} {
  const folder = buildPlannedFolder(formName, localName, year, prefixSegments);
  const filename = buildPlannedFileName(reportId);

  return {
    folder,
    filename,
    fullPath: path.join(folder, filename),
  };
}

export function getRunDir(runId: string): string {
  return path.join(config.paths.runsDir, runId);
}

export function toArtifactRelativePath(item: Pick<PlannedReportItem, "plannedPath">): string {
  return path.normalize(item.plannedPath);
}
