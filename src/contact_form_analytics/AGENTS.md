# Contact Outreach Analytics Agent Guide

This directory contains the deterministic, read-only analyzer for forms, email
discovery, and meeting discovery. Its historical directory name remains
`contact_form_analytics` for command and path compatibility.

## Boundaries

- Do not change `src/contact_outreach_workflow` while working on analytics.
- Do not revisit analyzed websites or use network access to validate discovered
  values.
- Treat run artifacts as evidence. Do not infer that an email address or meeting
  link is commercially relevant beyond what the report records.
- Keep forms, emails, and meetings as independent evaluations. Do not invent an
  overall outreach-success status.
- Preserve `npm run analyze -- "<exact-run-directory>"` and
  `analyzeRun(path, options)`.

The input must be the exact run directory containing numeric site directories.
Do not silently select or merge timestamped runs from a batch root.

## Artifact Contracts

Current outreach runs normally use `result.txt`; campaign deep-debug runs may
name the same aggregate report `deep-debug.txt`. Parse either by named sections
so identical field labels in different channels cannot collide:

- `RESULT`, `DISCOVERY`, `POPULATION`, and `SUBMISSION` belong to forms.
- `EMAIL DISCOVERY` belongs to emails.
- `MEETING DISCOVERY` belongs to meetings.

Continue supporting historical `production.txt`, `discovery.txt`, and
`discovery-result.json`. Prefer `result.txt`, then `deep-debug.txt`, for current
form evidence and emit a warning when overlapping primary artifacts contradict
the selected current report.

For planned counts, use `selectedThisInvocation`, then `selectedCount`, then
`plannedCount`, then `totalSites`. Numeric directories without a usable result
remain incomplete; artifact absence is not a workflow failure.

## Channel Semantics

Forms retain the detailed input/browser/discovery/population/submission/
reporting funnel, deterministic first-match rulebook, responsibility
attribution, and historical Full/Discovery behavior.

Emails and meetings use these normalized outcomes:

- `found_complete`: at least one item and complete planned-page coverage.
- `found_partial`: at least one item with incomplete coverage.
- `no_opportunity`: a complete search found no qualifying item. This is an
  expected outcome, not an automation failure.
- `incomplete`: partial inspection found no item.
- `execution_failed`: no planned page could be inspected or discovery reported
  an explicit execution failure.
- `artifact_incomplete`: no usable channel section exists.
- `conflicting`: status, item count, failure kind, or page counts do not
  reconcile.

Retain raw status, reason, and failure kind alongside the normalized outcome.
Email statistics may count addresses but must not judge relevance. Meeting
statistics may aggregate recorded providers but must not validate destinations.

## Outputs

Every analysis publishes atomically to `analytics/latest` and a collision-safe
timestamped `analytics/history` directory.

- The root contains `outreach-statistics.txt`,
  `outreach-statistics.json`, `site-channel-matrix.csv`, and `errors.csv`.
- `channels/forms` contains the established text, JSON, CSV, Mermaid, and
  proportional-funnel outputs.
- `channels/emails` and `channels/meetings` each contain channel text/JSON,
  outcome and site CSVs, a rulebook, and `channel-outcomes.svg`.

Form proportional SVG square area, not side length, represents percentage:

```text
side = maximum_side * sqrt(count / denominator)
```

Email and meeting SVG bar length represents the percentage of processed sites.
SVG output must remain deterministic and include data attributes used by tests.

## Development Rules

- Increment the analytics schema version for incompatible result-shape changes.
- Keep rulebook versions independent from the schema version.
- Preserve one classification per site per channel and explicit reconciliation
  checks.
- Write output trees through the atomic latest/history publisher.
- Add fixture tests for parsing precedence, section isolation, every normalized
  outcome, reconciliation, and output layout.
- After changes, run `npm run typecheck` and `npm test`.
