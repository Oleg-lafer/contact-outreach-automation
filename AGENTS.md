# Project Agent Guide

This project is a Playwright contact-outreach automation POC. Contact forms,
read-only email discovery, and read-only meeting-link discovery are active.

## Main Goal

The outreach workflow validates input, opens one Playwright-owned browser
context, discovers same-origin contact routes, coordinates enabled contact
channels, and writes one aggregate result. The forms channel discovers,
populates, submits, and reports one of:

- `SUCCESS` when clear confirmation appears.
- `PARTIAL` when submission was attempted but success was not proven.
- `FAILED` when input, navigation, discovery, CAPTCHA, population, validation,
  or submit-control issues block the run.

The public result is `ContactOutreachOutcome`. Channel details live under
`channels`; forms, emails, and meetings have independent statuses. For legacy queue and
CLI compatibility, the top-level website, status, reason, and failure kind
mirror `channels.forms` and are not a combined business-success metric.

## Run Modes

- Local-only run: `npm run outreach:local -- <production|deep-debug> <input-json> <output-txt>`
- Database-only run: `npm run outreach:database -- <production|deep-debug> --campaign-id <id>`
- `npm run production`, `npm run deep-debug`, and `npm start` remain local-only aliases.

Input/output source and diagnostic mode are independent. Local-only runs read
and update JSON files and never connect to MySQL. Database-only runs read
campaign/website inputs from MySQL and persist attempt outcomes to MySQL;
their reports and diagnostics remain local evidence under `output/database/`.

The workflow supports exactly two run modes: `production` and `deep-debug`.
`production` is the standard operational mode. It runs the complete workflow,
including contact-route discovery, channel coordination, form discovery,
population, recovery, submission, optional bounded AI fallbacks, and aggregate
reporting.

`deep-debug` runs the same core workflow and preserves normal submission
behavior. It does not use a different discovery, population, or submission
algorithm. In addition, it creates bounded and redacted diagnostic evidence,
including form snapshots, screenshots, structured JSON artifacts,
population-to-submission handoff information, AI-action records, runtime
failure details, and a final debug summary. These artifacts are written under
`<output-directory>/deep-debug/<UTC-run-id>/`. Because of this additional
recording, `deep-debug` may take longer and produce substantially more artifacts
than `production`.

Run-mode responsibilities are divided between the source-neutral core, the
database/local runners, and the forms orchestrator.
`src/contact_outreach_workflow/contact_outreach_orchestrator.ts` is the
local-only compatibility entry point. `database_outreach_runner.ts` is the
database-only campaign entry point. Both call the source-neutral core.
`src/contact_outreach_workflow/orchestrator/contact_outreach_core_(Integration).ts`
owns the macro deep-debug lifecycle so browser evidence starts before launch.
`src/contact_outreach_workflow/contact_channels/forms/forms_orchestrator.ts`
runs the form discovery, population, recovery, and submission pipeline and adds
the form-specific diagnostics activated by `deep-debug`. Changes to
run-mode names, defaults, contracts, or behavior must therefore be checked in
both files.

`npm start -- <input-json> <output-txt>` may remain available as a generic CLI
entry command, but it is not a third run mode and must resolve to the normal
`production` behavior.

When paths are omitted, the workflow reads `input/websites.json` and writes
`output/result.txt`. Normal CLI runs submit matching forms live; use only
websites where test submissions are permitted.

## Setup and Input

- Install dependencies with `npm install`.
- Install Chromium with `npx playwright install chromium`.
- `input/contact-values.json` stores `name`, `email`, `phone`, and `message`.
- `input/websites.json` stores website entries with `websiteUrl`, `status`, and
  `statusDescription`.

After a run, the selected queue entry is updated to `succeeded` or `failed`.
Legacy single-site JSON files containing `websiteUrl` and contact values remain
accepted.

## Architecture

- `src/contact_outreach_workflow/contact_outreach_orchestrator.ts` owns the
  local-only public workflow and compatibility CLI.
- `src/contact_outreach_workflow/database_outreach_runner.ts` owns the
  database-only campaign CLI.
- `src/contact_outreach_workflow/orchestrator/` owns macro input, browser,
  contact-route discovery, channel coordination, and aggregate reporting.
