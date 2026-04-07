import { config } from "../config";
import { ROUTES } from "../constants";
import { ReportFilters } from "../types";

function appendParam(
  url: URL,
  key: string,
  value: string | string[] | null | undefined
): void {
  if (value === null || value === undefined || value === "") {
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item) => url.searchParams.append(key, item));
    return;
  }

  url.searchParams.append(key, value);
}

export function buildReportsUrl(filters: ReportFilters): string {
  const url = new URL(ROUTES.reports, `${config.baseUrl}/`);

  url.searchParams.append("utf8", "ok");
  appendParam(url, "form_fill[form_ids][]", filters.formId ?? "");
  if (config.reports.localQueryParam) {
    appendParam(url, config.reports.localQueryParam, filters.localId ?? undefined);
  }
  if (config.reports.assetQueryParam) {
    appendParam(url, config.reports.assetQueryParam, filters.assetId ?? undefined);
  }
  url.searchParams.append(
    "range_time",
    `${filters.startDate} - ${filters.endDate}`
  );
  url.searchParams.append("account_id", config.reports.accountId);
  url.searchParams.append("field_id", "-2");
  url.searchParams.append("order_type", "desc");

  for (const [key, value] of Object.entries(filters.extraQueryParams ?? {})) {
    appendParam(url, key, value);
  }

  return url.toString();
}

export function withPage(urlString: string, page: number): string {
  const url = new URL(urlString);
  url.searchParams.set("page", String(page));
  return url.toString();
}
