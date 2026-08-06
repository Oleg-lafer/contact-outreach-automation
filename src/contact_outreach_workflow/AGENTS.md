# Contact Outreach Workflow Agent Guide

This folder contains the macro outreach workflow and its channel pipelines.

## Boundaries

- `orchestrator/contact_outreach_core_(Integration).ts` owns the source-neutral
  browser/channel execution path.
- `contact_outreach_orchestrator.ts` is local-only and owns JSON input, queue
  updates, local reports, watchdog handling, and compatibility CLI semantics.
- `database_outreach_runner.ts` is database-only and owns campaign selection,
  attempt lifecycle, confirmation, database persistence, and campaign reports.
- `orchestrator/A_input/` reads and validates website/contact input and updates
  queue status.
- `orchestrator/B_browser/` owns one Playwright browser/context, the initial
  page, the channel-page factory, and optional lazy Stagehand attachment.
- `orchestrator/C_contact_routes/` collects, ranks, and deduplicates
  same-origin HTTP(S) contact-route candidates without navigation.
- `orchestrator/D_contact_channel_coordination/` invokes enabled channel
  orchestrators.
- `orchestrator/E_aggregate_reporting/` creates `ContactOutreachOutcome`, adds
  the common `RUN` section, and writes the aggregate report.
- `shared_files_orchestrator/` is for channel-neutral contracts and support.
- `contact_channels/forms/` owns all form-specific behavior.
- `contact_channels/emails/` owns deterministic, read-only email discovery and
  email-owned reporting. Ranking, composition, and sending remain future
  skeletons.
- `contact_channels/meetings/` owns deterministic, read-only business meeting
  link discovery and meetings-owned reporting. Ranking and booking are not
  active.

## Run Modes

The workflow supports exactly two run modes: `production` and `deep-debug`. `production` is the standard operational mode and runs the complete contact-outreach pipeline, including form discovery, population, recovery, submission, AI fallbacks when required, and aggregate reporting. `deep-debug` runs the same core pipeline and does not use a different submission algorithm, but adds detailed diagnostic observability, including form snapshots, screenshots, structured JSON artifacts, population-to-submission handoff evidence, AI-action records, runtime failure details, and a final debug summary. Consequently, `deep-debug` may take longer and produce substantially more artifacts than `production`.

Run-mode responsibilities are divided between two orchestrators. The root `contact_outreach_orchestrator.ts` is the public entry point: it validates and propagates the selected mode, manages the mode-specific output configuration and environment state, coordinates the overall workflow, and passes the mode to the forms channel. The form-specific `contact_channels/forms/forms_orchestrator.ts` executes the discovery, population, recovery, and submission pipeline; it also owns the behavioral distinction between the modes by creating and finalizing the additional diagnostic context and artifacts only when `debug` is selected. When changing run-mode names, contracts, defaults, or behavior, inspect and update both files together.

## Forms Channel

- `forms_orchestrator.ts` coordinates form discovery, population, submission,
  recovery, deep-debug finalization, AI evidence, and `FormChannelOutcome`.
- `pipeline/A_discovery/` inspects the initial page and macro route candidates,
  refreshes routes during the bounded SPA retry, and performs bounded
  Stagehand recovery.
- `pipeline/B_population/` matches and fills contact controls, handles required
  controls and safe fallbacks, and supports bounded multi-step progression.
- `pipeline/C_submission/` selects one submit action, performs preflight,
  classifies UI/URL/network evidence, and records submission artifacts.
- `pipeline/D_reporting/` normalizes the forms result and returns form-owned
  report sections. It does not write the aggregate report.
- `shared_files_forms/` owns form classification, CAPTCHA rules, required
  controls, deep-debug support, and form-only contracts.

## Emails Channel

- `emails_orchestrator.ts` owns the email-channel page and normalizes an
  independent `EmailChannelOutcome`.
- `pipeline/A_discovery/` visits the initial page and up to three ranked
  same-origin contact routes, then extracts usable literal email addresses
  from visible text and visible `mailto:` recipients.
- `pipeline/E_reporting/` owns email status semantics and prefixed report
  fields. Ranking, composition, and sending are not active.
- Email discovery uses a second page in the macro-owned browser context and
  closes it before forms continue on the unchanged initial page.

## Meetings Channel

- `meetings_orchestrator.ts` owns a temporary meetings page and normalizes an
  independent `MeetingChannelOutcome`.
- `pipeline/A_discovery/` visits the bounded shared channel page plan and
  classifies visible business scheduling links and embedded widget URLs.
- `pipeline/C_reporting/` owns meetings status semantics and prefixed report
  fields. Ranking, calendar setup, and booking are not active.
- Meetings runs after email discovery and closes its page before forms
  continue on the unchanged initial page.

## Contracts

- Call `run_contact_outreach_workflow(inputPath, options)` for local-only use,
  or `run_contact_outreach_core(contactRequest, options)` from a source adapter.
- `contactValuesPath`, `runMode`, `outputPath`, and `engine` are members of the
  options object.
- The result is `ContactOutreachOutcome`; forms, email, and meetings data are
  mandatory at `channels.forms`, `channels.emails`, and `channels.meetings`.
- Forms, emails, and meetings have independent statuses. For legacy queue and CLI
  compatibility, aggregate `websiteUrl`, `status`, `reason`, and `failureKind`
  continue to mirror the forms outcome; they are not a combined business
  success metric.
- Preserve the established report text, section order, artifacts, queue
  mutations, environment variables, and exit codes.

## File Category Suffixes

Every pipeline/shared TypeScript file must end with:

- `_(Deterministic)` for explicit rules and decisions.
- `_(LLM)` for Stagehand/LLM requests or interpretation.
- `_(Integration)` for boundaries and coordinators.
- `_(Support)` for contracts, input, constants, errors, diagnostics, and
  reporting.

Classify by primary responsibility. Orchestrator entry-point names are the
intentional exception.

## Editing Rules

- Keep orchestration files thin and detailed logic in the owning stage.
- Put only channel-neutral behavior in macro/shared files.
- Keep forms-specific contracts and behavior inside the forms channel.
- Keep each active channel on its own page. Email and meetings use sequential
  temporary pages; forms retain the initial page.
- Do not bypass CAPTCHA or introduce autonomous Stagehand agents/CUA.
- Keep contact values redacted from AI snapshots, errors, and artifacts.
- Preserve the single-submit guarantee and never retry an uncertain submit.
- Preserve `CONTACT_FORM_*` configuration names for operational compatibility.
- Back generic fixes with local fixtures.

## Stagehand Boundary

- Playwright owns Chromium, its context, cookies, viewport, and pages.
- Stagehand attaches lazily to that browser over loopback CDP only when a
  bounded fallback is needed.
- Only `shared_files_orchestrator/stagehand_client_(LLM).ts` may import
  Stagehand, OpenRouter, or AI SDK provider types.
- Use observe, validated act, and bounded extract. Never introduce autonomous
  `agent()` or CUA behavior.
- Never retry a submit action with AI after any submit attempt.

## Validation

- Run `npm run typecheck`.
- Run focused route/forms/deep-debug/Stagehand-runtime fixture tests.
- Run `npm test` for changes spanning shared contracts or multiple stages.
- `npm run test:stagehand` is cost-incurring and must not be run unless
  explicitly requested.
