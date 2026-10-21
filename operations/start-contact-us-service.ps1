[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("api", "worker")]
    [string]$Service
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location -LiteralPath $repoRoot
$logDirectory = Join-Path $repoRoot "output\service-logs"
New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
$stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssfffZ")
$logPath = Join-Path $logDirectory "$Service-$stamp-$PID.log"
$errorPath = Join-Path $logDirectory "$Service-$stamp-$PID.errors.log"
$command = if ($Service -eq "api") { "api:serve" } else { "api:worker" }
# Redirect native streams without treating a normal stderr log as a terminating
# PowerShell error. The fixed command comes only from the validated service name.
$process = Start-Process -FilePath "cmd.exe" -ArgumentList @("/d", "/c", "npm.cmd", "run", $command) -WorkingDirectory $repoRoot -WindowStyle Hidden -RedirectStandardOutput $logPath -RedirectStandardError $errorPath -PassThru
$process.WaitForExit()
exit $process.ExitCode
