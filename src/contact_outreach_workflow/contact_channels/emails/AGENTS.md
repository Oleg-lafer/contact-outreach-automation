# Email Channel Agent Guide

This channel currently performs deterministic, read-only email discovery and
email-owned reporting. Ranking, composition, and sending are future work.

## Active Scope

- `emails_orchestrator.ts` owns the temporary email page and returns one
  `EmailChannelOutcome`.
- `pipeline/A_discovery/` plans bounded page coverage, navigates sequentially,
  and extracts usable published addresses.
- `pipeline/E_reporting/` owns email status normalization and the
  `EMAIL DISCOVERY` report section.
- `shared_files_emails/` owns email-only contracts.
- `pipeline/B_ranking/`, `C_composition/`, and `D_sending/` remain `.gitkeep`
  skeletons until those features are explicitly requested.

Do not add ranking, categorization, message generation, delivery, provider
integration, or placeholder logic as part of discovery work.

## Discovery Coverage

- Inspect the starting URL plus at most the first three distinct macro-ranked
  contact-route candidates.
- Accept only HTTP(S) pages whose origin exactly matches the starting origin.
- Preserve meaningful same-page hash routes and deduplicate normalized URLs.
- Do not perform an unbounded crawl, sitemap scan, search-engine lookup, or
  cross-origin navigation.
- Visit planned pages sequentially. A failed page must not prevent later
  planned pages from being inspected.

## Extraction Rules

- Inspect rendered visible text and visible `mailto:` links.
- Inspect the main document plus same-origin and inherited `about:blank`
  frames. Ignore cross-origin frames.
- Read recipients only from the `mailto:` recipient path. Ignore `subject`,
  `body`, `cc`, `bcc`, and every other query parameter.
- Decode percent-encoded recipients and accept comma- or semicolon-separated
  recipient lists.
- Accept literal, public-looking ASCII email addresses only. Do not infer
  obfuscated forms such as `[at]` or `[dot]`.
- Normalize addresses to lowercase, validate syntax, deduplicate
  case-insensitively, and return them in deterministic alphabetical order.
- Exclude the supplied sender address and clear no-reply/do-not-reply local
  parts.
- Keep all other published usable addresses. Do not filter by department,
  role, personal name, free-email provider, or domain relationship.
- Ignore scripts, styles, hidden text, hidden links, and email-like text found
  only in `mailto:` query parameters.

## Browser Isolation

- Use exactly one temporary page created by the macro browser session.
- Never navigate or modify the forms page.
- Close the email page in `finally`; never close the shared context/browser.
- Email discovery runs before meetings and forms so later channels start from
  the unchanged initial page.
- Email exceptions become an email `FAILED` outcome. Forms must still run.

## Email Outcome Semantics

- `SUCCESS`: every planned page was inspected and at least one usable email
  was found.
- `PARTIAL`: at least one planned page was inspected and at least one planned
  page failed, whether or not an email was found.
- `FAILED` with `email.discovery.no_address`: every planned page was inspected
  but no usable email was found.
- `FAILED` with `email.discovery.failed`: no planned page could be inspected.
- `email.discovery.incomplete` is the failure kind for `PARTIAL` coverage.
- Preserve `emails`, `plannedPageCount`, `inspectedPages`, and `failedPages`
  as channel-local evidence. Do not turn email status into a combined outreach
  status.

## Reporting and Artifacts

- Use channel-prefixed labels: `Email status`, `Email reason`,
  `Email failure kind`, and email page counts.
- Emit one `Discovered email` line per normalized address.
- Do not use unprefixed `Status`, `Reason`, or `Failure kind` labels because
  the independent form analytics parser owns those legacy fields.
- Email discovery currently produces no JSON, screenshot, debug, or delivery
  artifact.

## Validation

- Cover visible-text and `mailto:` extraction, normalization, exclusions,
  same-origin enforcement, route limits, failure continuation, all status
  branches, reporting labels, and page isolation with local fixtures.
- Never send email or submit to third-party websites in tests.
- Run `npm run typecheck` and
  `npx tsx --test tests/email-discovery-channel.test.ts` after email code
  changes. Run `npm test` when coordination, shared contracts, or aggregate
  reporting changes.
