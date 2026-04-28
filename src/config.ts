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

function parseClampedNumber(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string
): number {
  const parsed = parseNumber(value, fallback);
  const normalized = Math.max(minimum, Math.min(parsed, maximum));

  if (parsed !== normalized) {
    console.warn(
      `${label}=${parsed} ajustado para ${normalized} para evitar excesso de abas/processos do Chromium.`
    );
  }

  return normalized;
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
const downloadTempDir =
  process.env.DOWNLOAD_TEMP_DIR ?? path.join("temp", "download-staging");
const planningMode =
  process.env.PLANNING_MODE?.trim().toLowerCase() === "date-only-catchup"
    ? "date-only-catchup"
    : "default";
const deliveryMode =
  process.env.DELIVERY_MODE?.trim().toLowerCase() === "sharepoint-session-rest"
    ? "sharepoint-session-rest"
    : "local";
const maxPlanningConcurrency = Math.max(
  1,
  parseNumber(process.env.MAX_PLANNING_CONCURRENCY, 12)
);
const maxDownloadConcurrency = Math.max(
  1,
  parseNumber(process.env.MAX_DOWNLOAD_CONCURRENCY, 6)
);
const maxSharePointUploadConcurrency = Math.max(
  1,
  parseNumber(process.env.MAX_SHAREPOINT_UPLOAD_CONCURRENCY, 4)
);
const maxPreflightConcurrency = Math.max(
  1,
  parseNumber(process.env.MAX_PREFLIGHT_CONCURRENCY, 16)
);

export const config = {
  email: process.env.PRODUTTIVO_EMAIL ?? "",
  password: process.env.PRODUTTIVO_PASSWORD ?? "",
  baseUrl,
  browserHeadless: parseBoolean(process.env.PLAYWRIGHT_HEADLESS, false),
  downloadsDir,
  downloadTempDir,
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
    deliveryMode,
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
    planningConcurrency: parseClampedNumber(
      process.env.PLANNING_CONCURRENCY,
      1,
      1,
      maxPlanningConcurrency,
      "PLANNING_CONCURRENCY"
    ),
    downloadConcurrency: parseClampedNumber(
      process.env.DOWNLOAD_CONCURRENCY,
      1,
      1,
      maxDownloadConcurrency,
      "DOWNLOAD_CONCURRENCY"
    ),
    sharepointUploadConcurrency: parseClampedNumber(
      process.env.SHAREPOINT_UPLOAD_CONCURRENCY,
      4,
      1,
      maxSharePointUploadConcurrency,
      "SHAREPOINT_UPLOAD_CONCURRENCY"
    ),
    preflightConcurrency: parseClampedNumber(
      process.env.PREFLIGHT_CONCURRENCY,
      12,
      1,
      maxPreflightConcurrency,
      "PREFLIGHT_CONCURRENCY"
    ),
    pollingIntervalMs: Math.max(
      500,
      parseNumber(process.env.EXPORT_POLL_INTERVAL_MS, 1_500)
    ),
    skipValidated: parseBoolean(process.env.SKIP_VALIDATED, true),
    overwriteExisting: parseBoolean(process.env.OVERWRITE_EXISTING, false),
    deleteTempAfterRemoteUpload: parseBoolean(
      process.env.DELETE_TEMP_AFTER_REMOTE_UPLOAD,
      true
    ),
    pauseBeforeSharePointLogin: parseBoolean(
      process.env.PAUSE_BEFORE_SHAREPOINT_LOGIN,
      true
    ),
  },
  sharepoint: {
    targetUrl: process.env.SHAREPOINT_TARGET_URL ?? "",
    siteUrl: process.env.SHAREPOINT_SITE_URL ?? "",
    rootFolderServerRelativePath:
      process.env.SHAREPOINT_ROOT_FOLDER_SERVER_RELATIVE_PATH ?? "",
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
    sharepointLoginReleaseFile: path.join(
      artifactsDir,
      "control",
      "sharepoint-login.release"
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
