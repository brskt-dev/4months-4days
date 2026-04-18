param(
  [string]$RunsDir = "automation-artifacts/runs",
  [string]$AuditDir = "audit"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function New-OrderedRow {
  param(
    [string]$RunId,
    [object]$Row
  )

  return [pscustomobject][ordered]@{
    RunId = $RunId
    FormName = $Row.FormName
    LocalName = $Row.LocalName
    ReportDate = $Row.ReportDate
    Year = $Row.Year
    ReportId = $Row.ReportId
    SourcePage = $Row.SourcePage
    FilterFormId = $Row.FilterFormId
    FilterLocalId = $Row.FilterLocalId
    FilterAssetId = $Row.FilterAssetId
    PlannedPath = $Row.PlannedPath
    PlannedFileName = $Row.PlannedFileName
  }
}

function New-FinalRow {
  param(
    [string]$PreferredRunId,
    [object]$Row,
    [int]$Occurrences,
    [bool]$WasOverwritten
  )

  return [pscustomobject][ordered]@{
    PreferredRunId = $PreferredRunId
    Occurrences = $Occurrences
    WasOverwritten = $WasOverwritten
    FormName = $Row.FormName
    LocalName = $Row.LocalName
    ReportDate = $Row.ReportDate
    Year = $Row.Year
    ReportId = $Row.ReportId
    SourcePage = $Row.SourcePage
    FilterFormId = $Row.FilterFormId
    FilterLocalId = $Row.FilterLocalId
    FilterAssetId = $Row.FilterAssetId
    PlannedPath = $Row.PlannedPath
    PlannedFileName = $Row.PlannedFileName
  }
}

function New-OverwriteRow {
  param(
    [string]$ReportId,
    [System.Collections.ArrayList]$Rows
  )

  $first = $Rows[0]
  $last = $Rows[$Rows.Count - 1]
  $runIds = @($Rows | ForEach-Object { $_.RunId }) -join " | "

  return [pscustomobject][ordered]@{
    ReportId = $ReportId
    Occurrences = $Rows.Count
    FirstRunId = $first.RunId
    FirstPlannedPath = $first.PlannedPath
    LastRunId = $last.RunId
    LastPlannedPath = $last.PlannedPath
    FirstFormName = $first.FormName
    LastFormName = $last.FormName
    FirstLocalName = $first.LocalName
    LastLocalName = $last.LocalName
    RunIds = $runIds
  }
}

if (-not (Test-Path $RunsDir)) {
  throw "Runs directory not found: $RunsDir"
}

New-Item -ItemType Directory -Force -Path $AuditDir | Out-Null

$csvFiles = Get-ChildItem $RunsDir -Directory |
  Sort-Object Name |
  ForEach-Object {
    $planningCsv = Join-Path $_.FullName "planning.csv"
    if (Test-Path $planningCsv) {
      [pscustomobject]@{
        RunId = $_.Name
        Path = $planningCsv
      }
    }
  }

$rawRows = New-Object System.Collections.ArrayList
$rowsByReportId = @{}

foreach ($file in $csvFiles) {
  $rows = Import-Csv $file.Path

  foreach ($row in $rows) {
    $orderedRow = New-OrderedRow -RunId $file.RunId -Row $row
    [void]$rawRows.Add($orderedRow)

    if (-not $rowsByReportId.ContainsKey($row.ReportId)) {
      $rowsByReportId[$row.ReportId] = New-Object System.Collections.ArrayList
    }

    [void]$rowsByReportId[$row.ReportId].Add($orderedRow)
  }
}

$rawOutputPath = Join-Path $AuditDir "audit-planning.csv"
$finalOutputPath = Join-Path $AuditDir "audit-planning.final.csv"
$lastWriteOutputPath = Join-Path $AuditDir "audit-planning.last-write-wins.csv"
$overwritesOutputPath = Join-Path $AuditDir "audit-planning.overwrites.csv"
$summaryOutputPath = Join-Path $AuditDir "audit-planning.summary.json"

$rawRows |
  Export-Csv -Path $rawOutputPath -NoTypeInformation -Encoding UTF8

$finalRows = New-Object System.Collections.ArrayList
$lastWriteRows = New-Object System.Collections.ArrayList
$overwriteRows = New-Object System.Collections.ArrayList

foreach ($reportId in ($rowsByReportId.Keys | Sort-Object)) {
  $rows = $rowsByReportId[$reportId]
  $first = $rows[0]
  $last = $rows[$rows.Count - 1]
  $wasOverwritten = $rows.Count -gt 1

  [void]$finalRows.Add(
    (New-FinalRow -PreferredRunId $first.RunId -Row $first -Occurrences $rows.Count -WasOverwritten $wasOverwritten)
  )
  [void]$lastWriteRows.Add(
    (New-FinalRow -PreferredRunId $last.RunId -Row $last -Occurrences $rows.Count -WasOverwritten $wasOverwritten)
  )

  if ($wasOverwritten) {
    [void]$overwriteRows.Add((New-OverwriteRow -ReportId $reportId -Rows $rows))
  }
}

$finalRows |
  Export-Csv -Path $finalOutputPath -NoTypeInformation -Encoding UTF8

$lastWriteRows |
  Export-Csv -Path $lastWriteOutputPath -NoTypeInformation -Encoding UTF8

$overwriteRows |
  Export-Csv -Path $overwritesOutputPath -NoTypeInformation -Encoding UTF8

$summary = [pscustomobject][ordered]@{
  generatedAt = (Get-Date).ToString("o")
  runs = @($csvFiles.RunId)
  rawRows = $rawRows.Count
  uniqueReportIds = $rowsByReportId.Count
  duplicateReportIds = $overwriteRows.Count
  auditPlanningCsv = $rawOutputPath
  finalCsv = $finalOutputPath
  lastWriteWinsCsv = $lastWriteOutputPath
  overwritesCsv = $overwritesOutputPath
}

$summary | ConvertTo-Json -Depth 5 |
  Set-Content -Path $summaryOutputPath

$summary | ConvertTo-Json -Depth 5
