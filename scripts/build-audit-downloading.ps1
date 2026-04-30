param(
  [string]$AuditPlanningPath = "audit/audit-planning.csv",
  [string]$ControlFilePath = "automation-artifacts/control/execution-state.json",
  [string]$RunsDir = "automation-artifacts/runs",
  [string]$OutputPath = "audit/audit-downloading.csv"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function To-Text {
  param($Value)

  if ($null -eq $Value) {
    return ""
  }

  return [string]$Value
}

function Get-DownloadingStatus {
  param(
    $ControlRecord,
    $ArtifactRecord
  )

  if ($null -eq $ControlRecord) {
    return "MissingInControl"
  }

  if (
    (To-Text $ControlRecord.validationStatus) -eq "validated" -or
    (To-Text $ControlRecord.executionStatus) -eq "validated"
  ) {
    return "Downloaded"
  }

  if ((To-Text $ControlRecord.executionStatus) -eq "error") {
    return "Error"
  }

  if ((To-Text $ControlRecord.executionStatus) -in @(
      "planned",
      "queued",
      "request_created",
      "processing",
      "ready_to_download",
      "downloaded"
    )) {
    return "Pending"
  }

  if ($null -ne $ArtifactRecord) {
    $artifactExecutionStatus = To-Text $ArtifactRecord.executionStatus
    if ($artifactExecutionStatus) {
      return "Artifact:$artifactExecutionStatus"
    }
  }

  return "Unknown"
}

function Get-DownloadingReason {
  param(
    $ControlRecord,
    $ArtifactRecord
  )

  if ($null -eq $ControlRecord) {
    return "Nao encontrado no execution-state."
  }

  $errorStage = To-Text $ControlRecord.errorStage
  $errorMessage = To-Text $ControlRecord.errorMessage
  if ($errorStage -or $errorMessage) {
    if ($errorStage -and $errorMessage) {
        return "${errorStage}: $errorMessage"
    }

    return $errorStage + $errorMessage
  }

  $skippedReason = To-Text $ControlRecord.skippedReason
  if ($skippedReason) {
    return "skippedReason: $skippedReason"
  }

  if ($null -ne $ArtifactRecord) {
    $artifactErrorStage = To-Text $ArtifactRecord.errorStage
    $artifactErrorMessage = To-Text $ArtifactRecord.errorMessage
    if ($artifactErrorStage -or $artifactErrorMessage) {
      if ($artifactErrorStage -and $artifactErrorMessage) {
        return "${artifactErrorStage}: $artifactErrorMessage"
      }

      return $artifactErrorStage + $artifactErrorMessage
    }
  }

  return ""
}

if (!(Test-Path -LiteralPath $AuditPlanningPath)) {
  throw "Arquivo nao encontrado: $AuditPlanningPath"
}

if (!(Test-Path -LiteralPath $ControlFilePath)) {
  throw "Arquivo nao encontrado: $ControlFilePath"
}

$planningRows = Import-Csv -LiteralPath $AuditPlanningPath
$controlFile = Get-Content -LiteralPath $ControlFilePath -Raw | ConvertFrom-Json

$controlMap = @{}
foreach ($property in $controlFile.records.PSObject.Properties) {
  $controlMap[[string]$property.Name] = $property.Value
}

$artifactMap = @{}
if (Test-Path -LiteralPath $RunsDir) {
  $runDirectories = Get-ChildItem -LiteralPath $RunsDir -Directory | Sort-Object Name

  foreach ($runDirectory in $runDirectories) {
    $downloadResultsPath = Join-Path $runDirectory.FullName "download-results.ndjson"
    if (!(Test-Path -LiteralPath $downloadResultsPath)) {
      continue
    }

    $reader = [System.IO.File]::OpenText($downloadResultsPath)
    try {
      while (($line = $reader.ReadLine()) -ne $null) {
        if ([string]::IsNullOrWhiteSpace($line)) {
          continue
        }

        $entry = $line | ConvertFrom-Json
        $artifactMap[[string]$entry.reportId] = $entry
      }
    } finally {
      $reader.Close()
    }
  }
}

$outputRows = foreach ($planningRow in $planningRows) {
  $reportId = To-Text $planningRow.ReportId
  $controlRecord = $null
  $artifactRecord = $null

  if ($controlMap.ContainsKey($reportId)) {
    $controlRecord = $controlMap[$reportId]
  }

  if ($artifactMap.ContainsKey($reportId)) {
    $artifactRecord = $artifactMap[$reportId]
  }

  [pscustomobject]@{
    PreferredRunId               = To-Text $planningRow.PreferredRunId
    Occurrences                  = To-Text $planningRow.Occurrences
    WasOverwritten               = To-Text $planningRow.WasOverwritten
    FormName                     = To-Text $planningRow.FormName
    LocalName                    = To-Text $planningRow.LocalName
    ReportDate                   = To-Text $planningRow.ReportDate
    Year                         = To-Text $planningRow.Year
    ReportId                     = $reportId
    SourcePage                   = To-Text $planningRow.SourcePage
    FilterFormId                 = To-Text $planningRow.FilterFormId
    FilterLocalId                = To-Text $planningRow.FilterLocalId
    FilterAssetId                = To-Text $planningRow.FilterAssetId
    PlannedPath                  = To-Text $planningRow.PlannedPath
    PlannedFileName              = To-Text $planningRow.PlannedFileName
    InControlState               = if ($null -ne $controlRecord) { "True" } else { "False" }
    DownloadingStatus            = Get-DownloadingStatus -ControlRecord $controlRecord -ArtifactRecord $artifactRecord
    DownloadingReason            = Get-DownloadingReason -ControlRecord $controlRecord -ArtifactRecord $artifactRecord
    ControlExecutionStatus       = To-Text $controlRecord.executionStatus
    ControlExtractionStatus      = To-Text $controlRecord.extractionStatus
    ControlDownloadStatus        = To-Text $controlRecord.downloadStatus
    ControlValidationStatus      = To-Text $controlRecord.validationStatus
    ControlAttemptCount          = To-Text $controlRecord.attemptCount
    ControlErrorStage            = To-Text $controlRecord.errorStage
    ControlErrorMessage          = To-Text $controlRecord.errorMessage
    ControlSkippedReason         = To-Text $controlRecord.skippedReason
    ControlDownloadedAt          = To-Text $controlRecord.downloadedAt
    ControlValidatedAt           = To-Text $controlRecord.validatedAt
    ControlFileSizeBytes         = To-Text $controlRecord.fileSizeBytes
    ControlLastExecutionRunId    = To-Text $controlRecord.lastExecutionRunId
    ControlPlannedPath           = To-Text $controlRecord.plannedPath
    ArtifactTimestamp            = To-Text $artifactRecord.timestamp
    ArtifactRunId                = To-Text $artifactRecord.runId
    ArtifactOutcomeType          = To-Text $artifactRecord.outcomeType
    ArtifactExecutionStatus      = To-Text $artifactRecord.executionStatus
    ArtifactDownloadStatus       = To-Text $artifactRecord.downloadStatus
    ArtifactValidationStatus     = To-Text $artifactRecord.validationStatus
    ArtifactAttemptCount         = To-Text $artifactRecord.attemptCount
    ArtifactErrorStage           = To-Text $artifactRecord.errorStage
    ArtifactErrorMessage         = To-Text $artifactRecord.errorMessage
    ArtifactSkippedReason        = To-Text $artifactRecord.skippedReason
    ArtifactPlannedPath          = To-Text $artifactRecord.plannedPath
  }
}

$outputDirectory = Split-Path -Path $OutputPath -Parent
if ($outputDirectory) {
  New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
}

$outputRows |
  Sort-Object @{ Expression = { [long]($_.ReportId) } }, ReportId |
  Export-Csv -LiteralPath $OutputPath -NoTypeInformation -Encoding UTF8

Write-Host "Audit de downloads gerado em: $OutputPath"
Write-Host "Total de linhas:" $outputRows.Count
