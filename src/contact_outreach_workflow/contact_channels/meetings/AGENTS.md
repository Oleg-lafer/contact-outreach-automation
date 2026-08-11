# Meetings Channel Agent Guide

This channel performs deterministic, read-only discovery of genuine
business-outreach meeting scheduling destinations. It does not rank links,
configure calendars, or book meetings.

## Active Scope

- `meetings_orchestrator.ts` owns one temporary meetings page and returns an
  independent `MeetingChannelOutcome`.
- `pipeline/A_discovery/` visits the bounded macro page plan and classifies
  actionable scheduling links and embedded widget destinations.
- `pipeline/C_reporting/` owns meetings status semantics and the
  `MEETING DISCOVERY` report section.
- `shared_files_meetings/` owns meetings-only contracts.
- `pipeline/B_ranking/` remains a `.gitkeep` skeleton. Do not add ranking or
  create a scheduling/booking stage without explicit scope.

## Discovery Coverage

- Inspect the starting URL plus at most three distinct macro-ranked
  same-origin contact routes.
- Visit planned pages sequentially and continue after individual failures.
- Do not crawl the wider site, inspect sitemaps, or use search engines.
- Never navigate a discovered external scheduling destination.
- Block cross-origin document/frame loads on the meetings-owned page while
  retaining visible iframe source URLs as structural evidence.

## Qualifying Evidence

- Inspect visible anchors, visible `iframe[src]`, `data-url`,
  `data-calendly-url`, and `data-cal-link` scheduling widgets.
- Inspect the main document and same-origin or inherited `about:blank` frames.
  Never inspect cross-origin frame contents.
- Accept resolvable HTTP(S) destinations only.
- Recognize actionable Calendly, Cal.com, HubSpot Meetings, and Chili Piper
  provider URL shapes.
- Known provider destinations qualify with sparse labels unless nearby
  context identifies an excluded purpose.
- Unknown/custom destinations require strong business scheduling language,
  such as booking or scheduling a meeting, call, demo, consultation, discovery
  call, strategy session, or a conversation with sales/an expert.
- Reject events, webinars, classes, training, hiring/interviews, support,
  medical/service appointments, restaurant/hotel reservations, and other
  non-outreach scheduling purposes.
- Plain text and controls without a recoverable URL do not qualify.

## Normalization and Evidence

- Resolve relative URLs against the owning frame URL.
- Convert Cal.com `data-cal-link` slugs to canonical `https://cal.com/...`
  destinations.
- Normalize with the platform URL parser, retain functional path/query/hash
  data, deduplicate identical normalized URLs, and sort by URL.
- Merge distinct source-page, evidence-kind, and label records for duplicate
  destinations. Sort sources deterministically.

## Browser Isolation

- Use one page created through `createChannelPage()` and close it in `finally`.
- Never navigate or modify the forms page or the email page.
- Run after email discovery and before forms.
- Normalize exceptions into a meetings `FAILED` outcome so forms still run.

## Outcome Semantics

- `SUCCESS`: complete coverage and at least one qualifying destination.
- `PARTIAL` with `meeting.discovery.incomplete`: at least one page inspected
  and at least one planned page failed, regardless of whether a link was found.
- `FAILED` with `meeting.discovery.no_option`: complete coverage with no
  qualifying destination.
- `FAILED` with `meeting.discovery.failed`: no planned page could be inspected.
- Meetings status is independent and must not change the legacy form-driven
  top-level outcome, queue mutation, or CLI exit code.

## Reporting and Validation

- Prefix report fields with `Meeting`; never emit unprefixed `Status`,
  `Reason`, or `Failure kind`.
- Emit all normalized links with provider and merged source evidence.
- Produce no meeting JSON, screenshot, availability, or booking artifact.
- Tests must use local fixtures and must not activate third-party links.
- Run `npm run typecheck` and
  `npx tsx --test tests/meeting-discovery-channel.test.ts` after meetings-only
  changes. Run `npm test` when coordination/contracts/reporting change.
