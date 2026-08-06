import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { analyzeRun } from "../src/contact_form_analytics/contact_form_run_analyzer.js";

type RawStatus = "SUCCESS" | "PARTIAL" | "FAILED";

interface DiscoveryFixture {
  status: RawStatus;
  reason?: string;
  failureKind?: string;
  items: string[];
  providers?: string[];
  planned: number;
  inspected: number;
  failed: number;
  reportedCount?: number;
}

const makeRun = async (): Promise<string> => mkdtemp(path.join(os.tmpdir(), "contact-outreach-analytics-"));

const channelSection = (channel: "email" | "meeting", fixture: DiscoveryFixture): string[] => {
  const title = channel === "email" ? "EMAIL DISCOVERY" : "MEETING DISCOVERY";
  const label = channel === "email" ? "Email" : "Meeting";
  const countLabel = channel === "email" ? "Email count" : "Meeting link count";
  const itemLabel = channel === "email" ? "Discovered email" : "Meeting link";
  return [
    `==================== ${title} ====================`,
    `${label} status: ${fixture.status}`,
    ...(fixture.reason ? [`${label} reason: ${fixture.reason}`] : []),
    ...(fixture.failureKind ? [`${label} failure kind: ${fixture.failureKind}`] : []),
    `${countLabel}: ${fixture.reportedCount ?? fixture.items.length}`,
    ...fixture.items.map((item, index) =>
      channel === "email"
        ? `${itemLabel}: ${item}`
        : `${itemLabel}: ${item} (provider: ${fixture.providers?.[index] ?? "custom"}; sources: https://site.test/ [visible_link: Book])`,
    ),
    `${label} planned pages: ${fixture.planned}`,
    `${label} inspected pages: ${fixture.inspected}`,
    `${label} failed pages: ${fixture.failed}`,
  ];
};

const writeAggregate = async (
  runPath: string,
  id: number,
  email: DiscoveryFixture,
  meeting: DiscoveryFixture,
): Promise<void> => {
  const siteId = String(id).padStart(3, "0");
  const directory = path.join(runPath, siteId);
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, `input-id-${id}.json`),
    JSON.stringify({ websiteUrl: `https://site-${id}.test/`, name: "Test", email: "sender@example.test", message: "Hello" }),
  );
  await writeFile(
    path.join(directory, "result.txt"),
    [
      "==================== RUN ====================",
      "Run mode: deep-debug",
      `Website: https://site-${id}.test/`,
      "",
      "==================== CHANNEL SUMMARY ====================",
      "Forms status: SUCCESS",
      `Emails status: ${email.status}`,
      `Meetings status: ${meeting.status}`,
      "",
      "==================== RESULT ====================",
      "Status: SUCCESS",
      "",
      "==================== DISCOVERY ====================",
      "Form found: yes",
      "Assessment: confirmed_form_present",
      "Presence evidence strength: strong",
      "Search coverage: complete",
      "Discovery description: A form was found.",
      "",
      "==================== SUBMISSION ====================",
      "Attempted: yes",
      "Confirmed: yes",
      "Unknown signal count: 1",
      "Unknown signal: message | abc123 | unfamiliar confirmation | no rule matched",
      "",
      ...channelSection("email", email),
      "",
      ...channelSection("meeting", meeting),
    ].join("\n"),
  );
};

const completeEmail: DiscoveryFixture = {
  status: "SUCCESS",
  items: ["sales@example.test", "hello@example.test"],
  planned: 2,
  inspected: 2,
  failed: 0,
};

const completeMeeting: DiscoveryFixture = {
  status: "SUCCESS",
  items: ["https://calendly.com/example/demo"],
  providers: ["calendly"],
  planned: 2,
  inspected: 2,
  failed: 0,
};

test("aggregate reports produce independent forms, email, and meeting evaluations", async () => {
  const runPath = await makeRun();
  await writeAggregate(runPath, 1, completeEmail, completeMeeting);
  await writeFile(
    path.join(runPath, "summary.json"),
    JSON.stringify({
      selectedThisInvocation: 1,
      selectedCount: 99,
      plannedCount: 98,
      totalSites: 97,
      completedThisInvocation: 1,
      mode: "deep-debug",
    }),
  );

  const { result } = await analyzeRun(runPath, { writeOutputs: false });
  assert.equal(result.schemaVersion, 3);
  assert.equal(result.planned, 1);
  assert.equal(result.channels.forms.counts.completed, 1);
  assert.equal(result.channels.forms.sites[0]?.status, "SUCCESS");
  assert.equal(result.channels.emails.sites[0]?.outcome, "found_complete");
  assert.deepEqual(result.channels.emails.sites[0]?.items, ["sales@example.test", "hello@example.test"]);
  assert.equal(result.channels.emails.counts.totalDiscoveredItems, 2);
  assert.equal(result.channels.meetings.sites[0]?.outcome, "found_complete");
  assert.deepEqual(result.channels.meetings.sites[0]?.providers, ["calendly"]);
  assert.equal(result.channels.meetings.providerCounts?.calendly?.count, 1);
  assert.equal(result.reconciliation.allChannelsClassifyEverySite, true);
  assert.equal(result.reconciliation.channelSiteIdsAlign, true);
});

