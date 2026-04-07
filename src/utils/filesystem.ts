import fs from "node:fs";
import path from "node:path";

export async function ensureDir(dirPath: string): Promise<void> {
  await fs.promises.mkdir(dirPath, { recursive: true });
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function writeJsonAtomic(
  filePath: string,
  data: unknown
): Promise<void> {
  await ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.tmp`;
  await fs.promises.writeFile(tempPath, JSON.stringify(data, null, 2), "utf8");
  await fs.promises.rename(tempPath, filePath);
}

export async function readJsonFile<T>(
  filePath: string,
  fallback: T
): Promise<T> {
  if (!(await fileExists(filePath))) {
    return fallback;
  }

  const raw = await fs.promises.readFile(filePath, "utf8");
  return JSON.parse(raw) as T;
}

export async function appendLine(filePath: string, line: string): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await fs.promises.appendFile(filePath, `${line}\n`, "utf8");
}

export async function validatePdfFile(filePath: string): Promise<{
  valid: boolean;
  sizeBytes: number;
  reason: string | null;
}> {
  try {
    const stats = await fs.promises.stat(filePath);
    if (!stats.isFile()) {
      return { valid: false, sizeBytes: 0, reason: "Arquivo nao encontrado." };
    }

    if (stats.size <= 0) {
      return { valid: false, sizeBytes: stats.size, reason: "Arquivo vazio." };
    }

    if (path.extname(filePath).toLowerCase() !== ".pdf") {
      return {
        valid: false,
        sizeBytes: stats.size,
        reason: "Extensao diferente de .pdf.",
      };
    }

    const handle = await fs.promises.open(filePath, "r");
    try {
      const buffer = Buffer.alloc(4);
      await handle.read(buffer, 0, 4, 0);

      if (buffer.toString("utf8") !== "%PDF") {
        return {
          valid: false,
          sizeBytes: stats.size,
          reason: "Assinatura de PDF invalida.",
        };
      }
    } finally {
      await handle.close();
    }

    return { valid: true, sizeBytes: stats.size, reason: null };
  } catch (error) {
    return {
      valid: false,
      sizeBytes: 0,
      reason:
        error instanceof Error ? error.message : "Falha ao validar arquivo.",
    };
  }
}
