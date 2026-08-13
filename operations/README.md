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
file and writes its console transcript under `output\scheduled-logs\`.

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
