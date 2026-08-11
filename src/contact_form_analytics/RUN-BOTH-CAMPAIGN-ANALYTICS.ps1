[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
$campaignRoot = Join-Path $repositoryRoot "run_results\2_Campaigns"
$campaigns = @(
  "Campaign_ALUMNI",
  "Campaign_Marketing_Sales"
)

$failed = $false
$analyzedCount = 0

Push-Location $repositoryRoot
try {
  foreach ($campaignName in $campaigns) {
    $runsRoot = Join-Path $campaignRoot "$campaignName\runs"
    if (-not (Test-Path -LiteralPath $runsRoot -PathType Container)) {
      Write-Host "Missing runs folder: $runsRoot" -ForegroundColor Red
      $failed = $true
      continue
    }

    $runFolders = @(
      Get-ChildItem -LiteralPath $runsRoot -Directory |
        Where-Object { $_.Name -match '^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}(?:_\d+)?$' } |
        Sort-Object Name
    )

    Write-Host ""
    Write-Host "$campaignName - $($runFolders.Count) run folder(s)" -ForegroundColor Cyan

    foreach ($runFolder in $runFolders) {
      Write-Host "Analyzing: $($runFolder.FullName)" -ForegroundColor Yellow
      & npm.cmd run analyze -- $runFolder.FullName
      if ($LASTEXITCODE -ne 0) {
        Write-Host "Analytics failed for $($runFolder.Name) with exit code $LASTEXITCODE." -ForegroundColor Red
        $failed = $true
      } else {
        $analyzedCount++
        Write-Host "Output: $($runFolder.FullName)\analytics\latest" -ForegroundColor Green
      }
    }
  }
} finally {
  Pop-Location
}

Write-Host ""
Write-Host "Successfully analyzed $analyzedCount run folder(s)."
if ($failed) { exit 1 }
exit 0
