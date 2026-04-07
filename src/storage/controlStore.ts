import { ControlFile, ControlRecord } from "../types";
import { nowIso } from "../utils/dates";
import { readJsonFile, writeJsonAtomic } from "../utils/filesystem";

const EMPTY_CONTROL_FILE: ControlFile = {
  version: 1,
  updatedAt: "",
  records: {},
};

export async function loadControlFile(filePath: string): Promise<ControlFile> {
  return readJsonFile(filePath, EMPTY_CONTROL_FILE);
}

export async function saveControlFile(
  filePath: string,
  controlFile: ControlFile
): Promise<void> {
  controlFile.updatedAt = nowIso();
  await writeJsonAtomic(filePath, controlFile);
}

export function upsertControlRecord(
  controlFile: ControlFile,
  record: ControlRecord
): void {
  controlFile.records[record.reportId] = record;
  controlFile.updatedAt = nowIso();
}

export function getControlRecords(controlFile: ControlFile): ControlRecord[] {
  return Object.values(controlFile.records);
}