test("email and meeting discovery normalize every outcome without treating no opportunity as execution failure", async () => {
  const runPath = await makeRun();
  const fixtures: Array<{ email: DiscoveryFixture; meeting: DiscoveryFixture }> = [
    { email: completeEmail, meeting: completeMeeting },
    {
      email: {
        status: "PARTIAL",
        reason: "Email discovery inspected 1 of 2 planned same-origin pages.",
        failureKind: "email.discovery.incomplete",
        items: ["partial@example.test"],
        planned: 2,
        inspected: 1,
        failed: 1,
      },
      meeting: {
        status: "PARTIAL",
        reason: "Meeting discovery inspected 1 of 2 planned same-origin pages.",
        failureKind: "meeting.discovery.incomplete",
        items: ["https://meetings.hubspot.com/example/demo"],
        providers: ["hubspot"],
        planned: 2,
        inspected: 1,
        failed: 1,
      },
    },
    {
      email: {
        status: "FAILED",
        reason: "No usable published email address was found on the inspected pages.",
        failureKind: "email.discovery.no_address",
        items: [],
        planned: 2,
        inspected: 2,
        failed: 0,
      },
      meeting: {
        status: "FAILED",
        reason: "No qualifying business meeting-scheduling link was found on the inspected pages.",
        failureKind: "meeting.discovery.no_option",
        items: [],
        planned: 2,
        inspected: 2,
        failed: 0,
      },
    },
    {
      email: {
        status: "PARTIAL",
        failureKind: "email.discovery.incomplete",
        items: [],
        planned: 2,
        inspected: 1,
        failed: 1,
      },
      meeting: {
        status: "PARTIAL",
        failureKind: "meeting.discovery.incomplete",
        items: [],
        planned: 2,
        inspected: 1,
        failed: 1,
      },
    },
    {
      email: {
        status: "FAILED",
        failureKind: "email.discovery.failed",
        items: [],
        planned: 0,
        inspected: 0,
        failed: 0,
      },
      meeting: {
        status: "FAILED",
        failureKind: "meeting.discovery.failed",
        items: [],
        planned: 0,
        inspected: 0,
        failed: 0,
      },
    },
    {
      email: { ...completeEmail, items: [], reportedCount: 0 },
      meeting: { ...completeMeeting, items: [], providers: [], reportedCount: 0 },
    },
  ];
  for (let index = 0; index < fixtures.length; index += 1) {
    const fixture = fixtures[index]!;
    await writeAggregate(runPath, index + 1, fixture.email, fixture.meeting);
  }
  const missingDirectory = path.join(runPath, "007");
  await mkdir(missingDirectory, { recursive: true });
  await writeFile(
    path.join(missingDirectory, "input-id-7.json"),
    JSON.stringify({ websiteUrl: "https://site-7.test/" }),
  );

  const { result } = await analyzeRun(runPath, { writeOutputs: false });
  for (const channel of [result.channels.emails, result.channels.meetings]) {
    assert.equal(channel.counts.outcomes.found_complete.count, 1);
    assert.equal(channel.counts.outcomes.found_partial.count, 1);
    assert.equal(channel.counts.outcomes.no_opportunity.count, 1);
    assert.equal(channel.counts.outcomes.incomplete.count, 1);
    assert.equal(channel.counts.outcomes.execution_failed.count, 1);
    assert.equal(channel.counts.outcomes.conflicting.count, 1);
    assert.equal(channel.counts.outcomes.artifact_incomplete.count, 1);
    assert.equal(channel.counts.opportunityRateAmongCompleteSearches, 50);
    assert.equal(channel.reconciliation.processedEqualsOutcomeTotal, true);
  }
});

test("aggregate parsing isolates form fields from email and meeting section statuses", async () => {
  const runPath = await makeRun();
  await writeAggregate(
    runPath,
    1,
    {
      status: "FAILED",
      failureKind: "email.discovery.no_address",
      items: [],
      planned: 1,
      inspected: 1,
      failed: 0,
    },
    {
      status: "FAILED",
      failureKind: "meeting.discovery.no_option",
      items: [],
      planned: 1,
      inspected: 1,
      failed: 0,
    },
  );

  const { result } = await analyzeRun(runPath, { writeOutputs: false });
  assert.equal(result.channels.forms.sites[0]?.runState, "completed");
  assert.equal(result.channels.forms.sites[0]?.failureKind, "");
  assert.equal(result.channels.emails.sites[0]?.outcome, "no_opportunity");
  assert.equal(result.channels.meetings.sites[0]?.outcome, "no_opportunity");
  assert.deepEqual(result.channels.forms.signalStatistics.undefinedSignals, [{
    kind: "message",
    fingerprint: "abc123",
    summary: "unfamiliar confirmation",
    reason: "no rule matched",
    count: 1,
    siteIds: ["001"],
    modes: ["full"],
  }]);
});

test("the analyzer requires the exact run directory and does not merge timestamped runs", async () => {
  const batchRoot = await makeRun();
  const nestedRun = path.join(batchRoot, "runs", "2026-07-30_02-21-14");
  await mkdir(nestedRun, { recursive: true });
  await assert.rejects(
    analyzeRun(batchRoot, { writeOutputs: false }),
    /No numeric site directories or recognizable run artifacts/,
  );
});
