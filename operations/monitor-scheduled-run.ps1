[CmdletBinding()]
param(
    [string]$RunDirectory,
    [switch]$NoFollow
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$logDirectory = Join-Path $repoRoot "output\scheduled-logs"

if ([string]::IsNullOrWhiteSpace($RunDirectory)) {
    $latestRunPath = Join-Path $logDirectory "latest-run.json"
    if (-not (Test-Path -LiteralPath $latestRunPath -PathType Leaf)) {
        throw "No latest-run.json was found at $latestRunPath. Start a scheduled run first."
    }
    $latestRun = Get-Content -Raw -LiteralPath $latestRunPath | ConvertFrom-Json
    $RunDirectory = [string]$latestRun.runDirectory
}

$resolvedRunDirectory = (Resolve-Path -LiteralPath $RunDirectory).Path
$resolvedLogDirectory = (Resolve-Path -LiteralPath $logDirectory).Path
if (-not $resolvedRunDirectory.StartsWith($resolvedLogDirectory + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "RunDirectory must be inside $resolvedLogDirectory"
}

$metadataPath = Join-Path $resolvedRunDirectory "metadata.json"
$statusPath = Join-Path $resolvedRunDirectory "status.json"
$runLogPath = Join-Path $resolvedRunDirectory "run.log"
$errorLogPath = Join-Path $resolvedRunDirectory "errors.log"
$runnerLogPath = Join-Path $resolvedRunDirectory "runner.log"

Write-Host "Monitoring: $resolvedRunDirectory"
if (Test-Path -LiteralPath $metadataPath) {
    $metadata = Get-Content -Raw -LiteralPath $metadataPath | ConvertFrom-Json
    Write-Host "Run ID: $($metadata.runId) | Campaign: $($metadata.campaignId) | Mode: $($metadata.mode)"
}
if (Test-Path -LiteralPath $statusPath) {
    $status = Get-Content -Raw -LiteralPath $statusPath | ConvertFrom-Json
    $heartbeat = [DateTimeOffset]::Parse([string]$status.heartbeatAtUtc)
    $heartbeatAgeSeconds = [Math]::Round(([DateTimeOffset]::UtcNow - $heartbeat).TotalSeconds)
    function Test-ProcessIdentity {
        param([int]$ProcessId, [string]$ExpectedStartedAtUtc)
        $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
        if ($null -eq $process -or [string]::IsNullOrWhiteSpace($ExpectedStartedAtUtc)) { return $false }
        $expected = [DateTimeOffset]::Parse($ExpectedStartedAtUtc).UtcDateTime
        return [Math]::Abs(($process.StartTime.ToUniversalTime() - $expected).TotalSeconds) -lt 1
    }
    $powershellAlive = Test-ProcessIdentity -ProcessId $status.powershellProcessId -ExpectedStartedAtUtc ([string]$status.powershellStartedAtUtc)
    $launcherAlive = $false
    if ($null -ne $status.launcherProcessId) {
        $launcherAlive = Test-ProcessIdentity -ProcessId $status.launcherProcessId -ExpectedStartedAtUtc ([string]$status.launcherStartedAtUtc)
    }
    Write-Host "State: $($status.state) | Heartbeat age: ${heartbeatAgeSeconds}s | Runner alive: $powershellAlive | Launcher alive: $launcherAlive"
}

if (-not (Test-Path -LiteralPath $runLogPath -PathType Leaf)) {
    throw "Run log was not found at $runLogPath"
}

if (Test-Path -LiteralPath $runnerLogPath) {
    Write-Host "--- Runner events ---"
    Get-Content -LiteralPath $runnerLogPath -Tail 30
}
if ((Test-Path -LiteralPath $errorLogPath) -and (Get-Item -LiteralPath $errorLogPath).Length -gt 0) {
    Write-Host "--- Standard error ---"
    Get-Content -LiteralPath $errorLogPath -Tail 100
}
Write-Host "--- Standard output ---"
if ($NoFollow) {
    Get-Content -LiteralPath $runLogPath -Tail 100
} else {
    Write-Host "Following run.log. Run this command again to refresh status and errors. Press Ctrl+C to stop monitoring."
    Get-Content -LiteralPath $runLogPath -Tail 100 -Wait
}
