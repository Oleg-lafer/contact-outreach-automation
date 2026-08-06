# Test Suite Guide

This file applies to everything under `tests/`. Follow the repository-level
`AGENTS.md` first; the notes here add test-specific routing and conventions.

## Working Rules

- Tests must be deterministic, independent of execution order, and limited to
  local fixtures or temporary HTTP servers.
- Never navigate to or submit forms on third-party websites from tests.
- Reuse existing server, browser, fixture, and temporary-directory patterns
  before introducing another test harness.
- Add regression coverage at the narrowest relevant layer. Use the large
  end-to-end POC suite only when the behavior crosses workflow stages.
- Assert public outcomes and durable evidence. Avoid assertions coupled only to
  incidental logs, timing, or implementation order.
- Preserve redaction in fixtures and artifact assertions; never add real
  credentials, API keys, or personal contact data.
- Close browsers and servers and remove temporary files in teardown, including
  when an assertion fails.
- Do not weaken CAPTCHA protections or add bypass behavior.
- Keep external Stagehand calls out of the normal test suite. Mocked Stagehand
  logic belongs in the normal `*.test.ts` files; the real smoke test is
  explicitly opt-in.

## Commands

- One file: `npx tsx --test tests/<file>.test.ts`
- One named case:
  `npx tsx --test --test-name-pattern="<pattern>" tests/<file>.test.ts`
- Deep-debug suite: `npm run test:deep-debug`
- Cost-incurring real Stagehand smoke test: `npm run test:stagehand`
  (run only when the user explicitly requests it)

Chromium must already be installed with `npx playwright install chromium`.

## Validation

After each meaningful code change, Codex must use its judgment to select and
run the tests appropriate to the behavior changed and the risk involved.
Prefer the narrowest relevant test files or named cases that provide meaningful
coverage.

When using Plan Mode for a major code change, the plan must include a validation
step that maps the test files or named cases Codex expects to run for the
affected behavior and risk. The mapping may be adjusted during implementation
if the scope or risk changes.

Whenever a new file is added under `tests/`, update this `tests/AGENTS.md` file
in the same change to include the file and describe its purpose in the Test
File Dictionary.

After validation, Codex must report:

- Tests run.
- Results.
- Relevant tests not run and why.

## Test File Dictionary

- `contact-form-poc.test.ts` - broad local-server workflow regression suite:
  discovery, route following, multi-step forms, population, validation,
  submission evidence, CAPTCHA blocking, input modes, queue updates, and
  reporting. Use for behavior spanning multiple form stages or the public
  orchestrator.
- `contact-discovery-upgrade.test.ts` - macro route scoring/deduplication and
  focused form-intent/discovery behavior, including same-page anchors,
  no-message forms, newsletters, diagnostics, and route failure reasons.
- `round2-required-controls.test.ts` - deterministic completion of required
  native and ARIA controls, duplicate controls, conditional visibility, and
  unsafe unresolved-field behavior.
- `round3-submission-uncertainty.test.ts` - authoritative submission,
  rejection, contradiction, network/message evidence, redaction, and bounded
  cookie-consent obstruction handling.
- `email-discovery-channel.test.ts` - email extraction, normalization,
  filtering, page-plan bounds, page isolation, partial coverage, outcome
  semantics, and email report fields.
- `meeting-discovery-channel.test.ts` - scheduling-provider and generic meeting
  link classification, widget discovery, deduplication, page isolation,
  partial coverage, outcome semantics, and meeting report fields.
- `contact-outreach-architecture.test.ts` - aggregate channel contracts,
  legacy form-field mirroring, CLI entry-point wiring, and future-stage
  skeleton boundaries.
- `outreach-resend-prevention.test.ts` - website-domain normalization,
  database/local source isolation, campaign parsing and synchronization,
  candidate/retry eligibility, preview and campaign-runner behavior,
  historical-success import behavior, and the minimal database contract.
- `contact-form-analytics.test.ts` - standalone form-run analyzer parsing,
  attribution, failure-kind mappings, malformed/contradictory input, and
  history output behavior.
- `contact-outreach-analytics.test.ts` - aggregate analyzer behavior across
  forms, emails, and meetings, including independent statuses and exact run
  directory selection.
- `deep-debug-observability.test.ts` - opt-in deep-debug artifacts, lifecycle
  evidence, redaction, validation/obstruction diagnostics, and outcome-to-
  artifact consistency.
- `stagehand-runtime.test.ts` - engine selection, Stagehand configuration and
  credential validation, telemetry, reporting, usage accounting, and
  deterministic browsing when AI configuration is unavailable.
- `stagehand-fallbacks.test.ts` - mocked/bounded Stagehand discovery,
  population, progression, submission, and confirmation fallbacks, including
  selector validation, masking, CAPTCHA safety, and one-action limits. This is
  part of the normal suite and must not make real provider calls.
- `stagehand-smoke.ts` - real Stagehand integration smoke test against a local
  contact form. It is intentionally excluded from `npm test` and may incur
  provider cost.

## Maintaining This Dictionary

When adding, renaming, splitting, or substantially changing a test file, update
its entry here. Keep entries at the file/responsibility level; do not enumerate
every individual test case.
