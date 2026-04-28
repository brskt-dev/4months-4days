import fs from "node:fs";
import path from "node:path";

export async function ensureDir(dirPath: string): Promise<void> {
  await fs.promises.mkdir(dirPath, { recursive: true });
}

function isRetryableFileWriteError(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) {
    return false;
  }

  const code = String((error as NodeJS.ErrnoException).code ?? "");
  return ["EPERM", "EBUSY", "ENOTEMPTY", "EMFILE"].includes(code);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function deleteFileIfExists(filePath: string): Promise<void> {
  try {
    await fs.promises.unlink(filePath);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      String((error as NodeJS.ErrnoException).code ?? "") !== "ENOENT"
    ) {
      throw error;
    }
  }
}

export async function writeJsonAtomic(
  filePath: string,
  data: unknown
): Promise<void> {
  await ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random()
    .toString(16)
    .slice(2)}.tmp`;
  const backupPath = `${filePath}.${process.pid}.bak`;
  await fs.promises.writeFile(tempPath, JSON.stringify(data, null, 2), "utf8");

  let lastError: unknown = null;

  for (let attempt = 1; attempt <= 5; attempt++) {
    let backupCreated = false;

    try {
      await deleteFileIfExists(backupPath);

      if (await fileExists(filePath)) {
        await fs.promises.rename(filePath, backupPath);
        backupCreated = true;
      }

      await fs.promises.rename(tempPath, filePath);

      if (backupCreated) {
        await fs.promises.unlink(backupPath).catch(() => undefined);
      }

      return;
    } catch (error) {
      lastError = error;

      if (backupCreated && !(await fileExists(filePath))) {
        await fs.promises.rename(backupPath, filePath).catch(() => undefined);
      }

      if (!isRetryableFileWriteError(error) || attempt === 5) {
        await fs.promises.unlink(tempPath).catch(() => undefined);
        await fs.promises.unlink(backupPath).catch(() => undefined);
        throw error;
      }

      await sleep(attempt * 200);
    }
  }

  await fs.promises.unlink(tempPath).catch(() => undefined);
  await fs.promises.unlink(backupPath).catch(() => undefined);
  throw lastError instanceof Error
    ? lastError
    : new Error("Falha ao persistir arquivo JSON.");
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
  return validatePdfFileWithOptions(filePath);
}

export async function validatePdfFileWithOptions(
  filePath: string,
  options?: {
    skipSignatureCheck?: boolean;
  }
): Promise<{
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

    if (options?.skipSignatureCheck) {
      return { valid: true, sizeBytes: stats.size, reason: null };
    }

    const handle = await fs.promises.open(filePath, "r");
    try {
      const probeLength = Math.min(stats.size, 1024);
      const buffer = Buffer.alloc(probeLength);
      await handle.read(buffer, 0, probeLength, 0);
      const headerText = buffer.toString("latin1");

      if (!headerText.includes("%PDF")) {
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
