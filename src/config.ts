import path from "node:path";
import dotenv from "dotenv";

dotenv.config();

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value) {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function parseNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const baseUrl = (
  process.env.PRODUTTIVO_BASE_URL ?? "https://app.produttivo.com.br"
).replace(/\/$/, "");

const reportLocalQueryParam =
  process.env.REPORT_LOCAL_QUERY_PARAM?.trim() ||
  "form_fill[resource_place_ids][]";
const reportAssetQueryParam = process.env.REPORT_ASSET_QUERY_PARAM?.trim() ?? "";

const downloadsDir = process.env.DOWNLOADS_DIR ?? "downloads";
const artifactsDir = process.env.AUTOMATION_ARTIFACTS_DIR ?? "automation-artifacts";
const planningMode =
  process.env.PLANNING_MODE?.trim().toLowerCase() === "date-only-catchup"
    ? "date-only-catchup"
    : "default";

export const config = {
  email: process.env.PRODUTTIVO_EMAIL ?? "",
  password: process.env.PRODUTTIVO_PASSWORD ?? "",
  baseUrl,
  browserHeadless: parseBoolean(process.env.PLAYWRIGHT_HEADLESS, false),
  downloadsDir,
  artifactsDir,
  reports: {
    accountId: process.env.PRODUTTIVO_ACCOUNT_ID ?? "259345",
    defaultStartDate: process.env.REPORT_START_DATE ?? "01/01/2000",
    defaultEndDate: process.env.REPORT_END_DATE ?? "31/12/2025",
    localQueryParam: reportLocalQueryParam,
    assetQueryParam: reportAssetQueryParam,
  },
  execution: {
    planningMode,
    extractionPlanFile: process.env.EXTRACTION_PLAN_FILE ?? "",
    resumeFromControl: parseBoolean(process.env.RESUME_FROM_CONTROL, false),
    pauseBeforeDownloadExecution: parseBoolean(
      process.env.PAUSE_BEFORE_DOWNLOAD_EXECUTION,
      false
    ),
    pauseBeforeExtraPlanning: parseBoolean(
      process.env.PAUSE_BEFORE_EXTRA_PLANNING,
      false
    ),
    enableUnknownLocalExtra: parseBoolean(
      process.env.ENABLE_UNKNOWN_LOCAL_EXTRA,
      false
    ),
    maxRetries: parseNumber(process.env.MAX_RETRIES, 3),
    planningConcurrency: Math.max(
      1,
      parseNumber(process.env.PLANNING_CONCURRENCY, 1)
    ),
    downloadConcurrency: Math.max(
      1,
      parseNumber(process.env.DOWNLOAD_CONCURRENCY, 1)
    ),
    pollingIntervalMs: Math.max(
      500,
      parseNumber(process.env.EXPORT_POLL_INTERVAL_MS, 1_500)
    ),
    skipValidated: parseBoolean(process.env.SKIP_VALIDATED, true),
    overwriteExisting: parseBoolean(process.env.OVERWRITE_EXISTING, false),
  },
  fill: {
    workId: parseNumber(process.env.FILL_WORK_ID, 0),
    repeatCount: parseNumber(process.env.FILL_REPEAT_COUNT, 1),
    answerText:
      process.env.FILL_ANSWER_TEXT ?? "Resposta automatica gerada pelo bot",
  },
  paths: {
    controlFile: path.join(artifactsDir, "control", "execution-state.json"),
    planningCheckpointFile: path.join(
      artifactsDir,
      "control",
      "planning-state.json"
    ),
    dateOnlyCatchupPlanningCheckpointFile: path.join(
      artifactsDir,
      "control",
      "planning-state.date-only-catchup.json"
    ),
    extraPlanningReleaseFile: path.join(
      artifactsDir,
      "control",
      "extra-planning.release"
    ),
    downloadExecutionReleaseFile: path.join(
      artifactsDir,
      "control",
      "download-execution.release"
    ),
    runsDir: path.join(artifactsDir, "runs"),
  },
};

if (!config.email || !config.password) {
  console.warn("PRODUTTIVO_EMAIL ou PRODUTTIVO_PASSWORD ausentes no .env");
}

export function buildAppUrl(pathname: string): string {
  return new URL(pathname, `${config.baseUrl}/`).toString();
}
