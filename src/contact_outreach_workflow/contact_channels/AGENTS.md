# Contact Channel Agent Guide

This directory contains independently evaluated outreach channels. The macro
workflow supplies validated input, one Playwright-owned browser context, ranked
same-origin contact routes, and aggregate reporting.

## Channel Boundaries

- Each active channel has one `<channel>_orchestrator.ts` boundary.
- A channel orchestrator coordinates only its own pipeline and returns its own
  normalized channel outcome.
- Keep channel-specific contracts and helpers in that channel's
  `shared_files_<channel>/` directory.
- Keep channel-neutral browser, routing, input, and aggregate contracts in the
  macro workflow. Do not duplicate them inside a channel.
- Channels must not call sibling-channel internals. Cross-channel ordering and
  coordination belong in
  `orchestrator/D_contact_channel_coordination/`.


- Run modes are defined and propagated by the root
  `contact_outreach_orchestrator.ts`. The forms channel implements the
  mode-specific diagnostic behavior in `forms/forms_orchestrator.ts`; email and
  meetings behavior is unchanged between `production` and `deep-debug`. See the
  root agent guide's `Run Modes` section for the complete contract.


## Browser Ownership and Isolation

- Playwright and the macro browser stage own the browser and browser context.
  Channels must never launch or close the shared browser/context.
- Forms retain the initial page. Other active channels use
  `createChannelPage()` and close their owned page in `finally`.
- A channel must not navigate, populate, submit, or invalidate another
  channel's page or locators.
- Channel failures must be normalized into that channel's outcome and must not
  prevent another enabled channel from running.

## Outcomes and Statuses

- Every active channel reports its own `SUCCESS`, `PARTIAL`, or `FAILED`
  status according to channel-owned semantics.
- Do not calculate a combined business-success status across channels.
- The macro `ContactOutreachOutcome.channels` contains every active channel
  outcome.
- The legacy top-level status, queue mutation, and CLI exit behavior mirror
  forms for compatibility. Only macro code may apply that compatibility rule.

## Reporting

- A channel owns its report sections and returns them to aggregate reporting.
- Channels do not write the aggregate report or update the website queue.
- Preserve established form report labels and section order.
- Non-form channels must prefix fields such as status, reason, and failure kind
  with the channel name so form analytics cannot parse them as form fields.
- Do not add channel artifacts unless the feature explicitly requires them.

## Pipeline Structure

- Pipeline stages are ordered with letter prefixes that describe the intended
  channel lifecycle.
- Empty future stages contain only `.gitkeep`. Do not add placeholder
  TypeScript orchestrators or speculative behavior.
- Pipeline and shared TypeScript filenames use the responsibility suffixes
  `_(Deterministic)`, `_(LLM)`, `_(Integration)`, or `_(Support)`.
- Channel orchestrator filenames are the intentional suffix exception.

## Safety and Validation

- Discovery-only channels must remain read-only.
- Tests must use local fixtures and must not contact or submit to third-party
  websites.
- Add focused channel tests for status semantics, page isolation, bounded
  coverage, and error continuation.
- For code changes, run `npm run typecheck` and the focused channel tests.
  Run `npm test` when shared contracts, coordination, or aggregate reporting
  changes.
- Do not run `npm run test:stagehand` unless explicitly requested.
