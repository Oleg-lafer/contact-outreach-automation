import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { analyzePath, analyzeRun } from "../src/contact_form_analytics/contact_form_run_analyzer.js";

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
  directoryPrefix = "",
): Promise<void> => {
  const siteId = String(id).padStart(3, "0");
  const directory = path.join(runPath, `${directoryPrefix}${siteId}`);
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

const writeDiscoveryOnly = async (runPath: string, id: number, directoryPrefix = ""): Promise<void> => {
  const siteId = String(id).padStart(3, "0");
  const directory = path.join(runPath, `${directoryPrefix}${siteId}`);
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, `input-id-${id}.json`),
    JSON.stringify({ websiteUrl: `https://site-${id}.test/`, name: "Test", email: "sender@example.test", message: "Hello" }),
  );
  await writeFile(
    path.join(directory, "discovery-result.json"),
    JSON.stringify({
      version: 1,
      result: {
        websiteUrl: `https://site-${id}.test/`,
        assessment: "confirmed_form_present",
        contactFormFound: true,
        presenceEvidenceStrength: "strong",
        searchCoverage: "complete",
        description: "A form was found.",
        evidence: [],
        limitations: [],
      },
    }),
  );
};

test("database website-prefixed site directories are analyzed with their numeric IDs", async () => {
  const runPath = await makeRun();
  await writeAggregate(runPath, 42, completeEmail, completeMeeting, "website-");

  const { result } = await analyzePath(runPath, { writeOutputs: false });

  assert.equal(result.processed, 1);
  assert.equal(result.channels.forms.sites[0]?.numericId, 42);
  assert.equal(result.channels.emails.sites[0]?.numericId, 42);
  assert.equal(result.channels.meetings.sites[0]?.numericId, 42);
  assert.equal(result.analysisScope, "run");
  assert.deepEqual(result.sourceRunPaths, [path.resolve(runPath)]);
});

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
  assert.equal(result.schemaVersion, 5);
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

test("the CLI-style analyzer combines immediate child runs and retains duplicate website attempts", async () => {
  const campaignPath = await makeRun();
  const earlierRun = path.join(campaignPath, "2026-07-30T02-21-14-000Z");
  const laterRun = path.join(campaignPath, "2026-07-31T02-21-14-000Z");
  await mkdir(earlierRun, { recursive: true });
  await mkdir(laterRun, { recursive: true });
  await writeAggregate(earlierRun, 42, completeEmail, completeMeeting, "website-");
  await writeAggregate(laterRun, 42, completeEmail, completeMeeting, "website-");
  await writeFile(path.join(earlierRun, "summary.json"), JSON.stringify({ selectedThisInvocation: 1 }));
  await writeFile(path.join(laterRun, "summary.json"), JSON.stringify({ selectedThisInvocation: 1 }));
  await mkdir(path.join(campaignPath, "analytics", "ignored-site", "001"), { recursive: true });
  await mkdir(path.join(campaignPath, "notes"), { recursive: true });

  const outcome = await analyzePath(campaignPath, {
    generatedAt: new Date("2026-08-01T00:00:00.000Z"),
  });

  assert.equal(outcome.result.analysisScope, "combined_runs");
  assert.deepEqual(outcome.result.sourceRunPaths, [path.resolve(earlierRun), path.resolve(laterRun)]);
  assert.equal(outcome.result.planned, 2);
  assert.equal(outcome.result.processed, 2);
  assert.deepEqual(
    outcome.result.channels.forms.sites.map((site) => site.id),
    [
      "2026-07-30T02-21-14-000Z/website-042",
      "2026-07-31T02-21-14-000Z/website-042",
    ],
  );
  assert.equal(outcome.result.reconciliation.uniqueSiteEvidence, true);
  assert.equal(outcome.result.reconciliation.channelSiteIdsAlign, true);
  assert.equal(outcome.latestDirectory, path.join(path.resolve(campaignPath), "analytics", "latest"));
  const textReport = await readFile(path.join(outcome.latestDirectory!, "outreach-statistics.txt"), "utf8");
  assert.match(textReport, /Analysis scope: combined_runs/);
  assert.match(textReport, /Source runs: 2/);

  await assert.rejects(
    analyzeRun(campaignPath, { writeOutputs: false }),
    /No numeric site directories or recognizable run artifacts/,
  );
});

test("combined analytics reports mixed modes and an unknown planned count when any child lacks metadata", async () => {
  const campaignPath = await makeRun();
  const fullRun = path.join(campaignPath, "a-full");
  const discoveryRun = path.join(campaignPath, "b-discovery");
  await mkdir(fullRun, { recursive: true });
  await mkdir(discoveryRun, { recursive: true });
  await writeAggregate(fullRun, 1, completeEmail, completeMeeting);
  await writeDiscoveryOnly(discoveryRun, 2);
  await writeFile(path.join(fullRun, "summary.json"), JSON.stringify({ selectedThisInvocation: 1 }));

  const { result } = await analyzePath(campaignPath, { writeOutputs: false });

  assert.equal(result.runMode, "mixed");
  assert.equal(result.planned, null);
  assert.equal(result.notStarted, null);
  assert.match(result.dataQualityWarnings.join("\n"), /at least one source run has no planned count/);
  assert.deepEqual(
    result.channels.forms.sites.map((site) => site.id),
    ["a-full/001", "b-discovery/002"],
  );
});

test("the CLI-style analyzer fails clearly when neither direct sites nor child runs exist", async () => {
  const emptyPath = await makeRun();
  await mkdir(path.join(emptyPath, "analytics", "latest"), { recursive: true });
  await mkdir(path.join(emptyPath, "notes"), { recursive: true });

  await assert.rejects(
    analyzePath(emptyPath, { writeOutputs: false }),
    /No numeric site directories or qualifying immediate child runs/,
  );
});
