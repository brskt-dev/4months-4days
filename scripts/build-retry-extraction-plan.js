const fs = require("node:fs");
const path = require("node:path");

function printUsage() {
  console.error(
    [
      "Usage:",
      "  node scripts/build-retry-extraction-plan.js <planning-failures.json> [output-dir]",
      "",
      "Example:",
      "  node scripts/build-retry-extraction-plan.js bkp/automation-artifacts-18042026/runs/2026-04-18T00-15-54-703Z/planning-failures.json automation-artifacts/control",
    ].join("\n")
  );
}

function deriveRunId(inputPath) {
  const match = inputPath.match(/runs[\\/]+([^\\/]+)[\\/]+planning-failures\.json$/i);
  return match ? match[1] : "unknown-run";
}

function extractFailureUrl(reason) {
  const match = reason.match(/https:\/\/app\.produttivo\.com\.br\/form_fills[^\s"]+/);
  return match ? match[0] : null;
}

function buildRetryScope(failure) {
  const dateOnlyCatchupMatch = failure.scopeId.match(
    /^date-only-catchup-scope__(.+)__pages_(\d+)_(\d+)$/i
  );

  if (dateOnlyCatchupMatch) {
    const [, encodedPeriod, startPage, endPage] = dateOnlyCatchupMatch;
    const periodParts = encodedPeriod.split("_");
    const startDate = periodParts.slice(0, 3).join("/");
    const endDate = periodParts.slice(3, 6).join("/");

    return {
      scopeId: failure.scopeId,
      scopeLabel:
        failure.scopeLabel ??
        `UnknownCatchup__UnknownCatchup__${startDate}_${endDate}__pages_${startPage}_${endPage}`,
      formName: "UnknownCatchup",
      localName: "UnknownCatchup",
      startDate: startDate || "01/01/2000",
      endDate: endDate || "31/12/2025",
      pageRange: {
        start: Number(startPage),
        end: Number(endPage),
      },
    };
  }

  const urlString = extractFailureUrl(failure.reason);
  if (!urlString) {
    return null;
  }

  const url = new URL(urlString);
  const params = url.searchParams;
  const rawRange = params.get("range_time") ?? "";
  const [startDate, endDate] = rawRange.split(" - ");

  const scope = {
    scopeId: failure.scopeId,
    startDate: startDate || "01/01/2000",
    endDate: endDate || "31/12/2025",
  };

  const formIds = params.getAll("form_fill[form_ids][]").filter(Boolean);
  const localIds = params.getAll("form_fill[resource_place_ids][]").filter(Boolean);

  if (formIds[0]) {
    scope.formId = formIds[0];
  }

  if (localIds[0]) {
    scope.localId = localIds[0];
  }

  if (failure.scopeId.startsWith("extra-orphan-scope__")) {
    scope.formName = "UnknownForm";
  }

  if (failure.scopeId.startsWith("extra-unknown-local-scope__")) {
    scope.localName = "UnknownLocal";
  }

  return scope;
}

function classifyScope(scopeId) {
  if (scopeId.startsWith("date-only-catchup-scope__")) {
    return "date-only-catchup";
  }

  if (scopeId.startsWith("scope-")) {
    return "main";
  }

  if (
    scopeId.startsWith("extra-orphan-scope__") ||
    scopeId.startsWith("extra-unknown-local-scope__")
  ) {
    return "extra";
  }

  return "other";
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function main() {
  const inputPath = process.argv[2];
  const outputDir =
    process.argv[3] || path.join("automation-artifacts", "control");

  if (!inputPath) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const failures = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  const uniqueFailuresByScope = new Map();

  for (const failure of failures) {
    if (!uniqueFailuresByScope.has(failure.scopeId)) {
      uniqueFailuresByScope.set(failure.scopeId, failure);
    }
  }

  const scopes = [...uniqueFailuresByScope.values()]
    .map(buildRetryScope)
    .filter(Boolean)
    .sort((left, right) => {
      const leftKind = classifyScope(left.scopeId);
      const rightKind = classifyScope(right.scopeId);

      if (leftKind !== rightKind) {
        return leftKind.localeCompare(rightKind);
      }

      return left.scopeId.localeCompare(right.scopeId);
    });

  const mainScopes = scopes.filter((scope) => classifyScope(scope.scopeId) === "main");
  const extraScopes = scopes.filter(
    (scope) => classifyScope(scope.scopeId) === "extra"
  );
  const dateOnlyCatchupScopes = scopes.filter(
    (scope) => classifyScope(scope.scopeId) === "date-only-catchup"
  );
  const otherScopes = scopes.filter(
    (scope) => classifyScope(scope.scopeId) === "other"
  );

  const runId = deriveRunId(inputPath);
  const baseName = `extraction-plan.retry-failures.${runId}`;

  const allPath = path.join(outputDir, `${baseName}.all.json`);
  const mainOnlyPath = path.join(outputDir, `${baseName}.main-only.json`);
  const extraOnlyPath = path.join(outputDir, `${baseName}.extra-only.json`);
  const summaryPath = path.join(outputDir, `${baseName}.summary.json`);

  writeJson(allPath, { scopes });
  writeJson(mainOnlyPath, { scopes: mainScopes });
  writeJson(extraOnlyPath, { scopes: extraScopes });
  writeJson(summaryPath, {
    source: inputPath,
    runId,
    failureEntries: failures.length,
    uniqueScopes: scopes.length,
    mainScopes: mainScopes.length,
    extraScopes: extraScopes.length,
    dateOnlyCatchupScopes: dateOnlyCatchupScopes.length,
    otherScopes: otherScopes.length,
    files: {
      all: allPath,
      mainOnly: mainOnlyPath,
      extraOnly: extraOnlyPath,
    },
  });

  console.log(
    JSON.stringify(
      {
        runId,
        failureEntries: failures.length,
        uniqueScopes: scopes.length,
        mainScopes: mainScopes.length,
        extraScopes: extraScopes.length,
        dateOnlyCatchupScopes: dateOnlyCatchupScopes.length,
        otherScopes: otherScopes.length,
        outputDir,
      },
      null,
      2
    )
  );
}

main();
