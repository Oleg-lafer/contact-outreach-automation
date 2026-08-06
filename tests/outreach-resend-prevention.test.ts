import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  campaign_content_from_contact_values,
  collect_campaign_websites,
  collect_historical_successes,
} from "../src/database/setup_initial_outreach_campaign.js";
import {
  classify_attempt_schema,
  classify_website_campaign_schema,
} from "../src/database/run_database_migrations.js";
import { campaign_website_sync_entries } from "../src/database/synchronize_campaign_websites.js";
import {
  campaign_from_database_row,
  claim_is_still_eligible,
  type DatabaseCampaignRepository,
} from "../src/contact_outreach_workflow/shared_files_orchestrator/database_campaign_repository_(Integration).js";
import {
  resolve_database_runner_options,
  run_database_campaign,
} from "../src/contact_outreach_workflow/database_outreach_runner.js";
import { create_contact_outreach_outcome } from "../src/contact_outreach_workflow/orchestrator/E_aggregate_reporting/E_aggregate_reporting_(Support).js";
import { create_form_failure_outcome } from "../src/contact_outreach_workflow/contact_channels/forms/pipeline/D_reporting/D1_form_reporting_(Support).js";
import { create_email_failure_outcome } from "../src/contact_outreach_workflow/contact_channels/emails/pipeline/E_reporting/E1_email_reporting_(Support).js";
import { create_meeting_failure_outcome } from "../src/contact_outreach_workflow/contact_channels/meetings/pipeline/C_reporting/C1_meeting_reporting_(Support).js";
import { claim_outreach_before_browser } from "../src/contact_outreach_workflow/orchestrator/B_outreach_claim/B1_outreach_claim_(Integration).js";
import type {
  ClaimOutreachInput,
  CompleteOutreachAttemptInput,
  OutreachClaimResult,
  OutreachHistoryStore,
} from "../src/contact_outreach_workflow/shared_files_orchestrator/outreach_history_types_(Support).js";
import { normalize_outreach_domain } from "../src/contact_outreach_workflow/shared_files_orchestrator/website_identity_(Deterministic).js";

class FakeHistoryStore implements OutreachHistoryStore {
  public claims: ClaimOutreachInput[] = [];
  public completions: CompleteOutreachAttemptInput[] = [];

  public constructor(private readonly result: OutreachClaimResult) {}

  public async claimOutreach(
    input: ClaimOutreachInput,
  ): Promise<OutreachClaimResult> {
    this.claims.push(input);
    return this.result;
  }

  public async completeAttempt(
    input: CompleteOutreachAttemptInput,
  ): Promise<void> {
    this.completions.push(input);
  }

  public async close(): Promise<void> {}
}

test("normalizes website identity with public suffix rules", () => {
  assert.equal(
    normalize_outreach_domain("https://WWW.Contact.Example.CO.UK:443/path?q=1"),
    "example.co.uk",
  );
  assert.equal(
    normalize_outreach_domain("https://team.example.com/contact"),
    "example.com",
  );
});

test("outreach claim passes campaign and website to the history store", async () => {
  const store = new FakeHistoryStore({
    action: "run",
    attemptId: 11,
    websiteId: 22,
    normalizedDomain: "example.com",
  });

  const result = await claim_outreach_before_browser(store, {
    campaignId: 7,
    websiteUrl: "https://example.com/contact",
  });

  assert.equal(result.action, "run");
  assert.deepEqual(store.claims, [
    { campaignId: 7, websiteUrl: "https://example.com/contact" },
  ]);
});

test("historical import uses final checkpoints and deduplicates domains", async () => {
  const directory = await mkdtemp(join(tmpdir(), "outreach-history-import-"));
  const firstQueue = join(directory, "first.json");
  const secondQueue = join(directory, "second.json");
  await writeFile(
    firstQueue,
    JSON.stringify({
      websites: [
        {
          id: 1,
          websiteUrl: "https://www.example.co.uk/contact",
          status: "failed",
        },
        { id: 2, websiteUrl: "https://failed.test/", status: "failed" },
      ],
    }),
    "utf8",
  );
  await writeFile(
    `${firstQueue}.full-checkpoints.jsonl`,
    `${JSON.stringify({ id: 1, status: "succeeded" })}\n`,
    "utf8",
  );
  await writeFile(
    secondQueue,
    JSON.stringify({
      websites: [
        {
          id: 1,
          websiteUrl: "https://team.example.co.uk/",
          status: "succeeded",
        },
      ],
    }),
    "utf8",
  );

  const successes = await collect_historical_successes([firstQueue, secondQueue]);

  assert.equal(successes.length, 1);
  assert.equal(successes[0]?.normalizedDomain, "example.co.uk");
  assert.deepEqual(successes[0]?.sourcePaths, [firstQueue, secondQueue]);
});

