[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$configPath = Join-Path $PSScriptRoot "scheduled-run-config.json"
$logDirectory = Join-Path $repoRoot "output\scheduled-logs"
$heartbeatIntervalSeconds = 30
$script:runDirectory = $null
$script:statusPath = $null
$script:runLogPath = $null
$script:errorLogPath = $null
$script:runnerLogPath = $null
$script:exitCodePath = $null
$script:runId = $null
$script:startedAtUtc = $null
$script:launcherProcess = $null
$script:recordedExitCode = $null
$script:finalStatusWritten = $false

function Write-JsonAtomically {
    param(
        [Parameter(Mandatory = $true)] [string]$Path,
        [Parameter(Mandatory = $true)] [object]$Value
    )

    $temporaryPath = "$Path.tmp"
    $Value | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $temporaryPath -Encoding UTF8
    Move-Item -LiteralPath $temporaryPath -Destination $Path -Force
}

function Write-RunLog {
    param([Parameter(Mandatory = $true)] [string]$Message)

    $timestamp = (Get-Date).ToUniversalTime().ToString("o")
    Add-Content -LiteralPath $script:runnerLogPath -Value "[$timestamp] $Message" -Encoding UTF8
}

function Write-RunStatus {
    param(
        [Parameter(Mandatory = $true)] [string]$State,
        [AllowNull()] [Nullable[int]]$ExitCode = $null,
        [AllowNull()] [string]$Message = $null
    )

    $nowUtc = (Get-Date).ToUniversalTime()
    $launcherPid = $null
    $launcherAlive = $false
    if ($null -ne $script:launcherProcess) {
        $launcherPid = $script:launcherProcess.Id
        try {
            $launcherAlive = -not $script:launcherProcess.HasExited
        } catch {
            $launcherAlive = $false
        }
    }

    Write-JsonAtomically -Path $script:statusPath -Value ([ordered]@{
        runId = $script:runId
        state = $State
        startedAtUtc = $script:startedAtUtc
        heartbeatAtUtc = $nowUtc.ToString("o")
        heartbeatIntervalSeconds = $heartbeatIntervalSeconds
        powershellProcessId = $PID
        launcherProcessId = $launcherPid
        launcherProcessAlive = $launcherAlive
        exitCode = $ExitCode
        message = $Message
    })
}

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
$script:runId = [Guid]::NewGuid().ToString("N").Substring(0, 8)
$script:startedAtUtc = (Get-Date).ToUniversalTime().ToString("o")
$runTimestamp = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
$runDirectoryName = "campaign-{0}_{1}_{2}_run-{3}" -f $config.campaignId, $config.mode, $runTimestamp, $script:runId
$script:runDirectory = Join-Path $logDirectory $runDirectoryName
$script:runLogPath = Join-Path $script:runDirectory "run.log"
$script:errorLogPath = Join-Path $script:runDirectory "errors.log"
$script:runnerLogPath = Join-Path $script:runDirectory "runner.log"
$script:exitCodePath = Join-Path $script:runDirectory "exit-code.txt"
$script:statusPath = Join-Path $script:runDirectory "status.json"
$metadataPath = Join-Path $script:runDirectory "metadata.json"
$latestRunPath = Join-Path $logDirectory "latest-run.json"
New-Item -ItemType Directory -Path $script:runDirectory | Out-Null

Write-JsonAtomically -Path $metadataPath -Value ([ordered]@{
    runId = $script:runId
    campaignId = [int]$config.campaignId
    mode = [string]$config.mode
    retryUnsuccessful = [bool]$config.retryUnsuccessful
    startedAtUtc = $script:startedAtUtc
    powershellProcessId = $PID
    computerName = $env:COMPUTERNAME
    runDirectory = $script:runDirectory
})
Write-JsonAtomically -Path $latestRunPath -Value ([ordered]@{
    runId = $script:runId
    runDirectory = $script:runDirectory
    updatedAtUtc = $script:startedAtUtc
})

Set-Location -LiteralPath $repoRoot
Write-RunLog "Starting scheduled campaign $($config.campaignId) in $($config.mode) mode."
Write-RunStatus -State "starting" -Message "Preparing npm process."

try {
    $npmArguments = @(
        "run", "outreach:database", "--", [string]$config.mode,
        "--campaign-id", [string]$config.campaignId, "--confirmed"
    )
    if ($config.retryUnsuccessful) {
        $npmArguments += "--retry-unsuccessful"
    }

    $npmCommand = (Get-Command npm.cmd -ErrorAction Stop).Source
    $quoteForPowerShell = {
        param([string]$Value)
        "'" + $Value.Replace("'", "''") + "'"
    }
    $invocationParts = @(& $quoteForPowerShell $npmCommand)
    $invocationParts += $npmArguments | ForEach-Object { & $quoteForPowerShell ([string]$_) }
    $quotedExitCodePath = & $quoteForPowerShell $script:exitCodePath
    $childCommand = @"
`$ErrorActionPreference = 'Stop'
`$code = 1
try {
    & $($invocationParts -join ' ')
    `$code = if (`$null -eq `$LASTEXITCODE) { 1 } else { [int]`$LASTEXITCODE }
} catch {
    Write-Error `$_.Exception.Message
    `$code = 1
} finally {
    [IO.File]::WriteAllText($quotedExitCodePath, [string]`$code)
}
exit `$code
"@
    $encodedCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($childCommand))
    $script:launcherProcess = Start-Process -FilePath "powershell.exe" -ArgumentList @("-NoProfile", "-NonInteractive", "-EncodedCommand", $encodedCommand) -WorkingDirectory $repoRoot -WindowStyle Hidden -RedirectStandardOutput $script:runLogPath -RedirectStandardError $script:errorLogPath -PassThru
    Write-RunLog "npm launcher started with process ID $($script:launcherProcess.Id)."
    Write-RunStatus -State "running" -Message "npm command is running."

    while (-not $script:launcherProcess.WaitForExit($heartbeatIntervalSeconds * 1000)) {
        Write-RunStatus -State "running" -Message "npm command is running."
    }
    # The parameterless call ensures redirected streams are drained and ExitCode
    # is populated consistently on Windows PowerShell 5.1.
    $script:launcherProcess.WaitForExit()

    if (-not (Test-Path -LiteralPath $script:exitCodePath -PathType Leaf)) {
        throw "npm launcher exited without recording an exit code. Review $script:errorLogPath."
    }
    $exitCodeText = (Get-Content -Raw -LiteralPath $script:exitCodePath).Trim()
    $exitCode = 0
    if (-not [int]::TryParse($exitCodeText, [ref]$exitCode)) {
        throw "npm launcher recorded an invalid exit code '$exitCodeText'."
    }
    $script:recordedExitCode = $exitCode
    if ($exitCode -ne 0) {
        throw "Campaign run finished with exit code $exitCode. Review $script:runLogPath and output/database."
    }

    Write-RunLog "Campaign run completed successfully with exit code 0."
    Write-RunStatus -State "completed" -ExitCode 0 -Message "Campaign run completed successfully."
    $script:finalStatusWritten = $true
} catch {
    $failureExitCode = $script:recordedExitCode
    if ($null -eq $failureExitCode -and $null -ne $script:launcherProcess) {
        try {
            if ($script:launcherProcess.HasExited) {
                $failureExitCode = $script:launcherProcess.ExitCode
            }
        } catch {}
    }
    Write-RunLog "Run failed: $($_.Exception.Message)"
    Write-RunStatus -State "failed" -ExitCode $failureExitCode -Message $_.Exception.Message
    $script:finalStatusWritten = $true
    throw
} finally {
    if (-not $script:finalStatusWritten -and $null -ne $script:statusPath) {
        Write-RunLog "Runner stopped without reaching a normal completion state."
        Write-RunStatus -State "stopped" -Message "Runner stopped without reaching a normal completion state."
    }
}
