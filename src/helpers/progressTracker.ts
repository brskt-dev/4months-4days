import { promises as fs } from "fs";
import path from "path";

export interface ProgressState {
  totalReports: number;      // total de relatórios existentes
  reportsPerPage: number;    // registros por página "cheia"
  totalPages: number;        // total de páginas calculado
  downloaded: number;        // quantos já foram baixados
  currentPage: number;       // em qual página estamos (1-based)
  lastRunAt: string | null;  // ISO string da última execução
}

const PROGRESS_DIR = path.join(process.cwd(), ".cache");
const PROGRESS_FILE = path.join(PROGRESS_DIR, "progress.json");

function getDefaultProgress(): ProgressState {
  return {
    totalReports: 0,
    reportsPerPage: 0,
    totalPages: 0,
    downloaded: 0,
    currentPage: 1,
    lastRunAt: null,
  };
}

/**
 * Garante que a pasta .cache existe.
 */
async function ensureDir() {
  await fs.mkdir(PROGRESS_DIR, { recursive: true });
}

/**
 * Carrega o progresso do disco.
 * Se não existir, retorna o default.
 */
export async function loadProgress(): Promise<ProgressState> {
  try {
    const data = await fs.readFile(PROGRESS_FILE, "utf-8");
    const parsed = JSON.parse(data);

    // merge com default pra evitar campo faltando
    return {
      ...getDefaultProgress(),
      ...parsed,
    } as ProgressState;
  } catch {
    // arquivo não existe ou está inválido
    return getDefaultProgress();
  }
}

/**
 * Salva o progresso em disco.
 */
export async function saveProgress(progress: ProgressState): Promise<void> {
  await ensureDir();
  const payload = JSON.stringify(progress, null, 2);
  await fs.writeFile(PROGRESS_FILE, payload, "utf-8");
}

/**
 * Incrementa o contador de downloads e (opcionalmente)
 * atualiza a página atual.
 */
export async function incrementDownloads(
  delta: number = 1,
  currentPage?: number
): Promise<ProgressState> {
  const progress = await loadProgress();

  progress.downloaded += delta;
  if (currentPage !== undefined) {
    progress.currentPage = currentPage;
  }
  progress.lastRunAt = new Date().toISOString();

  await saveProgress(progress);
  return progress;
}

/**
 * Limpa o progresso (reset total).
 * Útil para recomeçar um job do zero.
 */
export async function resetProgress(): Promise<ProgressState> {
  try {
    await fs.unlink(PROGRESS_FILE);
  } catch {
    // se não existir, ignoramos
  }

  const fresh = getDefaultProgress();
  await saveProgress(fresh);
  return fresh;
}
