# Forms Channel Agent Guide

This directory owns the active contact-form channel. These instructions apply
to `forms_orchestrator.ts`, `pipeline/`, and `shared_files_forms/` in addition
to the repository and parent-directory agent guides.

## Channel Boundary

- `forms_orchestrator.ts` is the forms-channel boundary. It coordinates form
  discovery, population, deterministic recovery, submission assessment,
  diagnostics, and normalization into one `FormChannelOutcome`.
- The macro `contact_outreach_orchestrator.ts` owns input validation, browser
  and context lifetime, contact-route discovery, channel coordination,
  aggregate reporting, queue updates, and CLI exit behavior.
- Forms retain the macro-owned initial page. Do not launch or close the shared
  browser/context here and do not call sibling-channel internals.
- Keep detailed behavior in the owning pipeline stage; keep the forms
  orchestrator focused on stage order and handoffs.

## Runtime Modes

The only supported runtime modes are `production` and `deep-debug`. The type is
`AutomationRunMode = "production" | "deep-debug"`.

Both modes execute the same operational pipeline:

1. Discover and classify a form using the initial page and ranked routes.
2. Collect page signals and normalize discovery evidence.
3. Populate the selected candidate and create the submission handoff.
4. If preflight validation requires it, perform bounded deterministic
   population recovery and merge the new result into the prior result.
5. Attempt submission once and assess explicit UI, URL, browser-validation,
   and correlated network evidence.
6. Normalize and return the forms-channel outcome.

## Arithmetic Submission Signal Scoring

Use **Arithmetic Submission Signal Scoring** as the canonical name for the
forms channel's submission-classification mechanism. It retains independent
positive and negative evidence signals, assigns each matched rule a signed
weight, and sums the retained weights into one deterministic score. A positive
total is `SUCCESS` (`Success N`), a negative total is `FAILED` (`Failure -N`),
and zero is `INCONCLUSIVE`. The complete signal ledger remains available so the
score is explainable, auditable, and can be re-evaluated when the rulebook is
improved.

`deep-debug` is an observability mode, not a separate discovery, population,
recovery, or submission algorithm. Never add behavior that makes it more or
less likely to submit than `production`.

### PRODUCTION

- This is the standard operational mode and is selected with
  `npm run production -- <input-json> <output-txt>`.
- It runs the complete live forms workflow, including optional bounded AI
  fallbacks when enabled by the existing engine configuration.
- It does not create a `DeepDebugContext`, attach deep-debug page listeners,
  or produce the deep-debug artifact tree.
- Normal operational artifacts remain allowed. In particular, finalized AI
  assistance evidence is written through `write_ai_assistance_artifact` when
  applicable.
- A generic `npm start -- <input-json> <output-txt>` invocation may omit the
  explicit `runMode`, but its forms behavior is production behavior. Absence of
  `runMode` must never activate deep-debug recording.

### DEEP DEBUG

- Select with `npm run deep-debug -- <input-json> <output-txt>`.
- `forms_orchestrator.ts` creates the `DeepDebugContext` only when
  `options.runMode === "deep-debug"` and an `options.outputPath` is available.
  Keep both guards: the output path anchors the run-specific artifact folder.
- The context writes bounded, redacted evidence under
  `<output-directory>/deep-debug/<UTC-run-id>/` and becomes
  `browser_session.deepDebug` only for the duration of the forms run.
- Diagnostic evidence includes discovery-to-population handoff records, form
  snapshots, screenshots, population results, AI-operation records,
  population-to-submission handoff metadata, submission evidence, exceptions,
  and the final debug summary.
- Deep-debug artifacts must contain metadata and redacted values, never raw
  supplied contact values. Keep `contact_request_redaction_values(...)` wired
  into context creation, snapshots, and artifact handling.
- Deep-debug may take longer and use more disk because of recording. This is
  the intended runtime difference.
- Finalization belongs in `finally`: call `deep_debug.finalize(...)`, attach its
  summary to `outcome.deepDebug` when an outcome exists, and always remove
  `browser_session.deepDebug` so state cannot leak beyond this channel run.
- AI evidence is incorporated into the deep-debug record. Do not also write
  the standalone production AI-assistance artifact from
  `finalize_workflow_outcome` in this mode.

## Orchestrator Invariants

- Preserve the order `discover -> populate -> submit -> report`.
- Return early after a discovery or population blocker, but always pass the
  result through `finalize_workflow_outcome` and allow the `finally` block to
  finalize deep-debug state.
- Preserve the single-submit guarantee. Never retry an uncertain submission
  and never use AI to repeat a submit action.
- Recovery after validation is deterministic and bounded. The recovery call
  intentionally omits page intelligence; preserve that constraint.
- Merge recovery population results without losing earlier debug data or
  accumulated AI actions.
- Convert unexpected errors to a `runtime.error` forms outcome with blocked
  discovery evidence where needed; do not let a raw exception escape merely
  because diagnostics fail.
- Diagnostic capture must be best-effort and must not change the public status
  semantics (`SUCCESS`, `PARTIAL`, or `FAILED`).

## Safety and Ownership Rules

- Never bypass CAPTCHA, anti-bot controls, or browser security boundaries.
- Do not introduce autonomous agents or CUA behavior.
- Preserve existing `CONTACT_FORM_*` environment variables and artifact names.
- Keep form-specific types and support in `shared_files_forms/`; move only
  genuinely channel-neutral contracts to `shared_files_orchestrator/`.
- Pipeline/shared TypeScript filenames must retain the responsibility suffix
  `_(Deterministic)`, `_(LLM)`, `_(Integration)`, or `_(Support)`.
- Tests must use local fixtures and must not submit to third-party websites.

## Changing Runtime Behavior

Run-mode names, defaults, CLI parsing, output paths, and environment propagation
are owned by the macro `contact_outreach_orchestrator.ts`. Mode-specific forms
diagnostics are owned here. Any change to the runtime-mode contract must be
checked in both orchestrators and in `AutomationRunMode`, constants, scripts,
reporting, and focused tests.

After code changes, run `npm run typecheck` and the focused forms/deep-debug
tests, then `npm test` for changes spanning shared contracts or multiple
stages. Do not run the cost-incurring `npm run test:stagehand` unless the user
explicitly requests it.
