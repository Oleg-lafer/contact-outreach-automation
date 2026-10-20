# ContactUs campaign and CSV service

This service creates campaigns and imports CSV websites into existing campaigns.
It never starts outreach, creates attempts, deletes websites, or changes campaign ownership.
LSApi is the public HTTP entrance. JavaCommons is not involved.

## Start the internal service

Install dependencies with `npm ci`. Set these values in the environment or the
repository's ignored `.env` file:

| Value | Purpose |
| --- | --- |
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD` | Existing MySQL connection values. |
| `DB_NAME` | Must be `leadspot_main`. |
| `CONTACT_US_SERVICE_TOKEN` | Required secret. Use a long random ASCII token without spaces. Set the same token in LSApi. |
| `CONTACT_US_API_HOST` | Default `127.0.0.1`. Use a private bind address when LSApi runs on another host. |
| `CONTACT_US_API_PORT` | Default `8787`. |

Run `npm run api:serve`. Deploy this service before enabling the LSApi entrance.
Keep it on the private network. Use HTTPS between hosts when the connection is
not otherwise protected. Never send the service token to frontend code.

The service uses the existing schema. Apply the existing migrations through the
normal database release process if needed. This feature adds no migration.
Stop the service with SIGINT or SIGTERM; it closes its HTTP server and database pool.

## Campaign creation

```http
POST /internal/contact-us/campaigns
Authorization: Bearer <service token>
Content-Type: application/json; charset=utf-8
```

```json
{
  "campaignName": "October outreach",
  "sender": {
    "firstName": "Jane",
    "lastName": "Doe",
    "email": "jane@example.com",
    "companyName": "Acme Ltd",
    "phoneNumber": "+1 (555) 123-4567",
    "companyWebsiteUrl": "https://example.com",
    "countryOfOrigin": "Israel",
    "companyIndustry": "Software"
  },
  "outreachMessage": "Hello,\n\nThe complete message goes here."
}
```

The last three sender fields are optional. Omit them or send empty text to omit
them from validated input. Reject null, non-string values, and unknown fields.
All other fields are required non-whitespace strings. Validate email syntax and
HTTP(S) company website syntax. Phone text is preserved without changing its
country code or formatting. There are no DNS, email delivery, or phone checks.

Accept UTF-8 JSON up to 256 KiB, including streamed requests. Reject invalid
Unicode, including escaped lone surrogates. Limit campaign names to 255 Unicode
characters and messages to 65,535 UTF-8 bytes. Do not truncate values. Preserve
accepted field text and message whitespace and line endings.

The creation service validates before acquiring a database connection. It inserts
one row in `OUTREACH_campaigns` in a transaction. Store `campaignName` in
`campaign_name`, `outreachMessage` in `message_to_send`, and sender data in
`sender_details`. The schema default sets `prevent_resend=true`.

Sender JSON keeps `firstName` and `lastName` and derives the existing `name` from
their trimmed values with one space between them. Map `companyName` to `company`,
`phoneNumber` to `phone`, `companyWebsiteUrl` to `website`, `countryOfOrigin` to
`country`, and `companyIndustry` to `industry`. Missing website and country are
stored as empty strings. Missing industry is omitted. Do not invent a role.

Return `201 Created` with `{"campaignId":123}` only after commit. Check that the
generated ID is positive and JavaScript-safe before committing. Roll back on
failure; discard the connection if rollback fails. Creation does not touch
websites or attempts. Duplicate names are allowed. Each request creates a new
campaign; there is no automatic retry or request deduplication.

Campaign loading accepts old combined-name records and new first/last-name
metadata. Role, website, and country may be missing or empty. Omit empty optional
values when building a run request. Preserve message whitespace when loading it.
Industry is stored as metadata; it is not matched to website form controls.

Creation uses the existing error envelope. Validation errors have code
`INVALID_CAMPAIGN` with optional `fields: [{field, code}]`. Field paths are `$`,
`campaignName`, `sender`, `outreachMessage`, or an approved `sender.<field>` path.
Codes are `REQUIRED`, `INVALID_TYPE`, `UNKNOWN_FIELD`, `INVALID_UNICODE`,
`TOO_LONG`, `INVALID_EMAIL`, and `INVALID_URL`. Never return submitted values.

Creation HTTP results: 400 for invalid requests or fields; 401 for a missing or
incorrect token; 405 for a wrong method; 413 (`REQUEST_TOO_LARGE`) for request
size; 415 for media type or encoding; 500 for safe database or internal errors.
Unknown routes return 404. The public LSApi entrance maps service failures and
timeouts to 502/504 and returns 503 when its service configuration is missing.

Frontend sequence: create the campaign, upload the CSV using its returned ID,
then start outreach later through a separate action. No run API is added here.
Deploy this updated internal service before enabling LSApi's new creation command.
The existing CSV upload contract remains unchanged.

## CSV import HTTP contract

```http
POST /internal/contact-us/campaigns/123/websites/import
Authorization: Bearer <service token>
Content-Type: text/csv; charset=utf-8
```

The body is the raw CSV bytes, not multipart or JSON. Only the two documented routes are supported.
Campaign IDs must be positive safe integers, up to `9007199254740991`.
The service requires a token, including on local requests. It has no browser CORS entrance.

## CSV rules

```csv
any header name
https://example.com/contact
https://example.org
```

- The first record is always a required, non-empty header. Its name is ignored.
  A headerless file is not detected: its first record would be treated as the header.
- Require one column, UTF-8, and valid CSV quoting. A UTF-8 BOM is accepted.
- Accept CRLF, LF, or CR record endings. Ignore empty data records and trim URL spaces.
- Limit the CSV to 5 MiB and 10,000 non-empty data records before duplicate removal.
- Require complete HTTP or HTTPS URLs with valid hosts. Reject credentials,
  control characters, backslashes, and internal whitespace. URL length is at
  most 2,048 characters; normalized domain length is at most 253 characters.
- Validate syntax only. Do not visit websites, resolve DNS, or prove reachability.
- Error row numbers are CSV record numbers, including the header and blank
  records. A quoted field containing a newline is still one record.

Use the existing Public Suffix List normalization helper. Subdomains, paths,
schemes, ports, queries, and fragments do not create separate website identities.
The first supplied URL wins for repeated domains in the file. Preserve that URL
after trimming outer spaces. Existing campaign URLs remain unchanged.

## Database behavior and results

Validate the entire CSV before acquiring a connection. In one transaction:
lock the campaign, check domain ownership, and insert new websites in batches.
Write only `OUTREACH_websites(campaign_id, normalized_domain, original_input_url)`.
Skip domains already in the selected campaign. Reject other-campaign domains.
Roll back the transaction on insert errors, conflicts, or commit failure.
The unique domain index remains the final concurrent-write protection.

Success is returned after commit, including an upload that adds zero websites:

```json
{"campaignId":123,"received":10,"imported":7,"duplicatesInFile":1,"alreadyInCampaign":2}
```

`received` counts non-empty data rows. The other three counts add up to it.

Errors use `{ "error": { "code": "...", "message": "...", "rows": [] } }`.
`rows` is optional and contains only `{row, code}`. Invalid URL rows use
`INVALID_URL`. No invalid row is silently skipped.

| HTTP status | Meaning |
| --- | --- |
| 200 | Transaction committed. |
| 400 | `INVALID_REQUEST` or `INVALID_CSV`; nothing saved. |
| 401 | Missing or incorrect internal token. |
| 404 | Unknown route or `CAMPAIGN_NOT_FOUND`. |
| 405 | Wrong method; use POST. |
| 409 | `DOMAIN_CONFLICT` or `IMPORT_CONFLICT`; transaction rolled back. |
| 413 | `UPLOAD_TOO_LARGE` or `TOO_MANY_ROWS`. |
| 415 | `UNSUPPORTED_MEDIA_TYPE`; use UTF-8 CSV. |
| 500 | `DATABASE_ERROR` or `INTERNAL_ERROR`; no raw error details. |

Network loss near commit can leave the caller unsure whether the import finished.
LSApi does not retry automatically. A deliberate repeat upload skips websites
already stored in the same campaign.

## Offline validation

Run `npm run typecheck` and
`npx tsx --test tests/contact-us-campaign.test.ts tests/contact-us-import.test.ts tests/outreach-resend-prevention.test.ts`.
Run `npm test` for changes to the shared runner contracts.
Tests use local HTTP servers and mocked MySQL connections. They do not prove
live schema availability, real database rollback, or production connectivity.
