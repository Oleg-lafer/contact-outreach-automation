# Contact Outreach Automation

A Playwright-based proof of concept for finding business contact routes and coordinating outreach across a website.

Give it a website and your contact details. The workflow opens a single browser session, looks for relevant same-origin contact pages, and runs three independent channels:

- **Forms:** discovers, fills, and submits a suitable contact form.
- **Emails:** finds published business email addresses. It does not send email.
- **Meetings:** finds genuine scheduling links or embedded booking widgets. It does not book meetings.

> [!WARNING]
> Normal runs can submit contact forms on live websites. Only use this project with sites where you have permission to make test or outreach submissions. It does not solve CAPTCHAs or attempt to bypass anti-bot protections.

## What a run reports

Each channel has its own result. For forms, the main outcomes are:

- `SUCCESS` - the site displayed clear confirmation.
- `PARTIAL` - the form was submitted, but success could not be proven.
- `FAILED` - validation, navigation, discovery, CAPTCHA, population, or submission prevented completion.

The top-level status mirrors the forms channel for compatibility; it is not a combined measure of success across all channels.

## Requirements

- Node.js and npm
- Chromium for Playwright
- MySQL only if you plan to use database-backed campaigns

Install the project and browser:

```powershell
npm install
npx playwright install chromium
```

## Run it locally

Create `input/contact-values.json`:

```json
{
  "name": "Alex Example",
  "email": "alex@example.com",
  "phone": "+1 555 0100",
  "message": "I'd like to learn more about your services.",
  "company": "Example Co"
}
```

`name`, `email`, `phone`, and `message` are required. `company`, `role`, `website`, and `country` are optional.

Create `input/websites.json`:

```json
{
  "websites": [
    {
      "websiteUrl": "https://example.com",
      "status": "pending",
      "statusDescription": ""
    }
  ]
}
```

Then run the next non-succeeded entry:

```powershell
npm run outreach:local -- production input/websites.json output/result.txt
```

After the run, the selected website entry is updated to `succeeded` or `failed`, and the human-readable report is written to the output path.

For a single website, a legacy JSON object containing `websiteUrl` and the contact values is also accepted.

## Production and deep-debug modes

Both modes execute the same discovery, population, and submission workflow:

- `production` is the normal operational mode.
- `deep-debug` additionally records bounded, redacted diagnostic evidence such as screenshots, form snapshots, network evidence, and structured decision records.

Run with additional diagnostics:

```powershell
npm run outreach:local -- deep-debug input/websites.json output/result.txt
```

Debug artifacts are stored under `output/deep-debug/<UTC-run-id>/`. They can still contain operationally sensitive context, so review them before sharing.

The convenience commands below remain local-only:

```powershell
npm run production -- input/websites.json output/result.txt
npm run deep-debug -- input/websites.json output/result.txt
npm start -- input/websites.json output/result.txt
```

When paths are omitted, the defaults are `input/websites.json` and `output/result.txt`.

## Database-backed campaigns

Copy `.env.example` to `.env` and add your MySQL connection details:

```text
DB_HOST=
DB_PORT=3306
DB_NAME=
DB_USER=
DB_PASSWORD=
OUTREACH_CAMPAIGN_ID=
```

Prepare and verify the schema:

```powershell
npm run db:migrate
npm run db:verify
```

Run a campaign by ID:

```powershell
npm run outreach:database -- production --campaign-id 123 --confirmed
```

Database runs read their inputs from MySQL and persist attempt outcomes there. Reports and diagnostics remain local under `output/database/`.
The explicit `--confirmed` flag authorizes live submissions for a non-interactive
run. Prefer `operations/scheduled-run.ps1`, which supplies it only when the
scheduled configuration has `confirmLiveSubmission` set to `true`.

## Optional AI fallback

Deterministic Playwright logic is the default. Bounded Stagehand fallbacks can be enabled with:

```powershell
$env:CONTACT_FORM_ENGINE = "stagehand"
```

This requires the corresponding provider credentials in your environment. The optional fallback does not change the project's CAPTCHA and anti-bot boundaries.

## Development

Run the standard checks:

```powershell
npm run typecheck
npm test
```

The Stagehand smoke test can incur API costs and is intentionally separate:

```powershell
npm run test:stagehand
```

Tests use temporary local HTTP servers and do not submit to third-party websites.

## Project layout

```text
src/contact_outreach_workflow/
  orchestrator/                 Browser setup, route discovery, coordination
  contact_channels/forms/       Form discovery, population, and submission
  contact_channels/emails/      Read-only email discovery
  contact_channels/meetings/    Read-only scheduling-link discovery
  shared_files_orchestrator/    Shared contracts, diagnostics, and adapters
src/contact_form_analytics/     Independent run analysis tools
database/migrations/            MySQL schema migrations
tests/                          Local fixture and unit tests
```

The system deliberately excludes CAPTCHA solving, shadow-DOM-specific automation, anti-bot bypasses, autonomous agents, email sending, and meeting booking.