test("campaign website import includes every status and deduplicates domains", async () => {
  const directory = await mkdtemp(join(tmpdir(), "outreach-website-import-"));
  const queue = join(directory, "websites.json");
  await writeFile(
    queue,
    JSON.stringify({
      websites: [
        { id: 1, websiteUrl: "https://www.example.co.uk/contact", status: "failed" },
        { id: 2, websiteUrl: "https://team.example.co.uk/", status: "succeeded" },
        { id: 3, websiteUrl: "https://another.test/", status: "pending" },
      ],
    }),
    "utf8",
  );

  const websites = await collect_campaign_websites(queue);

  assert.deepEqual(
    websites.map((website) => website.normalizedDomain),
    ["another.test", "example.co.uk"],
  );
});

test("campaign setup separates the message and trims the exact sender fields", () => {
  const content = campaign_content_from_contact_values({
    name: " Roy Ionas ", email: "roy@leadspotting.com ",
    phone: " +97254-459-3583 ", company: " LeadSpotting ",
    role: " CEO ", website: " go.leadspotting.com ", country: " USA ",
    message: " Campaign message ", ignored: "must not be persisted",
  });
  assert.deepEqual(content, {
    senderDetails: {
      name: "Roy Ionas", email: "roy@leadspotting.com",
      phone: "+97254-459-3583", company: "LeadSpotting", role: "CEO",
      website: "go.leadspotting.com", country: "USA",
    },
    messageToSend: "Campaign message",
  });
  assert.equal("message" in content.senderDetails, false);
});

test("database campaign rows become validated contact values", () => {
  const campaign = campaign_from_database_row({
    campaign_id: 1,
    campaign_name: " Alumni ",
    sender_details: JSON.stringify({
      name: " Sender ", email: " sender@example.test ", phone: " +1000 ",
      company: " Company ", role: " Role ", website: " example.test ",
      country: " USA ",
    }),
    message_to_send: " Message ",
    prevent_resend: 1,
  });
  assert.equal(campaign.campaignName, "Alumni");
  assert.equal(campaign.senderDetails.email, "sender@example.test");
  assert.equal(campaign.messageToSend, "Message");
  assert.equal(campaign.preventResend, true);
});

test("database claim eligibility separates new work from explicit retries", () => {
  assert.equal(claim_is_still_eligible([], "unattempted"), true);
  assert.equal(
    claim_is_still_eligible(
      [{ execution_status: "finished", forms_result: "failed" }],
      "unattempted",
    ),
    false,
  );
  assert.equal(
    claim_is_still_eligible(
      [{ execution_status: "finished", forms_result: "partial" }],
      "retry-unsuccessful",
    ),
    true,
  );
  assert.equal(
    claim_is_still_eligible(
      [{ execution_status: "running", forms_result: null }],
      "retry-unsuccessful",
    ),
    false,
  );
});

test("campaign synchronization deduplicates domains and preserves success", () => {
  const entries = campaign_website_sync_entries({
    websites: [
      { websiteUrl: "https://www.example.co.uk/", status: "failed" },
      { websiteUrl: "https://team.example.co.uk/contact", status: "succeeded" },
      { websiteUrl: "https://another.test/", status: "failed" },
    ],
  });
  assert.equal(entries.length, 2);
  assert.equal(
    entries.find((entry) => entry.normalizedDomain === "example.co.uk")
      ?.historicalSuccess,
    true,
  );
});

test("database runner CLI requires an explicit source mode and campaign", () => {
  assert.deepEqual(
    resolve_database_runner_options(
      ["deep-debug", "--campaign-id", "7", "--retry-unsuccessful", "--preview"],
      {},
    ),
    {
      campaignId: 7,
      runMode: "deep-debug",
      retryUnsuccessful: true,
      preview: true,
      outputRoot: "output/database",
    },
  );
});

