[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location -LiteralPath $repoRoot

function Invoke-Check {
    param([string]$Name, [scriptblock]$Action)
    Write-Host "Checking $Name..."
    & $Action
    if ($LASTEXITCODE -ne 0) {
        throw "$Name check failed with exit code $LASTEXITCODE."
    }
}

if (-not (Test-Path -LiteralPath ".env" -PathType Leaf)) {
    throw "Missing .env in $repoRoot. Copy .env.example to .env and configure the VM credentials."
}
if (-not (Test-Path -LiteralPath "node_modules" -PathType Container)) {
    throw "Missing node_modules. Run npm install in $repoRoot."
}
if (-not (Test-Path -LiteralPath "node_modules\.bin\playwright.cmd" -PathType Leaf)) {
    throw "Playwright is not installed locally. Run npm install first."
}

Invoke-Check "Node.js" { & node --version }
Invoke-Check "npm" { & npm --version }
Invoke-Check "Playwright" { & "node_modules\.bin\playwright.cmd" --version }
Invoke-Check "Chromium launch" {
    & node --input-type=module -e "import { chromium } from 'playwright'; const browser = await chromium.launch({ headless: true }); await browser.close();"
}
Invoke-Check "TypeScript" { & npm run typecheck }
Invoke-Check "database schema and connectivity" { & npm run db:verify }

Write-Host ""
Write-Host "Server checks passed. The VM is ready for a manual campaign run."
