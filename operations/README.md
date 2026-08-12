# VM Operations

This folder contains the operator-facing commands for manually running the
database-backed outreach workflow on a Windows virtual machine. The application
remains TypeScript-based; no Python runtime or separate server is required.

## One-time VM setup

From PowerShell in the repository root:

```powershell
npm install
npx playwright install chromium
Copy-Item .env.example .env
```

Edit `.env` on the VM with database credentials and any optional AI-provider
credentials. Never commit `.env`. Then prepare and check the database:

```powershell
npm run db:migrate
.\operations\check-server.ps1
```

The health check verifies Node.js, npm, Playwright, an actual headless Chromium
launch, the TypeScript build, and database connectivity/schema.

## Run a campaign manually

```powershell
.\operations\run-campaign.ps1
```

The launcher asks for the campaign ID, run mode, and whether previously
unsuccessful sites should be retried. Press Enter at the run-mode question to
use the normal `production` mode. It always performs a read-only preview first.
The database runner then asks you to type `RUN` before live submissions begin.

Parameters can also be supplied directly:

```powershell
.\operations\run-campaign.ps1 -CampaignId 3
.\operations\run-campaign.ps1 -CampaignId 3 -RetryUnsuccessful
.\operations\run-campaign.ps1 -CampaignId 3 -Mode deep-debug
```

Use `production` normally. Use `deep-debug` only when extra diagnostic evidence
is needed.

## Output and state

MySQL is the source of truth for campaign inputs and attempt outcomes. Every run
also writes timestamped evidence under:

```text
output/database/campaign-<campaign-id>/<UTC-run-id>/
```

Normal database-backed runs do not require new JSON queue or result files.

## Disconnecting from the VM

The VM must remain powered on. Disconnecting RDP may leave a foreground process
running, but signing out, restarting, or stopping the VM will stop it. Verify
the VM/session behavior before relying on a long run. For unattended reliability,
launch the same PowerShell command through Windows Task Scheduler with "Run
whether user is logged on or not".

## Interrupted runs

Run the health check, then start the same campaign again. The database runner
recovers stale running attempts and selects eligible sites from persisted state.
Review the newest output directory and attempt records before choosing retries.
