export type FormType = {
  id: string;
  name: string;
};

export type ResourcePlace = {
  id: string;
  name: string;
};

export type ReportFilters = {
  formId?: string | null;
  localId?: string | null;
  assetId?: string | null;
  startDate: string;
  endDate: string;
  extraQueryParams?: Record<string, string | string[]>;
};

export type ReportTotals = {
  reportsPerPage: number;
  lastPageCount: number;
  totalPages: number;
  totalReports: number;
};

export type FillWorkflowOptions = {
  workId: number;
  repeatCount: number;
  answerText: string;
};

export type PlanningStatus = "planned" | "error";

export type ExtractionStatus =
  | "queued"
  | "request_created"
  | "processing"
  | "ready_to_download"
  | "downloaded"
  | "skipped"
  | "error";

export type DownloadStatus = "pending" | "downloaded" | "skipped" | "error";

export type ValidationStatus = "pending" | "validated" | "skipped" | "error";

export type ExecutionStatus =
  | "planned"
  | "queued"
  | "request_created"
  | "processing"
  | "ready_to_download"
  | "downloaded"
  | "validated"
  | "skipped"
  | "error";

export type ReportDateInfo = {
  raw: string;
  iso: string;
  year: string;
};

export type ExtractionScope = {
  scopeId: string;
  scopeLabel: string;
  formId?: string | null;
  formName?: string | null;
  localId?: string | null;
  localName?: string | null;
  assetId?: string | null;
  assetName?: string | null;
  startDate: string;
  endDate: string;
  extraQueryParams?: Record<string, string | string[]>;
};

export type ExtractionPlanFile = {
  scopes: Array<Partial<ExtractionScope>>;
};

export type FilterTrace = {
  scopeId: string;
  scopeLabel: string;
  formId?: string | null;
  localId?: string | null;
  assetId?: string | null;
  startDate: string;
  endDate: string;
  sourceUrl: string;
};

export type RawRowCell = {
  header: string;
  text: string;
};

export type RawRowAction = {
  id: string | null;
  text: string;
  href: string | null;
  dataset: Record<string, string>;
};

export type RawReportRow = {
  rowIndex: number;
  rowText: string;
  rowHtml: string;
  rowDataset: Record<string, string>;
  cells: RawRowCell[];
  actions: RawRowAction[];
  links: string[];
};

export type PlannedReportItem = {
  reportId: string;
  formName: string;
  localName: string;
  assetName: string | null;
  reportDate: string;
  reportDateRaw: string;
  year: string;
  sourcePage: number;
  sourceRowIndex: number;
  sourceUrl: string;
  exportButtonId: string | null;
  rowText: string;
  rowHtml: string;
  rowDataset: Record<string, string>;
  filterFormId: string | null;
  filterLocalId: string | null;
  filterAssetId: string | null;
  filterStartDate: string;
  filterEndDate: string;
  plannedFolder: string;
  plannedFilename: string;
  plannedPath: string;
  discoveredAt: string;
  discoveredInRunId: string;
  filterTrace: FilterTrace[];
};

export type PlanningFailure = {
  scopeId: string;
  sourcePage: number;
  sourceRowIndex: number;
  rowText: string;
  reason: string;
  discoveredAt: string;
};

export type ControlRecord = PlannedReportItem & {
  planningStatus: PlanningStatus;
  extractionStatus: ExtractionStatus;
  downloadStatus: DownloadStatus;
  validationStatus: ValidationStatus;
  executionStatus: ExecutionStatus;
  attemptCount: number;
  exportRequestId: string | null;
  errorMessage: string | null;
  errorStage: string | null;
  lastUpdate: string;
  lastAttemptAt: string | null;
  downloadedAt: string | null;
  validatedAt: string | null;
  fileSizeBytes: number | null;
  skippedReason: string | null;
  lastPlannedRunId: string;
  lastExecutionRunId: string | null;
};

export type ControlFile = {
  version: number;
  updatedAt: string;
  records: Record<string, ControlRecord>;
};

export type ScopePlanningSummary = {
  scopeId: string;
  scopeLabel: string;
  sourceUrl: string;
  expectedTotalReports: number;
  extractedRows: number;
  totalPages: number;
  reportsPerPage: number;
  lastPageCount: number;
  inconsistencies: string[];
  telemetry?: {
    totalsInspectionMs: number;
    pageNavigationMs: number;
    tableWaitMs: number;
    rowExtractionMs: number;
    rowProcessingMs: number;
    totalScopeMs: number;
    pagesVisited: number;
  };
};

export type RunArtifacts = {
  runId: string;
  startedAt: string;
  finishedAt: string | null;
  plannedItemCount: number;
  processedItemCount: number;
  planningFailures: number;
  filtersProcessed: ScopePlanningSummary[];
};

export type PlanningCheckpoint = {
  version: number;
  updatedAt: string;
  scopeSignature: string;
  completedScopeIds: string[];
  plannedItems: PlannedReportItem[];
  planningFailures: PlanningFailure[];
  scopeSummaries: ScopePlanningSummary[];
};

export type SummaryBucket = {
  key: string;
  planned: number;
  downloaded: number;
  validated: number;
  skipped: number;
  error: number;
  pendingRetry: number;
};

export type ExecutionSummary = {
  runId: string;
  startedAt: string;
  finishedAt: string;
  filtersProcessed: ScopePlanningSummary[];
  totalReportsIdentified: number;
  totalExportRequestsCreated: number;
  totalDownloadsConcluded: number;
  totalValidated: number;
  totalFailures: number;
  totalSkipped: number;
  totalPendingRetry: number;
  pendingItems: Array<{
    reportId: string;
    executionStatus: ExecutionStatus;
    attemptCount: number;
    errorMessage: string | null;
    plannedPath: string;
  }>;
  byForm: SummaryBucket[];
  byLocal: SummaryBucket[];
  byYear: SummaryBucket[];
};

export type LogLevel = "info" | "warn" | "error";

export type StructuredLogEvent = {
  timestamp: string;
  runId: string;
  level: LogLevel;
  stage: string;
  message: string;
  reportId?: string;
  metadata?: Record<string, unknown>;
};

export type ExportRequestResult = {
  exportRequestId: string | null;
  suggestedFilename: string;
};
