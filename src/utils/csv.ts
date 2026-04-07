import fs from "node:fs";
import path from "node:path";
import { ensureDir } from "./filesystem";

function escapeCsvValue(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }

  return value;
}

export async function writeCsvFile(
  filePath: string,
  headers: string[],
  rows: Array<Record<string, string>>
): Promise<void> {
  await ensureDir(path.dirname(filePath));

  const lines = [
    headers.map(escapeCsvValue).join(","),
    ...rows.map((row) =>
      headers.map((header) => escapeCsvValue(row[header] ?? "")).join(",")
    ),
  ];

  await fs.promises.writeFile(filePath, `${lines.join("\n")}\n`, "utf8");
}
