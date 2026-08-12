[CmdletBinding()]
param(
    [ValidateRange(1, [int]::MaxValue)]
    [int]$CampaignId,

    [switch]$RetryUnsuccessful,

    [ValidateSet("production", "deep-debug")]
    [string]$Mode
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location -LiteralPath $repoRoot

if (-not $CampaignId) {
    $campaignIdText = Read-Host "Campaign ID"
    if ($campaignIdText -notmatch "^[1-9][0-9]*$" -or [long]$campaignIdText -gt [int]::MaxValue) {
        throw "Campaign ID must be a positive integer."
    }
    $CampaignId = [int]$campaignIdText
}

if (-not $PSBoundParameters.ContainsKey("Mode")) {
    $modeAnswer = (Read-Host "Run mode: production or deep-debug? (production)").Trim().ToLowerInvariant()
    if (-not $modeAnswer) {
        $Mode = "production"
    } elseif ($modeAnswer -in @("production", "deep-debug")) {
        $Mode = $modeAnswer
    } else {
        throw "Run mode must be production or deep-debug."
    }
}

if (-not $PSBoundParameters.ContainsKey("RetryUnsuccessful")) {
    $retryAnswer = Read-Host "Retry previously unsuccessful websites? (y/N)"
    $RetryUnsuccessful = $retryAnswer.Trim() -match "^(?i:y|yes)$"
}

$runnerArguments = @(
    "run",
    "outreach:database",
    "--",
    $Mode,
    "--campaign-id",
    $CampaignId.ToString()
)
if ($RetryUnsuccessful) {
    $runnerArguments += "--retry-unsuccessful"
}

Write-Host ""
Write-Host "Previewing campaign $CampaignId in $Mode mode..."
& npm @runnerArguments --preview
if ($LASTEXITCODE -ne 0) {
    throw "Campaign preview failed with exit code $LASTEXITCODE. Nothing was started."
}

Write-Host ""
Write-Host "Preview complete. The live runner will show the eligible count again."
Write-Host "Type RUN at its confirmation prompt to start live submissions, or anything else to cancel."
Write-Host ""
& npm @runnerArguments
if ($LASTEXITCODE -ne 0) {
    throw "Campaign run finished with exit code $LASTEXITCODE. Review the database outcomes and output/database reports."
}