test("database preview does not confirm, claim, or execute websites", async () => {
  let confirmations = 0;
  let claims = 0;
  const repository: DatabaseCampaignRepository = {
    loadCampaign: async () => campaign_from_database_row({
      campaign_id: 1,
      campaign_name: "Alumni",
      sender_details: {
        name: "Sender", email: "sender@example.test", phone: "+1000",
        company: "Company", role: "Role", website: "example.test", country: "USA",
      },
      message_to_send: "Message",
      prevent_resend: true,
    }),
    snapshotCandidates: async () => [{ websiteId: 2, websiteUrl: "https://example.test/" }],
    claimWebsite: async () => { claims++; throw new Error("must not claim"); },
    completeAttempt: async () => undefined,
    recoverStaleAttempts: async () => 0,
    close: async () => undefined,
  };
  const summary = await run_database_campaign(
    {
      campaignId: 1, runMode: "production", retryUnsuccessful: false,
      preview: true, outputRoot: "unused",
    },
    {
      repository,
      confirm: async () => { confirmations++; return true; },
      runCore: async () => { throw new Error("must not run"); },
      engine: "playwright",
      now: () => new Date("2026-01-01T00:00:00Z"),
    },
  );
  assert.equal(summary.eligible, 1);
  assert.equal(summary.confirmed, false);
  assert.equal(confirmations, 0);
  assert.equal(claims, 0);
});

test("database runner requires confirmation before claiming websites", async () => {
  let claims = 0;
  const repository: DatabaseCampaignRepository = {
    loadCampaign: async () => campaign_from_database_row({
      campaign_id: 1, campaign_name: "Alumni",
      sender_details: {
        name: "Sender", email: "sender@example.test", phone: "+1000",
        company: "Company", role: "Role", website: "example.test", country: "USA",
      },
      message_to_send: "Message", prevent_resend: true,
    }),
    snapshotCandidates: async () => [{ websiteId: 2, websiteUrl: "https://example.test/" }],
    claimWebsite: async () => { claims++; throw new Error("must not claim"); },
    completeAttempt: async () => undefined,
    recoverStaleAttempts: async () => 0,
    close: async () => undefined,
  };
  const summary = await run_database_campaign(
    {
      campaignId: 1, runMode: "production", retryUnsuccessful: false,
      preview: false, outputRoot: "unused",
    },
    {
      repository, confirm: async () => false,
      runCore: async () => { throw new Error("must not run"); },
      engine: "playwright", now: () => new Date("2026-01-01T00:00:00Z"),
    },
  );
  assert.equal(summary.confirmed, false);
  assert.equal(claims, 0);
});

test("local and database entry points keep their input boundaries isolated", async () => {
  const localSource = await readFile(
    "src/contact_outreach_workflow/contact_outreach_orchestrator.ts",
    "utf8",
  );
  const databaseSource = await readFile(
    "src/contact_outreach_workflow/database_outreach_runner.ts",
    "utf8",
  );
  assert.doesNotMatch(localSource, /mysql|database_campaign_repository|OUTREACH_DATABASE/);
  assert.doesNotMatch(databaseSource, /load_and_validate_contact_request|update_website_run_status/);
});

test("database campaign continues after an ordinary website failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "outreach-database-runner-"));
  let completed = 0;
  const campaign = campaign_from_database_row({
    campaign_id: 1,
    campaign_name: "Alumni",
    sender_details: {
      name: "Sender", email: "sender@example.test", phone: "+1000",
      company: "Company", role: "Role", website: "example.test", country: "USA",
    },
    message_to_send: "Message",
    prevent_resend: true,
  });
  const candidates = [
    { websiteId: 10, websiteUrl: "https://one.example.test/" },
    { websiteId: 11, websiteUrl: "https://two.example.test/" },
  ];
  const repository: DatabaseCampaignRepository = {
    loadCampaign: async () => campaign,
    snapshotCandidates: async () => candidates,
    claimWebsite: async (_campaign, websiteId) => ({
      action: "run",
      attemptId: websiteId + 100,
      website: candidates.find((candidate) => candidate.websiteId === websiteId)!,
    }),
    completeAttempt: async () => { completed++; },
    recoverStaleAttempts: async () => 0,
    close: async () => undefined,
  };
  const summary = await run_database_campaign(
    {
      campaignId: 1, runMode: "production", retryUnsuccessful: false,
      preview: false, outputRoot: directory,
    },
    {
      repository,
      confirm: async () => true,
      runCore: async (request) => create_contact_outreach_outcome(
        create_form_failure_outcome(request.websiteUrl, "Fixture failure", "runtime.error"),
        create_email_failure_outcome(request.websiteUrl, "Fixture failure"),
        create_meeting_failure_outcome(request.websiteUrl, "Fixture failure"),
        "RUN_FAILED",
      ),
      engine: "playwright",
      now: () => new Date("2026-01-01T00:00:00Z"),
    },
  );
  assert.equal(summary.processed, 2);
  assert.equal(summary.failed, 2);
  assert.equal(completed, 2);
});

