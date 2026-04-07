import path from "node:path";
import { StructuredLogEvent } from "../types";
import { nowIso } from "../utils/dates";
import { appendLine } from "../utils/filesystem";

export class RunLogger {
  constructor(
    private readonly runId: string,
    private readonly runDir: string
  ) {}

  private async write(event: StructuredLogEvent): Promise<void> {
    const filePath = path.join(this.runDir, "events.ndjson");
    await appendLine(filePath, JSON.stringify(event));
  }

  async log(
    level: StructuredLogEvent["level"],
    stage: string,
    message: string,
    metadata?: Record<string, unknown>,
    reportId?: string
  ): Promise<void> {
    const event: StructuredLogEvent = {
      timestamp: nowIso(),
      runId: this.runId,
      level,
      stage,
      message,
      reportId,
      metadata,
    };

    const printable = reportId ? `[${reportId}] ${message}` : message;
    if (level === "error") {
      console.error(printable);
    } else if (level === "warn") {
      console.warn(printable);
    } else {
      console.log(printable);
    }

    await this.write(event);
  }

  async info(
    stage: string,
    message: string,
    metadata?: Record<string, unknown>,
    reportId?: string
  ): Promise<void> {
    await this.log("info", stage, message, metadata, reportId);
  }

  async warn(
    stage: string,
    message: string,
    metadata?: Record<string, unknown>,
    reportId?: string
  ): Promise<void> {
    await this.log("warn", stage, message, metadata, reportId);
  }

  async error(
    stage: string,
    message: string,
    metadata?: Record<string, unknown>,
    reportId?: string
  ): Promise<void> {
    await this.log("error", stage, message, metadata, reportId);
  }
}
