import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import test from "node:test";
import type { EmailChannelOutcome } from "../src/contact_outreach_workflow/contact_channels/emails/shared_files_emails/email_types_(Support).js";
import type { FormChannelOutcome } from "../src/contact_outreach_workflow/contact_channels/forms/shared_files_forms/forms_types_(Support).js";
import type { MeetingChannelOutcome } from "../src/contact_outreach_workflow/contact_channels/meetings/shared_files_meetings/meeting_types_(Support).js";
import {
  create_contact_outreach_outcome,
  format_contact_outreach_outcome,
} from "../src/contact_outreach_workflow/orchestrator/E_aggregate_reporting/E_aggregate_reporting_(Support).js";
import { outreach_attempt_completion_from_outcome } from "../src/contact_outreach_workflow/shared_files_orchestrator/outreach_database_(Integration).js";

test("aggregate outreach outcome requires independent channel outcomes and mirrors forms for compatibility", () => {
  const forms: FormChannelOutcome = {
    websiteUrl: "https://example.test/contact",
    contactPageFound: true,
    formFound: true,
    populatedFields: ["email", "message"],
    submissionAttempted: true,
    submissionConfirmed: false,
    status: "PARTIAL",
    failureKind: "submission.unconfirmed",
    reason: "submission was attempted, but confirmation was not proven",
  };
  const emails: EmailChannelOutcome = {
    websiteUrl: forms.websiteUrl,
    status: "SUCCESS",
    emails: ["hello@example.test"],
    plannedPageCount: 2,
    inspectedPages: [
      "https://example.test/",
      "https://example.test/contact",
    ],
    failedPages: [],
  };
  const meetings: MeetingChannelOutcome = {
    websiteUrl: forms.websiteUrl,
    status: "SUCCESS",
    meetingLinks: [
      {
        url: "https://calendly.com/example/demo",
        provider: "calendly",
        sources: [
          {
            pageUrl: "https://example.test/contact",
            kind: "visible_link",
            label: "Schedule a demo",
          },
        ],
      },
    ],
    plannedPageCount: 2,
    inspectedPages: [
      "https://example.test/",
      "https://example.test/contact",
    ],
    failedPages: [],
  };

  const outcome = create_contact_outreach_outcome(forms, emails, meetings);

  assert.deepEqual(Object.keys(outcome.channels), [
    "forms",
    "emails",
    "meetings",
  ]);
  assert.equal(outcome.channels.forms, forms);
  assert.equal(outcome.channels.emails, emails);
  assert.equal(outcome.channels.meetings, meetings);
  assert.equal(outcome.websiteUrl, forms.websiteUrl);
  assert.equal(outcome.executionStatus, "FINISHED");
  assert.equal(outcome.status, forms.status);
  assert.equal(outcome.failureKind, forms.failureKind);
  assert.equal(outcome.reason, forms.reason);
  assert.deepEqual(outreach_attempt_completion_from_outcome(outcome), {
    executionStatus: "finished",
    formsResult: "partial",
    emailDiscoveryResult: "success",
    meetingDiscoveryResult: "success",
  });

  const report = format_contact_outreach_outcome(outcome);
  assert.match(report, /Execution status: FINISHED/);
  assert.match(report, /Forms status: PARTIAL/);
  assert.match(report, /Emails status: SUCCESS/);
  assert.match(report, /Meetings status: SUCCESS/);
  assert.match(report, /Discovered email: hello@example\.test/);
  assert.match(report, /Meeting link: https:\/\/calendly\.com\/example\/demo/);
  assert.equal(report.match(/^Status:/gm)?.length, 1);

  const runFailed = create_contact_outreach_outcome(
    forms,
    emails,
    meetings,
    "RUN_FAILED",
  );
  assert.deepEqual(outreach_attempt_completion_from_outcome(runFailed), {
    executionStatus: "run_failed",
    formsResult: null,
    emailDiscoveryResult: null,
    meetingDiscoveryResult: null,
  });
});

test("npm workflow commands target only the outreach entry point", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
    scripts: Record<string, string>;
  };
  for (const command of ["start", "production", "deep-debug"]) {
    assert.match(
      packageJson.scripts[command] ?? "",
      /src\/contact_outreach_workflow\/contact_outreach_orchestrator\.ts/,
    );
  }
  assert.equal(packageJson.scripts.discovery, undefined);
});

test("future ranking and sending stages remain tracked skeletons", async () => {
  const leafDirectories = [
    "emails/pipeline/B_ranking",
    "emails/pipeline/C_composition",
    "emails/pipeline/D_sending",
    "meetings/pipeline/B_ranking",
  ];

  for (const leafDirectory of leafDirectories) {
    const keepPath =
      `src/contact_outreach_workflow/contact_channels/${leafDirectory}/.gitkeep`;
    assert.equal((await stat(keepPath)).isFile(), true, keepPath);
  }

  for (const activeMeetingFile of [
    "src/contact_outreach_workflow/contact_channels/meetings/meetings_orchestrator.ts",
    "src/contact_outreach_workflow/contact_channels/meetings/shared_files_meetings/meeting_types_(Support).ts",
    "src/contact_outreach_workflow/contact_channels/meetings/pipeline/A_discovery/A1_meeting_discovery_(Integration).ts",
    "src/contact_outreach_workflow/contact_channels/meetings/pipeline/C_reporting/C1_meeting_reporting_(Support).ts",
    "src/contact_outreach_workflow/contact_channels/meetings/AGENTS.md",
  ]) {
    assert.equal((await stat(activeMeetingFile)).isFile(), true, activeMeetingFile);
  }

  await assert.rejects(
    stat(["src", ["contact", "form", "workflow"].join("_")].join("/")),
    (error: unknown) =>
      (error as NodeJS.ErrnoException).code === "ENOENT",
  );
});