test("migration contains the agreed minimal tables, keys, and indexes", async () => {
  const sql = await readFile(
    "database/migrations/001_create_outreach_tables.sql",
    "utf8",
  );
  for (const table of [
    "OUTREACH_campaigns",
    "OUTREACH_websites",
    "OUTREACH_attempts",
  ]) {
    assert.match(sql, new RegExp("CREATE TABLE IF NOT EXISTS `" + table + "`"));
  }
  assert.match(sql, /prevent_resend/);
  assert.match(sql, /uq_outreach_websites_normalized_domain/);
  assert.match(sql, /idx_outreach_attempt_resend_lookup/);
  assert.match(sql, /`forms_result`/);
  assert.match(sql, /`email_discovery_result`/);
  assert.match(sql, /`meeting_discovery_result`/);
  assert.match(sql, /'finished'/);
  assert.match(sql, /'run_failed'/);
  assert.doesNotMatch(sql, /'succeeded'/);
  assert.doesNotMatch(sql, /WORKER_|resend_cooldown|available_time/);

  const upgradeSql = await readFile(
    "database/migrations/002_separate_execution_and_channel_results.sql",
    "utf8",
  );
  assert.match(upgradeSql, /JSON_EXTRACT\(`channel_outcomes`, '\$\.forms\.status'\)/);
  assert.match(upgradeSql, /WHEN `execution_status` = 'succeeded' THEN 'success'/);
  assert.match(upgradeSql, /SET `execution_status` = 'finished'/);
  assert.match(
    upgradeSql,
    /`campaign_id`,\s*`website_id`,\s*`forms_result`/,
  );

  const campaignSql = await readFile(
    "database/migrations/003_normalize_campaign_content.sql",
    "utf8",
  );
  assert.match(campaignSql, /MODIFY COLUMN `sender_details` JSON NOT NULL/);
  assert.match(campaignSql, /MODIFY COLUMN `message_to_send` TEXT NOT NULL/);
  assert.match(campaignSql, /JSON_EXTRACT\(`sender_details`, '\$\.message'\)/);
  assert.match(campaignSql, /'email', TRIM/);
  assert.doesNotMatch(campaignSql, /ADD COLUMN `(?:name|email|phone|company|role|website|country)`/);

  const ownershipSql = await readFile(
    "database/migrations/004_assign_websites_to_campaigns.sql",
    "utf8",
  );
  assert.match(ownershipSql, /ADD COLUMN `campaign_id` BIGINT UNSIGNED NULL/);
  assert.match(ownershipSql, /COUNT\(DISTINCT `campaign_id`\) = 1/);
  assert.match(ownershipSql, /MODIFY COLUMN `campaign_id` BIGINT UNSIGNED NOT NULL/);
  assert.match(ownershipSql, /fk_outreach_website_campaign/);
  assert.match(ownershipSql, /DROP COLUMN `campaign_id`/);
  assert.match(ownershipSql, /idx_outreach_attempt_resend_lookup` \(`website_id`, `forms_result`\)/);
  assert.doesNotMatch(ownershipSql, /junction|JSON_ARRAY/);
});

test("migration runner distinguishes legacy, final, and partial schemas", () => {
  assert.equal(
    classify_attempt_schema([
      {
        name: "execution_status",
        type: "enum('queued','running','succeeded','partial','failed','skipped')",
      },
    ]),
    "legacy",
  );
  const finalExecution = {
    name: "execution_status",
    type: "enum('queued','running','finished','run_failed','skipped')",
  };
  const resultType = "enum('success','partial','inconclusive','failed')";
  assert.equal(
    classify_attempt_schema([
      finalExecution,
      { name: "forms_result", type: resultType },
      { name: "email_discovery_result", type: resultType },
      { name: "meeting_discovery_result", type: resultType },
    ]),
    "final",
  );
  assert.equal(
    classify_attempt_schema([
      finalExecution,
      { name: "forms_result", type: resultType },
    ]),
    "partial",
  );
});

test("migration runner distinguishes website campaign ownership schemas", () => {
  assert.equal(classify_website_campaign_schema([], ["campaign_id"]), "legacy");
  assert.equal(classify_website_campaign_schema(["campaign_id"], []), "final");
  assert.equal(classify_website_campaign_schema([], []), "partial");
  assert.equal(
    classify_website_campaign_schema(["campaign_id"], ["campaign_id"]),
    "partial",
  );
});
