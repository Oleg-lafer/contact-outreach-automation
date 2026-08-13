[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$configPath = Join-Path $PSScriptRoot "scheduled-run-config.json"
$logDirectory = Join-Path $repoRoot "output\scheduled-logs"
$logPath = Join-Path $logDirectory ("scheduled-run-{0}.log" -f (Get-Date -Format "yyyyMMdd-HHmmss"))

if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
    throw "Missing scheduled run configuration: $configPath"
}

$config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
if (($config.campaignId -isnot [int] -and $config.campaignId -isnot [long]) -or
    $config.campaignId -lt 1 -or $config.campaignId -gt [int]::MaxValue) {
    throw "campaignId must be a positive integer."
}
if ($config.mode -notin @("production", "deep-debug")) {
    throw "mode must be production or deep-debug."
}
if ($config.retryUnsuccessful -isnot [bool]) {
    throw "retryUnsuccessful must be true or false."
}
if ($config.confirmLiveSubmission -ne $true) {
    throw "confirmLiveSubmission must be exactly true before a live run can start."
}

New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
Set-Location -LiteralPath $repoRoot
Start-Transcript -LiteralPath $logPath
try {
    $runnerArguments = @(
        "run",
        "outreach:database",
        "--",
        [string]$config.mode,
        "--campaign-id",
        [string]$config.campaignId,
        "--confirmed"
    )
    if ($config.retryUnsuccessful) {
        $runnerArguments += "--retry-unsuccessful"
    }

    Write-Host "Starting scheduled campaign $($config.campaignId) in $($config.mode) mode."
    & npm @runnerArguments
    if ($LASTEXITCODE -ne 0) {
        throw "Campaign run finished with exit code $LASTEXITCODE. Review $logPath and output/database."
    }
} finally {
    Stop-Transcript
}
