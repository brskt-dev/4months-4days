import fs from "node:fs";
import path from "node:path";
import {
  APIRequestContext,
  Browser,
  BrowserContext,
  Page,
  chromium,
} from "playwright";
import { config } from "../config";
import { RunLogger } from "../logging/runLogger";
import { isShutdownRequested } from "../runtime/shutdown";
import { fileExists } from "../utils/filesystem";

const SHAREPOINT_POLL_MS = 5_000;

type SharePointContextInfo = {
  FormDigestValue?: string;
  FormDigestTimeoutSeconds?: number;
};

type SharePointUploadResult = {
  remoteDeliveryPath: string;
  remoteDeliveryUrl: string | null;
  remoteUploadedAt: string;
};

export type SharePointSessionHandle = {
  client: SharePointSessionRestClient;
  close: () => Promise<void>;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeODataString(value: string): string {
  return value.replace(/'/g, "''");
}

function buildAbsoluteSharePointUrl(serverRelativePath: string): string | null {
  if (!serverRelativePath) {
    return null;
  }

  try {
    return new URL(serverRelativePath, config.sharepoint.siteUrl).toString();
  } catch {
    return null;
  }
}

function extractSharePointErrorMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const asRecord = payload as Record<string, unknown>;
  const topLevelMessage =
    typeof asRecord["error_description"] === "string"
      ? asRecord["error_description"]
      : typeof asRecord["message"] === "string"
        ? asRecord["message"]
        : null;

  if (topLevelMessage) {
    return topLevelMessage;
  }

  const error = asRecord["error"];
  if (!error || typeof error !== "object") {
    return null;
  }

  const errorRecord = error as Record<string, unknown>;
  const nestedMessage = errorRecord["message"];
  if (typeof nestedMessage === "string") {
    return nestedMessage;
  }

  if (nestedMessage && typeof nestedMessage === "object") {
    const verboseMessage = (nestedMessage as Record<string, unknown>)["value"];
    if (typeof verboseMessage === "string") {
      return verboseMessage;
    }
  }

  return null;
}

function isAlreadyExistsError(message: string | null): boolean {
  if (!message) {
    return false;
  }

  const normalized = message.toLowerCase();
  return (
    normalized.includes("already exists") ||
    normalized.includes("já existe") ||
    normalized.includes("ja existe") ||
    normalized.includes("duplicate")
  );
}

async function parseJsonResponse(response: Awaited<ReturnType<APIRequestContext["fetch"]>>): Promise<unknown> {
  const contentType = response.headers()["content-type"] ?? "";
  if (!contentType.toLowerCase().includes("json")) {
    return null;
  }

  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function readResponseBody(
  response: Awaited<ReturnType<APIRequestContext["fetch"]>>
): Promise<string | null> {
  try {
    const body = await response.text();
    const normalized = body.trim();
    return normalized ? normalized : null;
  } catch {
    return null;
  }
}

async function waitForSharePointLoginRelease(logger: RunLogger): Promise<boolean> {
  if (!config.execution.pauseBeforeSharePointLogin) {
    return true;
  }

  await logger.warn(
    "sharepoint",
    "Aguardando login manual no SharePoint antes de iniciar os uploads remotos.",
    {
      targetUrl: config.sharepoint.targetUrl,
      releaseFile: config.paths.sharepointLoginReleaseFile,
    }
  );

  while (true) {
    if (isShutdownRequested()) {
      await logger.warn(
        "sharepoint",
        "Shutdown solicitado enquanto a execucao aguardava login manual no SharePoint."
      );
      return false;
    }

    if (await fileExists(config.paths.sharepointLoginReleaseFile)) {
      await logger.info(
        "sharepoint",
        "Liberacao manual detectada para a sessao SharePoint.",
        {
          releaseFile: config.paths.sharepointLoginReleaseFile,
        }
      );
      return true;
    }

    await sleep(SHAREPOINT_POLL_MS);
  }
}

export class SharePointSessionRestClient {
  private digestValue: string | null = null;
  private digestExpiresAt = 0;
  private readonly folderCache = new Set<string>();
  private readonly folderEnsureQueue = new Map<string, Promise<void>>();
  private readonly rootFolderPath: string;

  constructor(
    private readonly requestContext: APIRequestContext,
    private readonly logger: RunLogger
  ) {
    this.rootFolderPath =
      config.sharepoint.rootFolderServerRelativePath.replace(/\\/g, "/");
    this.folderCache.add(this.rootFolderPath);
  }

  private async getRequestDigest(): Promise<string> {
    const now = Date.now();
    if (this.digestValue && now < this.digestExpiresAt) {
      return this.digestValue;
    }

    const response = await this.requestContext.fetch(
      `${config.sharepoint.siteUrl}/_api/contextinfo`,
      {
        method: "POST",
        headers: {
          Accept: "application/json;odata=nometadata",
        },
      }
    );

    if (!response.ok()) {
      const payload = await parseJsonResponse(response);
      throw new Error(
        extractSharePointErrorMessage(payload) ??
          `Falha ao obter RequestDigest do SharePoint (${response.status()}).`
      );
    }

    const payload = (await parseJsonResponse(response)) as
      | SharePointContextInfo
      | { d?: { GetContextWebInformation?: SharePointContextInfo } }
      | null;
    const contextInfo: SharePointContextInfo | null =
      payload && "d" in payload && payload.d?.GetContextWebInformation
        ? payload.d.GetContextWebInformation
        : (payload as SharePointContextInfo | null);
    const digest = contextInfo?.FormDigestValue;
    const timeoutSeconds = contextInfo?.FormDigestTimeoutSeconds ?? 1200;

    if (!digest) {
      throw new Error(
        "Resposta do SharePoint nao trouxe FormDigestValue para operacoes de upload."
      );
    }

    this.digestValue = digest;
    this.digestExpiresAt = now + Math.max(60, timeoutSeconds - 60) * 1000;
    return digest;
  }

  private async buildWriteHeaders(): Promise<Record<string, string>> {
    return {
      Accept: "application/json;odata=nometadata",
      "X-RequestDigest": await this.getRequestDigest(),
    };
  }

  private async folderExists(folderServerRelativePath: string): Promise<boolean> {
    const response = await this.requestContext.fetch(
      `${config.sharepoint.siteUrl}/_api/web/GetFolderByServerRelativePath(decodedurl='${escapeODataString(
        folderServerRelativePath
      )}')`,
      {
        method: "GET",
        headers: {
          Accept: "application/json;odata=nometadata",
        },
      }
    );

    if (response.ok()) {
      return true;
    }

    if (response.status() === 404) {
      return false;
    }

    const payload = await parseJsonResponse(response);
    const body = await readResponseBody(response);
    throw new Error(
      extractSharePointErrorMessage(payload) ??
        body ??
        `Falha ao consultar pasta remota ${folderServerRelativePath} (${response.status()}).`
    );
  }

  private async ensureFolderInternal(folderServerRelativePath: string): Promise<void> {
    const normalizedFolder = folderServerRelativePath.replace(/\\/g, "/");

    if (
      !normalizedFolder ||
      this.folderCache.has(normalizedFolder) ||
      normalizedFolder === "/" ||
      normalizedFolder === "."
    ) {
      return;
    }

    const inFlight = this.folderEnsureQueue.get(normalizedFolder);
    if (inFlight) {
      await inFlight;
      return;
    }

    const task = (async () => {
      const parent = path.posix.dirname(normalizedFolder);
      if (parent && parent !== normalizedFolder) {
        await this.ensureFolderInternal(parent);
      }

      if (await this.folderExists(normalizedFolder)) {
        this.folderCache.add(normalizedFolder);
        return;
      }

      const folderName = path.posix.basename(normalizedFolder);

      const response = await this.requestContext.fetch(
        `${config.sharepoint.siteUrl}/_api/web/GetFolderByServerRelativePath(decodedurl='${escapeODataString(
          parent
        )}')/Folders/AddUsingPath(decodedurl='${escapeODataString(folderName)}')`,
        {
          method: "POST",
          headers: await this.buildWriteHeaders(),
        }
      );

      if (!response.ok()) {
        const payload = await parseJsonResponse(response);
        const message = extractSharePointErrorMessage(payload);
        const body = await readResponseBody(response);
        if (!isAlreadyExistsError(message)) {
          throw new Error(
            message ??
              body ??
              `Falha ao garantir pasta remota ${normalizedFolder} (${response.status()}).`
          );
        }
      }

      this.folderCache.add(normalizedFolder);
    })();

    this.folderEnsureQueue.set(normalizedFolder, task);
    try {
      await task;
    } finally {
      this.folderEnsureQueue.delete(normalizedFolder);
    }
  }

  async ensureFolder(folderServerRelativePath: string): Promise<void> {
    await this.ensureFolderInternal(folderServerRelativePath);
  }

  async uploadFile(
    localFilePath: string,
    remoteFileServerRelativePath: string
  ): Promise<SharePointUploadResult> {
    const remotePath = remoteFileServerRelativePath.replace(/\\/g, "/");
    const remoteFolder = path.posix.dirname(remotePath);
    const remoteFileName = path.posix.basename(remotePath);

    await this.ensureFolder(remoteFolder);

    const fileBuffer = await fs.promises.readFile(localFilePath);
    const response = await this.requestContext.fetch(
      `${config.sharepoint.siteUrl}/_api/web/GetFolderByServerRelativePath(decodedurl='${escapeODataString(
        remoteFolder
      )}')/Files/AddUsingPath(decodedurl='${escapeODataString(
        remoteFileName
      )}',overwrite=${config.execution.overwriteExisting ? "true" : "false"})`,
      {
        method: "POST",
        headers: {
          ...(await this.buildWriteHeaders()),
          "Content-Type": "application/octet-stream",
        },
        data: fileBuffer,
      }
    );

    if (!response.ok()) {
      const payload = await parseJsonResponse(response);
      const message = extractSharePointErrorMessage(payload);
      if (!config.execution.overwriteExisting && isAlreadyExistsError(message)) {
        return {
          remoteDeliveryPath: remotePath,
          remoteDeliveryUrl: buildAbsoluteSharePointUrl(remotePath),
          remoteUploadedAt: new Date().toISOString(),
        };
      }

      throw new Error(
        message ??
          `Falha ao enviar arquivo para o SharePoint (${response.status()}).`
      );
    }

    const payload = (await parseJsonResponse(response)) as
      | Record<string, unknown>
      | null;
    const uploadedAt = new Date().toISOString();
    const serverRelativePath =
      (typeof payload?.["ServerRelativeUrl"] === "string"
        ? payload["ServerRelativeUrl"]
        : null) ??
      (typeof payload?.["ServerRelativePath"] === "object"
        ? String(
            (payload["ServerRelativePath"] as Record<string, unknown>)["DecodedUrl"] ??
              remotePath
          )
        : null) ??
      remotePath;

    return {
      remoteDeliveryPath: serverRelativePath,
      remoteDeliveryUrl: buildAbsoluteSharePointUrl(serverRelativePath),
      remoteUploadedAt: uploadedAt,
    };
  }
}

export async function prepareSharePointSession(
  _page: Page,
  logger: RunLogger
): Promise<SharePointSessionHandle | null> {
  if (config.execution.deliveryMode !== "sharepoint-session-rest") {
    return null;
  }

  if (
    !config.sharepoint.targetUrl ||
    !config.sharepoint.siteUrl ||
    !config.sharepoint.rootFolderServerRelativePath
  ) {
    throw new Error(
      "Configuracao SharePoint incompleta. Defina SHAREPOINT_TARGET_URL, SHAREPOINT_SITE_URL e SHAREPOINT_ROOT_FOLDER_SERVER_RELATIVE_PATH."
    );
  }

  if (config.browserHeadless) {
    throw new Error(
      "O modo sharepoint-session-rest requer PLAYWRIGHT_HEADLESS=false para login manual no SharePoint."
    );
  }

  let sharePointBrowser: Browser | null = null;
  let sharePointContext: BrowserContext | null = null;
  let sharePointPage: Page | null = null;

  try {
    sharePointBrowser = await chromium.launch({
      headless: config.browserHeadless,
    });
    sharePointContext = await sharePointBrowser.newContext();
    sharePointContext.setDefaultNavigationTimeout(60_000);
    sharePointContext.setDefaultTimeout(60_000);
    sharePointPage = await sharePointContext.newPage();
    await sharePointPage.goto(
      config.sharepoint.targetUrl || config.sharepoint.siteUrl,
      { waitUntil: "domcontentloaded" }
    );
    await sharePointPage.bringToFront().catch(() => undefined);

    const released = await waitForSharePointLoginRelease(logger);
    if (!released) {
      await sharePointBrowser.close().catch(() => undefined);
      return null;
    }

    const client = new SharePointSessionRestClient(sharePointContext.request, logger);
    await client.ensureFolder(config.sharepoint.rootFolderServerRelativePath);
    await logger.info(
      "sharepoint",
      "Sessao SharePoint preparada para uploads remotos.",
      {
        targetUrl: config.sharepoint.targetUrl,
        rootFolderServerRelativePath:
          config.sharepoint.rootFolderServerRelativePath,
      }
    );

    return {
      client,
      close: async () => {
        await sharePointBrowser?.close().catch(() => undefined);
      },
    };
  } catch (error) {
    await sharePointPage?.close().catch(() => undefined);
    await sharePointContext?.close().catch(() => undefined);
    await sharePointBrowser?.close().catch(() => undefined);
    throw error;
  }
}
