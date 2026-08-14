# VM Operations

This folder contains the operator-facing commands for running database-backed
outreach through Windows Task Scheduler. No Python runtime or separate server
is required.

## One-time VM setup

```powershell
npm install
npx playwright install chromium
Copy-Item .env.example .env
npm run db:migrate
.\operations\check-server.ps1
```

Edit `.env` with the VM database credentials and never commit it.

## Configure a run

Edit `operations\scheduled-run-config.json` before starting the task:

```json
{
  "campaignId": 3,
  "mode": "deep-debug",
  "retryUnsuccessful": false,
  "confirmLiveSubmission": true
}
```

The run stops unless `confirmLiveSubmission` is exactly `true`. There is no
interactive `RUN` prompt.

## Task Scheduler action

Program/script:

```text
C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe
```

Add arguments:

```text
-NoProfile -ExecutionPolicy Bypass -File "C:\path\to\repo\operations\scheduled-run.ps1"
```

Task Scheduler needs no campaign-specific arguments. The script reads the JSON
file and writes each run under its own directory in `output\scheduled-logs\`.
The directory name includes the campaign, mode, UTC start time, and a unique
run ID. It contains npm standard output in `run.log`, npm standard error in
`errors.log`, wrapper events in `runner.log`, immutable `metadata.json`, and a
heartbeat-driven `status.json`. The final subprocess result is stored in
`exit-code.txt`. `output\scheduled-logs\latest-run.json` points to the most
recently started execution.

Monitor the current or most recent run live with:

```powershell
powershell -NoProfile -File .\operations\monitor-scheduled-run.ps1
```

Inspect it once without following new log output with:

```powershell
powershell -NoProfile -File .\operations\monitor-scheduled-run.ps1 -NoFollow
```

## Output and state

MySQL is the source of truth for campaign inputs and attempt outcomes. Each run
also writes timestamped evidence under:

```text
output/database/campaign-<campaign-id>/<UTC-run-id>/
```

Keep the VM powered on. Configure Task Scheduler with "Run whether user is
logged on or not" so signing out does not stop the task.

## Interrupted runs

Run the health check, then start the same configured task again. The database
runner recovers stale attempts and selects eligible sites from persisted state.