- `src/contact_outreach_workflow/shared_files_orchestrator/` owns
  channel-neutral contracts, constants, AI adapters, network evidence,
  redaction, and browser support.
- `src/contact_outreach_workflow/contact_channels/forms/` owns the active forms
  orchestrator, form-only shared files, and its discovery/population/submission/
  reporting pipeline.
- `src/contact_outreach_workflow/contact_channels/emails/` discovers usable
  published email addresses on the starting page and ranked same-origin
  contact routes. Ranking, composition, and sending remain future work.
- `src/contact_outreach_workflow/contact_channels/meetings/` discovers genuine
  business-outreach scheduling links and embedded widget destinations.
  Ranking, calendar configuration, and booking are not active.
- `src/contact_form_analytics/` remains independent.
- `tests/` contains local fixture tests.

The macro route stage ranks and deduplicates same-origin HTTP(S) route
candidates without navigating. Email and meetings discovery use sequential
temporary pages for the starting page and up to three candidates. Forms retain
the initial page, consume those candidates, and may refresh the list during
the bounded SPA retry. Browser setup owns the single Chromium browser/context
and all channel pages.

## Working Rules

- Keep the generic workflow as the default path.
- Do not bypass CAPTCHA.
- Promote lessons from real failures into generic logic and local fixture tests.
- Prefer clear failure reasons over silent fallback.
- Keep deep-debug recording explicitly opt-in.
- Tests use temporary local HTTP servers and must not submit to third-party
  websites.
- Preserve existing `CONTACT_FORM_*` environment variables and artifact names.
- CAPTCHA solving, shadow-DOM-specific logic, anti-bot bypasses, autonomous
  agents, and CUA are outside this POC.
- Bounded Stagehand fallbacks remain optional behind
  `CONTACT_FORM_ENGINE=stagehand`.

## Validation

After each meaningful code change, Codex must use its judgment to select and
run the tests appropriate to the behavior changed and the risk involved.

When using Plan Mode for a major code change, the plan must include a validation
step that maps the tests Codex expects to run for the affected behavior and
risk. The test mapping may be adjusted during implementation if the scope or
risk changes.

Whenever a new file is added under `tests/`, update `tests/AGENTS.md` in the
same change to include the file and describe its purpose in the Test File
Dictionary.

After validation, Codex must report:

- Tests run.
- Results.
- Relevant tests not run and why.

Do not run the cost-incurring `npm run test:stagehand` unless explicitly
requested.
## Workflow File Categories

Pipeline and shared TypeScript files end with one primary-responsibility suffix:

- `_(Deterministic)`: explicit Playwright rules, classifications, and decisions.
- `_(LLM)`: Stagehand/LLM requests or interpretation.
- `_(Integration)`: boundaries and coordinators.
- `_(Support)`: input, types, constants, errors, logging, diagnostics, and
  reporting.

The suffix describes primary responsibility, not every operation. Preserve it
when adding, moving, or splitting workflow files.

## Workflow Summary

- Macro input validation requires valid HTTP(S) website URLs and non-empty fill
  values.
- Macro browser setup launches Playwright-owned Chromium and performs the
  initial navigation. Optional Stagehand attaches lazily over loopback CDP.
- Macro contact-route discovery gathers ranked same-origin routes and excludes
  mail, telephone, JavaScript, and cross-origin destinations.
- Email discovery collects deduplicated literal addresses from visible text
  and visible `mailto:` recipients, excluding the supplied sender and clear
  no-reply addresses. It does not rank, compose, or send email.
- Meetings discovery collects deduplicated business scheduling destinations
  from visible links and embedded widget URLs. It does not rank, open, or book
  those destinations.
- Forms discovery recognizes contact, consultation, book-a-call, project,
  work-with-us, quote, audit, and equivalent inquiry language while rejecting
  newsletter, search, login, and unrelated forms.
- Population avoids CAPTCHA controls, matches supplied contact values, handles
  required privacy consent, and records unresolved fields in
  `missing-fields.json`.
- Submission clears safe cookie obstructions, verifies submit actionability,
  performs one submit click, checks browser validation, and waits for explicit
  UI, URL, or correlated network confirmation.
- Forms reporting produces form-owned report sections. Macro aggregate
  reporting adds the common run section, preserves the established report
  format, writes the output, updates the queue, and sets the process exit code.
