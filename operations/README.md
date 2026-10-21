# VM Operations

This folder contains the operator-facing commands for running database-backed
outreach through Windows Task Scheduler. No Python runtime or separate server
is required.

## One-time VM setup

```powershell
npm install
npx playwright install chromium
Copy-Item .env.example .env
npm run db:migrate -- --maintenance-confirmed
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


## ContactUs API and launch worker

Deploy the launch migration and automation services before the LSApi launch
command. Migration 007 adds campaign run columns and nullable attempt `run_number`.
It copies all historical runs and attempt links before removing `OUTREACH_runs`.
It does not change existing campaign content or remove attempt history.

1. Wait for any existing campaign process to end. Disable the old automatic
   `contact_outreach_production` task. Do not deploy while outreach is running.
2. Deploy the tested automation revision. Run `npm ci`, install Chromium for
   the task account, and configure the existing database and API environment.
3. Back up the database. In the deployment window, run `npm run db:migrate -- --maintenance-confirmed --backup-dir C:\Users\Administrator\Documents\outreach-db-backups`,
   then `npm run db:verify`. These commands change/check the deployed database;
   they are operator steps, not part of offline tests.
4. Create two Windows tasks: `contact_us_api` and `contact_us_worker`.
5. Start the API and worker. Then deploy the matching LSApi version.

Both tasks use this program:

```text
C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe
```

API task arguments:

```text
-NoProfile -ExecutionPolicy Bypass -File "C:\Users\Administrator\Documents\contact-outreach-automation\operations\start-contact-us-service.ps1" -Service api
```

Worker task arguments:

```text
-NoProfile -ExecutionPolicy Bypass -File "C:\Users\Administrator\Documents\contact-outreach-automation\operations\start-contact-us-service.ps1" -Service worker
```

Use the repository folder as **Start in**. Set a trigger **At startup**. Select
**Run whether user is logged on or not** and **Do not start a new instance**.
Clear the task duration limit. Set **Restart every 1 minute** after failure,
with 999 restart attempts. Use the account that has Node, npm, and Playwright
Chromium installed. After setup, start both tasks once without rebooting.

The wrapper returns the process exit code and writes a new log under
`output/service-logs/` for each service start. The database run record stores
heartbeats and safe failure codes. Review logs and run records for stalled or
failed work. Configure normal server monitoring for failed/stopped tasks and
a missing heartbeat. The new status API is a later change.

Keep the existing scheduled-run script for manual database CLI runs. It uses
the same global execution lock as the worker and stops if another run is
active. It also refuses queued or interrupted API work; start the worker to
handle that work first. The old local-only JSON runner is not part of the database launch
service; do not operate a second local outreach process on this worker host.

Loopback remains the API default. If LSApi is elsewhere, configure
`CONTACT_US_SERVICE_URL` there and bind the automation API to its private
interface with `CONTACT_US_API_HOST`. Use a private network or TLS, and allow
only the LSApi host through the server and AWS firewalls. Do not expose the
plain HTTP service token on an untrusted network. Public access controls
remain the responsibility of the existing website/deployment layer; CORS is
not user authentication.

Stopping or rebooting the worker leaves active work for automatic resume.
It retries unfinished website attempts and can repeat a previous submission.
Do not stop the worker to cancel a campaign permanently. There is no cancel
API in this release. To roll back the application, stop the new tasks first,
leave the additive schema intact, and do not run the old automatic task while
new worker processes are alive.


### Migration 007 maintenance and recovery

Pause launch requests, the API service, worker, and scheduled outreach before
using `--maintenance-confirmed`. The command refuses active attempts or pending
runs and holds the global execution lock. Use a backup directory outside every
Git repository. The migration saves schema/data JSON and a SHA-256 file and
verifies the backup before changing run storage. The backup contains campaign
and attempt data; keep it private and outside source control.

Migration 003 is skipped for existing JSON/TEXT campaign content, preserving
sender metadata and exact message formatting. Migration 006 remains historical
and is not executed on fresh installs. Migration 007 supports both fresh
storage and conversion of the old table. It records legacy IDs and checks all
campaign contents, websites, outcomes, and attempt links before cleanup.

MySQL schema changes commit independently. If a step fails, keep services
paused, retain the backup, fix the reported cause, and rerun the same command.
Existing copied runs and links are checked rather than appended twice. Do not
start an older API or worker after the old run storage has been removed. After
success, run `npm run db:verify`, then start matching automation and LSApi
versions. Migration itself does not start the worker or outreach.


If old unlinked attempts remain marked running after the operator confirms all
outreach is stopped, they are not changed automatically. An operator can
explicitly preserve named records with `--preserve-stale-attempt-ids <id,id>`.
Only unlinked running attempts older than 24 hours qualify. Recent, queued,
and API-linked attempts still stop migration. The named rows keep their exact
stored outcomes and timestamps; this option does not restart them.
