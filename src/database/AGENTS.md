# Outreach Database Agent Guide

This folder owns operational MySQL scripts for the contact-outreach database.
Follow the repository-level `AGENTS.md` first. Keep the first production
version small: campaigns, stable website identities, attempt history, and
per-campaign prevention of repeated successful submissions.

## Boundaries and Commands

- Schema migrations live under `database/migrations/`.
- `npm run db:migrate` applies the outreach schema.
- `npm run db:verify` reads metadata and verifies the required schema.
- `npm run db:setup` creates or updates the initial campaign and idempotently
  imports confirmed historical successes.
- `npm run db:sync-campaign -- <campaign-id> <website-json>` previews exact
  campaign membership changes; add `--apply` only after reviewing the counts.
- Database credentials stay in the root `.env`; safe placeholders stay in the
  root `.env.example`. Never commit or print database secrets.
- Runtime campaign selection and attempt persistence remain in the shared
  database repository; the explicit database runner is their only CLI caller.

## Minimal Schema

The schema contains exactly three core tables:

- `OUTREACH_campaigns` describes what the system intends to send. It contains
  `campaign_id`, `campaign_name`, `sender_details`, `message_to_send`,
  `prevent_resend`, and `created_time`.
- `OUTREACH_websites` stores stable target identity independently of attempts.
  It contains `website_id`, required `campaign_id`, `normalized_domain`,
  `original_input_url`, and `created_time`. Each website belongs to exactly one
  campaign, while normalized domains remain globally unique.
- `OUTREACH_attempts` is the queue and execution history. It contains
  `attempt_id`, a required `website_id` foreign key,
  `execution_status`, `forms_result`, `email_discovery_result`,
  `meeting_discovery_result`, `outcome_reason`, `channel_outcomes`,
  `created_time`, `started_time`, and `completed_time`.

Campaigns own websites directly through `OUTREACH_websites.campaign_id`.
Attempts derive their campaign through their website. Queries for a campaign's
attempts must join attempts to websites. Multiple attempts for the same website
are allowed so retries and history remain visible.

## Website Identity

- Accept only valid HTTP or HTTPS URLs.
- Convert internationalized hostnames to ASCII/Punycode, lowercase them, and
  remove a trailing dot.
- Ignore scheme, port, path, query, and fragment when determining identity.
- Use the maintained Public Suffix List through the existing `tldts` helper.
  Never derive the registrable domain by taking the final two hostname parts.
- Treat `www.example.com`, `contact.example.com`, and `example.com` as the
  same `normalized_domain`, while handling domains such as `example.co.uk`
  correctly.
- Preserve the supplied URL in `original_input_url` and atomically upsert on
  the unique normalized domain.

## Resend Rule and Processing Order

- When `prevent_resend` is false, another attempt is allowed.
- When it is true and a `forms_result = 'success'` attempt exists for the same
  website, create a `skipped` attempt and stop before browser
  automation.
- `failed` and `partial` attempts may be retried.

`execution_status` describes lifecycle only: `queued`, `running`, `finished`,
`run_failed`, or `skipped`. `finished` means the run ended and does not imply
channel success. `run_failed` means macro coordination did not complete.

The three nullable result columns independently store `success`, `partial`,
`inconclusive`, or `failed`. They remain null for `run_failed` and `skipped`.
Email success means address discovery only; meeting success means scheduling-
link discovery only. Sending and booking remain inactive.

The workflow order is: validate input, normalize/find the website, evaluate the
campaign resend rule, create a skipped or running attempt, run browser
automation only when allowed, then persist lifecycle, independent channel
results, detailed channel JSON, reason, and completion time.

## Constraints and Indexes

- Keep primary keys on all three ID columns, the website-to-campaign foreign
  key, and the attempt-to-website foreign key.
- Keep `OUTREACH_websites.normalized_domain` unique.
- Allow only `queued`, `running`, `finished`, `run_failed`, and `skipped`
  execution statuses.
- Require `completed_time` for finished, run-failed, and skipped attempts;
  queued and running attempts must not have it.
- Keep the unique normalized-domain index and the
  `(website_id, forms_result)` resend/history index and the website
  `campaign_id` index.

## Working and Validation Rules

- Prefer idempotent migrations and setup scripts.
- Do not introduce an ORM, extra tables, cooldown policy, worker framework, or
  campaign-management layer without an explicit requirement.
- Never classify an unknown or partial historical result as succeeded.
- Keep database failures fail-closed so an enabled resend check cannot silently
  continue into browser automation.
- After database changes, select validation according to risk: TypeScript
  typecheck, focused resend-prevention tests, schema verification, and an
  idempotency check for setup/import changes.
- Do not use third-party website submissions to validate database behavior.

For management-facing ERDs, omit database data types, show only the fields and
relationships above, and keep the diagram understandable to non-technical
readers.
