import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
  resolve_cli_options,
  run_contact_outreach_workflow,
} from "../src/contact_outreach_workflow/contact_outreach_orchestrator.js";
import {
  create_contact_outreach_outcome,
  format_contact_outreach_outcome,
} from "../src/contact_outreach_workflow/orchestrator/E_aggregate_reporting/E_aggregate_reporting_(Support).js";
import { create_email_failure_outcome } from "../src/contact_outreach_workflow/contact_channels/emails/pipeline/E_reporting/E1_email_reporting_(Support).js";
import { create_meeting_failure_outcome } from "../src/contact_outreach_workflow/contact_channels/meetings/pipeline/C_reporting/C1_meeting_reporting_(Support).js";
import {
  is_contact_form_debug_enabled,
  RUN_MODE_ENVIRONMENT_VARIABLE,
} from "../src/contact_outreach_workflow/shared_files_orchestrator/outreach_constants_(Support).js";
import type {
  ContactFillValues,
  NetworkDebugRecord,
} from "../src/contact_outreach_workflow/contact_channels/forms/shared_files_forms/forms_types_(Support).js";
import { analyze_network_submission_evidence } from "../src/contact_outreach_workflow/contact_channels/forms/pipeline/C_submission/C7_network_submission_evidence_(Deterministic).js";

let server: Server;
let origin: string;
let temporaryDirectory: string;
let forbiddenSubmitClickCount = 0;

before(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "contact-form-poc-"));
  server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");

    if (request.method === "POST" && requestUrl.pathname === "/api/contact-no-ui") {
      response.statusCode = 204;
      response.end();
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/contact-fail") {
      response.statusCode = 500;
      response.end("contact request failed");
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/captcha-reject") {
      response.statusCode = 403;
      response.end("captcha verification required");
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/analytics/collect") {
      response.statusCode = 204;
      response.end();
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/should-not-click") {
      forbiddenSubmitClickCount += 1;
      response.statusCode = 204;
      response.end();
      return;
    }

    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(page_for_path(request.url ?? "/"));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Local test server did not expose a TCP port");
  }
  origin = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await rm(temporaryDirectory, { recursive: true, force: true });
});

test("contact-form workflow scenarios", async (context) => {
  await context.test("submits and confirms an inline contact form", async () => {
    const outcome = await run_for_path("/inline");

    assert.equal(outcome.status, "SUCCESS", JSON.stringify(outcome));
    assert.equal(outcome.contactPageFound, true);
    assert.equal(outcome.formFound, true);
    assert.equal(outcome.discovery?.assessment, "confirmed_form_present");
    assert.equal(outcome.discovery?.presenceEvidenceStrength, "strong");
    assert.equal(outcome.discovery?.searchCoverage, "complete");
    assert.deepEqual(outcome.populatedFields, ["name", "email", "phone", "message"]);
    assert.equal(outcome.submissionConfirmed, true);
  });

  await context.test("keeps contact forms with embedded search widgets", async () => {
    const outcome = await run_for_path("/search-widget-contact");

    assert.equal(outcome.status, "SUCCESS", JSON.stringify(outcome));
    assert.equal(outcome.contactPageFound, true);
    assert.equal(outcome.formFound, true);
    assert.deepEqual(outcome.populatedFields, [
      "name",
      "email",
      "phone",
      "message",
    ]);
  });

  await context.test("submits forms whose submit control is an anchor", async () => {
    const outcome = await run_for_path("/anchor-submit");

    assert.equal(outcome.status, "SUCCESS", JSON.stringify(outcome));
    assert.equal(outcome.submissionAttempted, true);
    assert.equal(outcome.submissionConfirmed, true);
  });

  await context.test("follows a ranked contact link", async () => {
    const outcome = await run_for_path("/linked-home");

    assert.equal(outcome.status, "SUCCESS");
    assert.equal(outcome.contactPageFound, true);
    assert.equal(outcome.formFound, true);
  });

  await context.test("retries discovery after delayed SPA rendering", async () => {
    const outcome = await run_for_path("/delayed-spa-contact");

    assert.equal(outcome.status, "SUCCESS", JSON.stringify(outcome));
    assert.equal(outcome.contactPageFound, true);
    assert.equal(outcome.formFound, true);
    assert.deepEqual(outcome.populatedFields, [
      "name",
      "email",
      "phone",
      "message",
    ]);
  });

  await context.test("finds and submits an iframe-hosted form", async () => {
    const outcome = await run_for_path("/iframe-home");

    assert.equal(outcome.status, "SUCCESS");
    assert.equal(outcome.formFound, true);
    assert.equal(outcome.submissionConfirmed, true);
  });

  await context.test("submits a contact form with only a message field", async () => {
    const outcome = await run_for_path("/partial");

    assert.equal(outcome.status, "SUCCESS");
    assert.deepEqual(outcome.populatedFields, ["message"]);
  });

  await context.test("keeps wrapped native forms on the generic submit path", async () => {
    const outputPath = join(
      temporaryDirectory,
      "artifact-wrapped-native",
      "production.txt",
    );
    const outcome = await run_for_path(
      "/wrapped-native-form",
      { runMode: "production", outputPath },
    );

    assert.equal(outcome.status, "SUCCESS", JSON.stringify(outcome));
    assert.match(
      outcome.submissionDebug?.originalSubmitCandidate ?? "",
      /genericSubmitControl/,
    );
    assert.equal(outcome.submissionDebug?.submitTargetKind, "nativeSubmit");
    assert.equal(outcome.submissionDebug?.buttonClickCount, 1);
  });

  await context.test("supports a non-navigational send anchor in a non-native form", async () => {
    const outcome = await run_for_path(
      "/form-like-anchor-submit",
    );

    assert.equal(outcome.status, "SUCCESS", JSON.stringify(outcome));
  });

  await context.test("rejects a Contact navigation anchor as a submit control", async () => {
    const outputPath = join(
      temporaryDirectory,
      "artifact-form-like-contact-anchor",
      "production.txt",
    );
    const outcome = await run_for_path(
      "/form-like-contact-anchor",
      { runMode: "production", outputPath },
    );

    assert.equal(outcome.status, "SUCCESS", JSON.stringify(outcome));
    assert.match(outcome.submissionDebug?.selectedSubmitControl ?? "", /Send request/);
    assert.equal(outcome.submissionDebug?.buttonClickCount, 1);
  });

  await context.test("accepts a submit control whose child receives the hit test", async () => {
    const outcome = await run_for_path("/submit-child-hit-target");
    assert.equal(outcome.status, "SUCCESS", JSON.stringify(outcome));
    assert.equal(outcome.submissionAttempted, true);
  });

  await context.test("fills extended business contact values from input JSON", async () => {
    const outcome = await run_for_path(
      "/extended-contact-values",
      undefined,
      {
        company: "Aura",
        role: "Sales Manager",
        website: "https://www.aura.com",
        country: "USA",
      },
    );

    assert.equal(outcome.status, "SUCCESS", JSON.stringify(outcome));
    assert.deepEqual(outcome.populatedFields, [
      "name",
      "email",
      "phone",
      "message",
      "company",
      "role",
      "website",
      "country",
    ]);
  });

  await context.test("prefers a complete contact form over a newsletter form", async () => {
    const outcome = await run_for_path("/newsletter-plus-contact");

    assert.equal(outcome.status, "SUCCESS", JSON.stringify(outcome));
    assert.equal(outcome.messageDisposition, "populated");
    assert.equal(outcome.populatedFields.includes("message"), true);
  });

  await context.test("rejects a route finder when a complete contact form exists", async () => {
    const outcome = await run_for_path("/route-plus-contact");

    assert.equal(outcome.status, "SUCCESS", JSON.stringify(outcome));
    assert.equal(outcome.populatedFields.includes("message"), true);
  });

  await context.test("complete forms outrank higher-scoring progression forms", async () => {
    const outcome = await run_for_path("/complete-outranks-progression");

    assert.equal(outcome.status, "SUCCESS", JSON.stringify(outcome));
    assert.deepEqual(outcome.populatedFields, ["message"]);
  });

  await context.test("advances a one-step contact form to its message field", async () => {
    const outcome = await run_for_path("/multi-step-one");

    assert.equal(outcome.status, "SUCCESS", JSON.stringify(outcome));
    assert.equal(outcome.messageDisposition, "populated");
    assert.equal(outcome.populatedFields.includes("message"), true);
  });

  await context.test("advances at most two safe contact-form steps", async () => {
    const outcome = await run_for_path("/multi-step-two");

    assert.equal(outcome.status, "SUCCESS", JSON.stringify(outcome));
    assert.equal(outcome.messageDisposition, "populated");
  });

  await context.test("stops when a third progression step would be required", async () => {
    const outcome = await run_for_path("/multi-step-three");

    assert.equal(outcome.status, "FAILED", JSON.stringify(outcome));
    assert.equal(outcome.submissionAttempted, false);
    assert.equal(outcome.messageDisposition, "notOffered");
    assert.match(outcome.reason ?? "", /two-step progression limit/i);
  });

  await context.test("never treats a default-submit Next button as progression", async () => {
    const outcome = await run_for_path("/default-submit-next");

    assert.equal(outcome.status, "FAILED", JSON.stringify(outcome));
    assert.equal(outcome.submissionAttempted, false);
    assert.equal(outcome.messageDisposition, "notOffered");
  });

  await context.test("stops when progression does not change form state", async () => {
    const outcome = await run_for_path("/progression-no-change");

    assert.equal(outcome.status, "FAILED", JSON.stringify(outcome));
    assert.equal(outcome.submissionAttempted, false);
    assert.match(outcome.reason ?? "", /no form-state change/i);
  });

  await context.test("stops when progression triggers a network submission", async () => {
    const outcome = await run_for_path("/progression-network-request");

    assert.equal(outcome.status, "FAILED", JSON.stringify(outcome));
    assert.equal(outcome.submissionAttempted, false);
    assert.match(outcome.reason ?? "", /network submission request/i);
  });

  await context.test("stops when progression repeats an earlier form state", async () => {
    const outcome = await run_for_path("/progression-repeated-state");

    assert.equal(outcome.status, "FAILED", JSON.stringify(outcome));
    assert.equal(outcome.submissionAttempted, false);
    assert.match(outcome.reason ?? "", /repeated a previously observed form state/i);
  });

  await context.test("stops when progression leaves the allowed origin", async () => {
    const outcome = await run_for_path("/progression-cross-origin");

    assert.equal(outcome.status, "FAILED", JSON.stringify(outcome));
    assert.equal(outcome.submissionAttempted, false);
    assert.match(outcome.reason ?? "", /outside the allowed origin/i);
  });

  await context.test("never advances through a CAPTCHA-owned control", async () => {
    const outcome = await run_for_path("/progression-captcha-target");

    assert.equal(outcome.status, "FAILED", JSON.stringify(outcome));
    assert.equal(outcome.submissionAttempted, false);
    assert.equal(outcome.messageDisposition, "notOffered");
  });

  await context.test("submits a strong contact form that intentionally has no message field", async () => {
    const outcome = await run_for_path("/contact-without-message");

    assert.equal(outcome.status, "INCONCLUSIVE", JSON.stringify(outcome));
    assert.equal(outcome.submissionAttempted, true);
    assert.equal(outcome.messageDisposition, "notOffered");
    assert.match(outcome.reason ?? "", /submission was attempted/i);
  });

  await context.test("checks required privacy consent", async () => {
    const outcome = await run_for_path("/consent");

    assert.equal(outcome.status, "SUCCESS");
    assert.equal(outcome.populatedFields.includes("consent"), true);
  });

  await context.test("selects aria-required dropdowns", async () => {
    const outcome = await run_for_path("/aria-required-select");

    assert.equal(outcome.status, "SUCCESS", JSON.stringify(outcome));
    assert.equal(outcome.populatedFields.includes("selection"), true);
  });

  await context.test("fills unknown required text fields with fallback value", async () => {
    const artifactDirectory = join(temporaryDirectory, "artifact-unknown-text");
    const outputPath = join(artifactDirectory, "production.txt");
    const outcome = await run_for_path("/unknown-required-text", {
      outputPath,
    });

    assert.equal(outcome.status, "SUCCESS", JSON.stringify(outcome));
    assert.equal(outcome.populationDebug?.unknownTextFieldsFilled, 1);
    assert.equal(outcome.populationDebug?.unhandledRequiredFields, 0);

    const report = format_contact_outreach_outcome(
      create_contact_outreach_outcome(
        outcome,
        create_email_failure_outcome(
          outcome.websiteUrl,
          "Email discovery was not run in this form-report unit test.",
        ),
        create_meeting_failure_outcome(
          outcome.websiteUrl,
          "Meeting discovery was not run in this form-report unit test.",
        ),
      ),
      "production",
      outputPath,
    );
    assert.match(report, /==================== ARTIFACTS ====================/);
    assert.match(report, /Missing-fields report:/);
    assert.doesNotMatch(report, /Unknown text fields filled:/);

    const missingFields = JSON.parse(
      await readFile(join(artifactDirectory, "missing-fields.json"), "utf8"),
    ) as {
      records: Array<{
        action: string;
        fillValue?: string;
        name: string;
      }>;
    };

    assert.equal(missingFields.records.length, 1);
    assert.equal(missingFields.records[0]?.action, "filledUnknownText");
    assert.equal(missingFields.records[0]?.fillValue, "Hello");
    assert.equal(missingFields.records[0]?.name, "company");
  });

  await context.test("selects native dropdowns and reports the selected option", async () => {
    const artifactDirectory = join(temporaryDirectory, "artifact-native-dropdown");
    const outputPath = join(artifactDirectory, "production.txt");
    const outcome = await run_for_path("/native-dropdown-fallback", {
      outputPath,
    });

    assert.equal(outcome.status, "SUCCESS", JSON.stringify(outcome));
    assert.equal(outcome.populatedFields.includes("selection"), true);
    assert.equal(outcome.populationDebug?.dropdownsSelected, 1);

    const missingFields = JSON.parse(
      await readFile(join(artifactDirectory, "missing-fields.json"), "utf8"),
    ) as {
      records: Array<{
        action: string;
        selectedOptionText?: string;
        selectedOptionValue?: string;
      }>;
    };

    assert.equal(missingFields.records[0]?.action, "selectedDropdown");
    assert.equal(missingFields.records[0]?.selectedOptionText, "Sales");
    assert.equal(missingFields.records[0]?.selectedOptionValue, "sales");
  });

  await context.test("selects dropdowns when the selected placeholder has value zero", async () => {
    const artifactDirectory = join(temporaryDirectory, "artifact-topic-placeholder");
    const outputPath = join(artifactDirectory, "production.txt");
    const outcome = await run_for_path("/topic-placeholder-zero", {
      outputPath,
    });

    assert.equal(outcome.status, "SUCCESS", JSON.stringify(outcome));
    assert.equal(outcome.populatedFields.includes("selection"), true);
    assert.equal(outcome.populationDebug?.dropdownsSelected, 1);

    const missingFields = JSON.parse(
      await readFile(join(artifactDirectory, "missing-fields.json"), "utf8"),
    ) as {
      records: Array<{
        action: string;
        name: string;
        valueBefore?: string;
        selectedOptionText?: string;
        selectedOptionValue?: string;
      }>;
    };

    assert.equal(missingFields.records.length, 1);
    assert.equal(missingFields.records[0]?.action, "selectedDropdown");
    assert.equal(missingFields.records[0]?.name, "subject");
    assert.equal(missingFields.records[0]?.valueBefore, "0");
    assert.equal(missingFields.records[0]?.selectedOptionText, "Development");
    assert.equal(missingFields.records[0]?.selectedOptionValue, "Development");
  });

  await context.test("dismisses a cookie overlay before submit", async () => {
    const outcome = await run_for_path("/cookie-overlay");

    assert.equal(outcome.status, "SUCCESS", JSON.stringify(outcome));
    assert.equal(outcome.submissionAttempted, true);
    assert.equal(outcome.submissionConfirmed, true);
  });

  await context.test("selects hidden native dropdowns through visible styled companions", async () => {
    const artifactDirectory = join(temporaryDirectory, "artifact-hidden-styled-dropdown");
    const outputPath = join(artifactDirectory, "production.txt");
    const outcome = await run_for_path("/hidden-native-styled-dropdown", {
      outputPath,
    });

    assert.equal(outcome.status, "SUCCESS", JSON.stringify(outcome));
    assert.equal(outcome.populatedFields.includes("selection"), true);
    assert.equal(outcome.populationDebug?.dropdownsSelected, 1);

    const missingFields = JSON.parse(
      await readFile(join(artifactDirectory, "missing-fields.json"), "utf8"),
    ) as {
      records: Array<{
        action: string;
        name: string;
        valueBefore?: string;
        valueAfter?: string;
        selectedOptionText?: string;
        selectedOptionValue?: string;
      }>;
    };

    assert.equal(missingFields.records.length, 1);
    assert.equal(missingFields.records[0]?.action, "selectedDropdown");
    assert.equal(missingFields.records[0]?.name, "subject");
    assert.equal(missingFields.records[0]?.valueBefore, "0");
    assert.equal(missingFields.records[0]?.valueAfter, "Development");
    assert.equal(missingFields.records[0]?.selectedOptionText, "Development");
    assert.equal(missingFields.records[0]?.selectedOptionValue, "Development");
  });

  await context.test("reports hidden native dropdowns without visible styled companions", async () => {
    const artifactDirectory = join(temporaryDirectory, "artifact-hidden-dropdown-no-companion");
    const outputPath = join(artifactDirectory, "production.txt");
    const outcome = await run_for_path("/hidden-native-dropdown-no-companion", {
      outputPath,
    });

    assert.equal(outcome.status, "SUCCESS", JSON.stringify(outcome));
    assert.equal(outcome.populationDebug?.dropdownsSelected, 0);
    assert.equal(outcome.populationDebug?.unhandledRequiredFields, 1);

    const missingFields = JSON.parse(
      await readFile(join(artifactDirectory, "missing-fields.json"), "utf8"),
    ) as {
      records: Array<{
        action: string;
        name: string;
        reason: string;
      }>;
    };

    assert.equal(missingFields.records.length, 1);
    assert.equal(missingFields.records[0]?.action, "unhandledRequired");
    assert.equal(missingFields.records[0]?.name, "subject");
    assert.match(missingFields.records[0]?.reason ?? "", /hidden native dropdown/i);
  });

  await context.test("skips first-option sentinel dropdown placeholders", async () => {
    const artifactDirectory = join(temporaryDirectory, "artifact-sentinel-dropdown");
    const outputPath = join(artifactDirectory, "production.txt");
    const outcome = await run_for_path("/sentinel-dropdown-placeholder", {
      outputPath,
    });

    assert.equal(outcome.status, "SUCCESS", JSON.stringify(outcome));
    assert.equal(outcome.populatedFields.includes("selection"), true);
    assert.equal(outcome.populationDebug?.dropdownsSelected, 1);

    const missingFields = JSON.parse(
      await readFile(join(artifactDirectory, "missing-fields.json"), "utf8"),
    ) as {
      records: Array<{
        action: string;
        valueBefore?: string;
        selectedOptionText?: string;
        selectedOptionValue?: string;
      }>;
    };

    assert.equal(missingFields.records.length, 1);
    assert.equal(missingFields.records[0]?.action, "selectedDropdown");
    assert.equal(missingFields.records[0]?.valueBefore, "-1");
    assert.equal(missingFields.records[0]?.selectedOptionText, "Billing");
    assert.equal(missingFields.records[0]?.selectedOptionValue, "billing");
  });

  await context.test("reports unsupported required custom dropdowns", async () => {
    const artifactDirectory = join(temporaryDirectory, "artifact-custom-dropdown");
    const outputPath = join(artifactDirectory, "production.txt");
    const outcome = await run_for_path("/custom-dropdown-unhandled", {
      outputPath,
    });

    assert.equal(outcome.status, "SUCCESS", JSON.stringify(outcome));
    assert.equal(outcome.populationDebug?.unhandledRequiredFields, 1);

    const missingFields = JSON.parse(
      await readFile(join(artifactDirectory, "missing-fields.json"), "utf8"),
    ) as {
      records: Array<{
        action: string;
        role: string;
        reason: string;
      }>;
    };

    assert.equal(missingFields.records[0]?.action, "unhandledRequired");
    assert.equal(missingFields.records[0]?.role, "combobox");
    assert.match(missingFields.records[0]?.reason ?? "", /custom dropdown/i);
  });

  await context.test("selects the first yes-no checkbox choice", async () => {
    const artifactDirectory = join(temporaryDirectory, "artifact-checkbox-choice");
    const outputPath = join(artifactDirectory, "production.txt");
    const outcome = await run_for_path("/checkbox-choice-fallback", {
      outputPath,
    });

    assert.equal(outcome.status, "SUCCESS", JSON.stringify(outcome));
    assert.equal(outcome.populatedFields.includes("selection"), true);
    assert.equal(outcome.populationDebug?.checkboxChoicesSelected, 1);

    const missingFields = JSON.parse(
      await readFile(join(artifactDirectory, "missing-fields.json"), "utf8"),
    ) as {
      records: Array<{
        action: string;
        groupKey?: string;
        selectedChoiceText?: string;
        selectedChoiceValue?: string;
      }>;
    };

    assert.equal(missingFields.records[0]?.action, "selectedCheckbox");
    assert.equal(missingFields.records[0]?.groupKey, "opt_in_marketing_updates");
    assert.equal(missingFields.records[0]?.selectedChoiceText, "Yes");
    assert.equal(missingFields.records[0]?.selectedChoiceValue, "Yes");
  });

  await context.test("completes active required native controls and duplicate contact fields", async () => {
    const artifactDirectory = join(
      temporaryDirectory,
      "artifact-round2-active-required",
    );
    const outcome = await run_for_path(
      "/round2-active-required-controls",
      { outputPath: join(artifactDirectory, "production.txt") },
    );

    assert.equal(outcome.status, "SUCCESS", JSON.stringify(outcome));
    assert.equal(outcome.submissionAttempted, true);
    assert.equal(outcome.submissionConfirmed, true);
    assert.equal(outcome.populatedFields.includes("selection"), true);
    assert.equal(
      (outcome.populationDebug?.duplicateContactFieldsFilled ?? 0) >= 2,
      true,
    );
    assert.equal(outcome.populationDebug?.radioChoicesSelected, 1);
    assert.equal(outcome.populationDebug?.dropdownsSelected, 1);
    assert.equal(outcome.populationDebug?.unresolvedActiveRequiredControls, 0);
  });

  await context.test("completes simple required ARIA choice widgets with verified state", async () => {
    const artifactDirectory = join(
      temporaryDirectory,
      "artifact-round2-aria-required",
    );
    const outcome = await run_for_path(
      "/round2-aria-required-widgets",
      { outputPath: join(artifactDirectory, "production.txt") },
    );

    assert.equal(outcome.status, "SUCCESS", JSON.stringify(outcome));
    assert.equal(outcome.submissionConfirmed, true);
    assert.equal(outcome.populationDebug?.customChoicesSelected, 3);
    assert.equal(outcome.populationDebug?.unhandledRequiredFields, 0);
  });

  await context.test("omits confidently inactive hidden conditional controls from submission", async () => {
    const artifactDirectory = join(
      temporaryDirectory,
      "artifact-round2-hidden-conditional",
    );
    const outcome = await run_for_path(
      "/round2-hidden-conditional",
      { outputPath: join(artifactDirectory, "production.txt") },
    );

    assert.equal(outcome.status, "SUCCESS", JSON.stringify(outcome));
    assert.equal(outcome.submissionAttempted, true);
    assert.equal(outcome.submissionConfirmed, true);
    assert.equal(outcome.populationDebug?.inactiveConditionalControls, 1);
    assert.equal(
      outcome.submissionDebug?.inactiveConditionalControlsDisabled,
      1,
    );
  });

  await context.test("clicks an intermediate confirmation submit button", async () => {
    const outcome = await run_for_path("/confirm-step");

    assert.equal(outcome.status, "SUCCESS", JSON.stringify(outcome));
    assert.equal(outcome.submissionAttempted, true);
    assert.equal(outcome.submissionConfirmed, true);
  });

  await context.test("reports an unconfirmed submission as inconclusive", async () => {
    const outcome = await run_for_path("/unconfirmed");

    assert.equal(outcome.status, "INCONCLUSIVE");
    assert.equal(outcome.submissionAttempted, true);
    assert.equal(outcome.submissionConfirmed, false);
  });

  await context.test("recognizes the evidenced French success message", async () => {
    const outcome = await run_for_path("/round3-french-success");
    assert.equal(outcome.status, "SUCCESS", JSON.stringify(outcome));
    assert.equal(outcome.submissionConfirmed, true);
    assert.equal(outcome.confirmationEvidence, "successText");
    assert.equal(outcome.postClickDisposition, "confirmed");
  });

  await context.test("classifies a new post-submit validation message as rejected", async () => {
    const outcome = await run_for_path("/round3-visible-rejection");
    assert.equal(outcome.status, "FAILED", JSON.stringify(outcome));
    assert.equal(outcome.submissionAttempted, true);
    assert.equal(outcome.submissionConfirmed, false);
    assert.equal(outcome.failureKind, "submission.rejected");
    assert.equal(outcome.postClickDisposition, "rejected");
    assert.deepEqual(
      outcome.rejectionEvidence?.map((evidence) => evidence.category),
      ["validation"],
    );
  });

  await context.test("keeps pre-existing and neutral messages unconfirmed", async () => {
    const preexisting = await run_for_path("/round3-preexisting-rejection");
    const neutral = await run_for_path("/round3-neutral-message");
    for (const outcome of [preexisting, neutral]) {
      assert.equal(outcome.status, "INCONCLUSIVE", JSON.stringify(outcome));
      assert.equal(outcome.failureKind, "submission.inconclusive");
      assert.equal(outcome.postClickDisposition, "unconfirmed");
      assert.equal(outcome.rejectionEvidence?.length ?? 0, 0);
    }
  });

  await context.test("reports contradictory positive and rejection evidence separately", async () => {
    const outcome = await run_for_path("/round3-contradictory");
    assert.equal(outcome.status, "INCONCLUSIVE", JSON.stringify(outcome));
    assert.equal(outcome.submissionAttempted, true);
    assert.equal(outcome.submissionConfirmed, false);
    assert.equal(outcome.failureKind, "submission.inconclusive");
    assert.equal(outcome.postClickDisposition, "contradictory");
    assert.equal(outcome.confirmationEvidence, "network");
    assert.equal(outcome.rejectionEvidence?.length, 1);
  });

  await context.test("classifies a correlated failed form request as rejected", async () => {
    const outcome = await run_for_path("/round3-server-rejection");
    assert.equal(outcome.status, "FAILED", JSON.stringify(outcome));
    assert.equal(outcome.failureKind, "submission.rejected");
    assert.equal(outcome.postClickDisposition, "rejected");
    assert.deepEqual(
      outcome.rejectionEvidence?.map((evidence) => evidence.category),
      ["server"],
    );
  });

  await context.test("clears a OneTrust obstruction using Reject before Accept", async () => {
    const outputPath = join(
      temporaryDirectory,
      "artifact-round3-onetrust",
      "production.txt",
    );
    const outcome = await run_for_path("/round3-onetrust-overlay", {
      runMode: "production",
      outputPath,
    });
    assert.equal(outcome.status, "SUCCESS", JSON.stringify(outcome));
    const artifact = JSON.parse(
      await readFile(
        join(outcome.submissionDebug!.artifactDirectory, "submission-debug.json"),
        "utf8",
      ),
    ) as {
      obstructionActions: Array<{
        vendor: string;
        action: string;
        cleared: boolean;
      }>;
    };
    assert.equal(artifact.obstructionActions[0]?.vendor, "oneTrust");
    assert.equal(artifact.obstructionActions[0]?.action, "reject");
    assert.equal(artifact.obstructionActions[0]?.cleared, true);
  });

  await context.test("confirms submission from successful form-like network evidence", async () => {
    const outputPath = join(
      temporaryDirectory,
      "artifact-network-success",
      "production.txt",
    );
    const outcome = await run_for_path("/network-success-no-ui", {
      runMode: "production",
      outputPath,
    });

    assert.equal(outcome.status, "SUCCESS", JSON.stringify(outcome));
    assert.equal(outcome.submissionConfirmed, true);
    assert.equal(outcome.submissionDebug?.confirmationEvidence, "network");
    assert.equal(outcome.submissionDebug?.networkSubmissionEvidenceFound, true);
    assert.equal(
      outcome.submissionDebug?.networkSubmissionEvidenceConfidence,
      "strong",
    );
    assert.match(
      outcome.submissionDebug?.bestNetworkSubmissionRequest?.url ?? "",
      /\/api\/contact-no-ui/,
    );

    const report = format_contact_outreach_outcome(
      create_contact_outreach_outcome(
        outcome,
        create_email_failure_outcome(
          outcome.websiteUrl,
          "Email discovery was not run in this form-report unit test.",
        ),
        create_meeting_failure_outcome(
          outcome.websiteUrl,
          "Meeting discovery was not run in this form-report unit test.",
        ),
      ),
      "production",
      outputPath,
    );
    assert.match(report, /==================== NETWORK ====================/);
    assert.match(report, /==================== ARTIFACTS ====================/);
    assert.match(report, /Report: /);
    assert.match(report, /Confirmation evidence: network/);
    assert.match(report, /Network submission evidence: yes \(strong\)/);
    assert.match(report, /Best submission request: POST 204 .*\/api\/contact-no-ui/);
  });

  await context.test("ignores analytics-only network requests as confirmation", async () => {
    const outputPath = join(
      temporaryDirectory,
      "artifact-analytics-only",
      "production.txt",
    );
    const outcome = await run_for_path("/analytics-only-no-ui", {
      runMode: "production",
      outputPath,
    });

    assert.equal(outcome.status, "INCONCLUSIVE", JSON.stringify(outcome));
    assert.equal(outcome.submissionConfirmed, false);
    assert.equal(outcome.submissionDebug?.confirmationEvidence, "none");
    assert.equal(outcome.submissionDebug?.networkSubmissionEvidenceFound, false);
    assert.equal(
      outcome.submissionDebug?.networkSubmissionEvidenceConfidence,
      "none",
    );
  });

  await context.test("ignores ad-tech form-submit network requests as confirmation", () => {
    const submitClickedAt = "2026-07-08T12:31:36.775Z";
    const evidence = analyze_network_submission_evidence(
      [
        network_record(
          1,
          "POST",
          "https://www.google.com/ccm/form-data/123?en=form_submit",
          204,
          "2026-07-08T12:31:36.974Z",
        ),
        network_record(
          2,
          "POST",
          "https://www.google.com/pagead/form-data/123?en=form_submit",
          200,
          "2026-07-08T12:31:36.975Z",
        ),
        network_record(
          3,
          "POST",
          "https://www.google.com/rmkt/collect/123/?en=form_submit",
          200,
          "2026-07-08T12:31:36.976Z",
        ),
        network_record(
          4,
          "POST",
          "https://px.ads.linkedin.com/wa/",
          204,
          "2026-07-08T12:31:36.977Z",
        ),
        network_record(
          5,
          "POST",
          "https://www.facebook.com/tr/",
          200,
          "2026-07-08T12:31:36.978Z",
          "ev=SubscribedButtonClick&cd[formFeatures]=[]",
        ),
      ],
      submitClickedAt,
      { pageUrlBeforeSubmission: `${origin}/contact-us/` },
    );

    assert.equal(evidence.found, false, JSON.stringify(evidence));
    assert.equal(evidence.confirmsSubmission, false);
    assert.equal(evidence.confidence, "none");
    assert.match(evidence.reason, /tracking|analytics/i);
  });

  await context.test("prefers real submission evidence over tracking requests", () => {
    const submitClickedAt = "2026-07-08T12:31:36.775Z";
    const evidence = analyze_network_submission_evidence(
      [
        network_record(
          1,
          "POST",
          "https://www.google.com/ccm/form-data/123?en=form_submit",
          204,
          "2026-07-08T12:31:36.974Z",
        ),
        network_record(
          2,
          "POST",
          `${origin}/api/contact-no-ui`,
          204,
          "2026-07-08T12:31:36.980Z",
          JSON.stringify({
            name: "Test User",
            email: "test@example.com",
            message: "Hello, I would like someone to contact me.",
          }),
        ),
      ],
      submitClickedAt,
      { pageUrlBeforeSubmission: `${origin}/contact-us/` },
    );

    assert.equal(evidence.found, true, JSON.stringify(evidence));
    assert.equal(evidence.confirmsSubmission, true);
    assert.equal(evidence.confidence, "strong");
    assert.match(evidence.bestRequest?.url ?? "", /\/api\/contact-no-ui/);
  });

  await context.test(
    "does not let a separate CAPTCHA rejection override a successful submission request",
    () => {
      const submitClickedAt = "2026-07-08T12:31:36.775Z";
      const evidence = analyze_network_submission_evidence(
        [
          network_record(
            1,
            "POST",
            `${origin}/api/contact-no-ui`,
            204,
            "2026-07-08T12:31:36.980Z",
            "email=test%40example.com&message=sent",
          ),
          network_record(
            2,
            "POST",
            `${origin}/api/captcha-reject`,
            403,
            "2026-07-08T12:31:36.990Z",
            "captcha=invalid",
          ),
        ],
        submitClickedAt,
        { pageUrlBeforeSubmission: `${origin}/contact-us/` },
      );

      assert.equal(evidence.confirmsSubmission, true, JSON.stringify(evidence));
      assert.equal(evidence.captchaRejected, undefined);
      assert.match(evidence.bestRequest?.url ?? "", /\/api\/contact-no-ui/);
    },
  );

  await context.test("does not confirm failed form-like network requests", async () => {
    const outputPath = join(
      temporaryDirectory,
      "artifact-network-failure",
      "production.txt",
    );
    const outcome = await run_for_path("/network-failure-no-ui", {
      runMode: "production",
      outputPath,
    });

    assert.equal(outcome.status, "FAILED", JSON.stringify(outcome));
    assert.equal(outcome.submissionConfirmed, false);
    assert.equal(outcome.failureKind, "submission.rejected");
    assert.equal(outcome.postClickDisposition, "rejected");
    assert.equal(outcome.submissionDebug?.confirmationEvidence, "none");
    assert.equal(outcome.submissionDebug?.networkSubmissionEvidenceFound, true);
    assert.equal(
      outcome.submissionDebug?.networkSubmissionRejectsSubmission,
      true,
    );
    assert.equal(
      outcome.submissionDebug?.networkSubmissionEvidenceConfidence,
      "strong",
    );
    assert.equal(outcome.submissionDebug?.bestNetworkSubmissionRequest?.status, 500);
    assert.match(
      outcome.submissionDebug?.networkSubmissionEvidenceReason ?? "",
      /non-success HTTP status 500/,
    );
  });

  await context.test("writes no-message submission debug artifacts", async () => {
    const outputPath = join(
      temporaryDirectory,
      "artifact-unconfirmed",
      "production.txt",
    );
    const outcome = await run_for_path("/unconfirmed", {
      runMode: "production",
      outputPath,
    });

    assert.equal(outcome.status, "INCONCLUSIVE");
    assert.equal(outcome.submissionDebug?.postSubmitMessageFound, false);

    const artifactDirectory = outcome.submissionDebug?.artifactDirectory ?? "";
    const submissionDebug = JSON.parse(
      await readFile(join(artifactDirectory, "submission-debug.json"), "utf8"),
    ) as {
      postSubmit: { messageFound: boolean; messageCandidates: unknown[] };
      submitControl: { text: string };
    };

    assert.equal(submissionDebug.postSubmit.messageFound, false);
    assert.deepEqual(submissionDebug.postSubmit.messageCandidates, []);
    assert.equal(submissionDebug.submitControl.text, "Send");
  });

  await context.test("writes redacted network and message artifacts", async () => {
    const outputPath = join(
      temporaryDirectory,
      "artifact-toast-network",
      "production.txt",
    );
    const outcome = await run_for_path("/toast-network", {
      runMode: "production",
      outputPath,
    });

    assert.equal(outcome.status, "SUCCESS", JSON.stringify(outcome));
    assert.equal(outcome.submissionDebug?.postSubmitMessageFound, true);
    assert.match(outcome.submissionDebug?.selectedSubmitControl ?? "", /Send lead/);

    const artifactDirectory = outcome.submissionDebug?.artifactDirectory ?? "";
    const submissionDebug = JSON.parse(
      await readFile(join(artifactDirectory, "submission-debug.json"), "utf8"),
    ) as {
      confirmationEvidence: string;
      networkSubmissionEvidence: {
        found: boolean;
        confidence: string;
        bestRequest?: { method: string; status?: number; url: string };
      };
      postSubmit: { messageFound: boolean; messageCandidates: Array<{ text: string }> };
      submitControl: { text: string };
    };
    const networkDebugText = await readFile(
      join(artifactDirectory, "network.json"),
      "utf8",
    );
    const networkDebug = JSON.parse(networkDebugText) as {
      requests: Array<{ method: string; url: string; postDataPreview?: string }>;
    };

    assert.equal(submissionDebug.postSubmit.messageFound, true);
    assert.equal(submissionDebug.confirmationEvidence, "successText");
    assert.equal(submissionDebug.networkSubmissionEvidence.found, true);
    assert.equal(submissionDebug.networkSubmissionEvidence.confidence, "strong");
    assert.equal(submissionDebug.networkSubmissionEvidence.bestRequest?.method, "POST");
    assert.match(
      submissionDebug.networkSubmissionEvidence.bestRequest?.url ?? "",
      /\/api\/contact/,
    );
    assert.match(submissionDebug.postSubmit.messageCandidates[0]?.text ?? "", /Message received/i);
    assert.equal(submissionDebug.submitControl.text, "Send lead");
    assert.equal(
      networkDebug.requests.some(
        (request) =>
          request.method === "GET" && request.url.includes("/toast-network"),
      ),
      true,
    );
    assert.equal(
      networkDebug.requests.some((request) => request.method === "POST"),
      true,
    );
    assert.equal(networkDebug.requests.length >= 2, true);
    assert.doesNotMatch(networkDebugText, /test@example\.com/);
    assert.match(networkDebugText, /\[redacted/);
  });

  await context.test("records one submit button click in debug artifacts", async () => {
    const outputPath = join(
      temporaryDirectory,
      "artifact-button-inline",
      "production.txt",
    );
    const outcome = await run_for_path("/inline", {
      runMode: "production",
      outputPath,
    });

    assert.equal(outcome.status, "SUCCESS", JSON.stringify(outcome));
    assert.equal(outcome.submissionDebug?.buttonClickCount, 1);
    assert.match(outcome.submissionDebug?.buttonClickSummaries[0] ?? "", /Send message/);

    const buttonAudit = JSON.parse(
      await readFile(
        join(outcome.submissionDebug?.artifactDirectory ?? "", "button-audit.json"),
        "utf8",
      ),
    ) as {
      buttonClicks: Array<{
        actionName: string;
        text: string;
        clickResult: string;
      }>;
    };

    assert.equal(buttonAudit.buttonClicks.length, 1);
    assert.equal(buttonAudit.buttonClicks[0]?.actionName, "submit");
    assert.equal(buttonAudit.buttonClicks[0]?.text, "Send message");
    assert.equal(buttonAudit.buttonClicks[0]?.clickResult, "clicked");
  });

  await context.test("prefers type button submit over secondary CTA", async () => {
    const outputPath = join(
      temporaryDirectory,
      "artifact-type-button-submit",
      "production.txt",
    );
    const outcome = await run_for_path("/type-button-submit-secondary-cta", {
      runMode: "production",
      outputPath,
    });

    assert.equal(outcome.status, "SUCCESS", JSON.stringify(outcome));
    assert.match(outcome.submissionDebug?.selectedSubmitControl ?? "", /SUBMIT/);
    assert.equal(outcome.submissionDebug?.buttonClickCount, 1);

    const artifactDirectory = outcome.submissionDebug?.artifactDirectory ?? "";
    const buttonAudit = JSON.parse(
      await readFile(join(artifactDirectory, "button-audit.json"), "utf8"),
    ) as {
      buttonClicks: Array<{
        text: string;
        type: string;
        clickResult: string;
      }>;
    };
    const submitCandidates = JSON.parse(
      await readFile(join(artifactDirectory, "submit-candidates.json"), "utf8"),
    ) as {
      candidates: Array<{
        text: string;
        type: string;
        selected: boolean;
        reason: string;
        score: number;
        negativeSignals: string[];
      }>;
    };

    assert.equal(buttonAudit.buttonClicks.length, 1);
    assert.equal(buttonAudit.buttonClicks[0]?.text, "SUBMIT");
    assert.equal(buttonAudit.buttonClicks[0]?.type, "button");
    assert.equal(buttonAudit.buttonClicks[0]?.clickResult, "clicked");

    const selectedCandidate = submitCandidates.candidates.find(
      (candidate) => candidate.selected,
    );
    const secondaryCandidate = submitCandidates.candidates.find((candidate) =>
      /SCHEDULE A MEETING/.test(candidate.text),
    );

    assert.equal(selectedCandidate?.text, "SUBMIT");
    assert.equal(selectedCandidate?.type, "button");
    assert.equal(secondaryCandidate?.selected, false);
    assert.equal(
      secondaryCandidate?.negativeSignals.includes("secondary CTA label"),
      true,
    );
  });

  await context.test("records submit and intermediate confirmation button clicks", async () => {
    const outputPath = join(
      temporaryDirectory,
      "artifact-button-confirm",
      "production.txt",
    );
    const outcome = await run_for_path("/confirm-step", {
      runMode: "production",
      outputPath,
    });

    assert.equal(outcome.status, "SUCCESS", JSON.stringify(outcome));
    assert.equal(outcome.submissionDebug?.buttonClickCount, 2);

    const buttonAudit = JSON.parse(
      await readFile(
        join(outcome.submissionDebug?.artifactDirectory ?? "", "button-audit.json"),
        "utf8",
      ),
    ) as {
      buttonClicks: Array<{
        sequenceNumber: number;
        actionName: string;
        text: string;
        clickResult: string;
      }>;
    };

    assert.deepEqual(
      buttonAudit.buttonClicks.map((event) => event.actionName),
      ["submit", "intermediateConfirmation"],
    );
    assert.deepEqual(
      buttonAudit.buttonClicks.map((event) => event.sequenceNumber),
      [1, 2],
    );
    assert.match(buttonAudit.buttonClicks[1]?.text ?? "", /CONFIRM/i);
    assert.equal(buttonAudit.buttonClicks[1]?.clickResult, "clicked");
  });

  await context.test("records failed submit button clicks", async () => {
    const outputPath = join(
      temporaryDirectory,
      "artifact-button-failed",
      "production.txt",
    );
    const outcome = await run_for_path("/failed-click", {
      runMode: "production",
      outputPath,
    });

    assert.equal(outcome.status, "INCONCLUSIVE", JSON.stringify(outcome));
    assert.match(outcome.reason ?? "", /could not be activated/i);

    const buttonAudit = JSON.parse(
      await readFile(
        join(outcome.submissionDebug?.artifactDirectory ?? "", "button-audit.json"),
        "utf8",
      ),
    ) as {
      buttonClicks: Array<{
        actionName: string;
        text: string;
        clickResult: string;
        error?: string;
      }>;
    };

    assert.equal(buttonAudit.buttonClicks.length, 1);
    assert.equal(buttonAudit.buttonClicks[0]?.actionName, "submit");
    assert.equal(buttonAudit.buttonClicks[0]?.text, "Send vanishing");
    assert.equal(buttonAudit.buttonClicks[0]?.clickResult, "failed");
    assert.match(buttonAudit.buttonClicks[0]?.error ?? "", /detached|visible|enabled|stable|timeout/i);
  });

  await context.test(
    "keeps correlated network confirmation authoritative after the form resets",
    async () => {
      const outcome = await run_for_path("/network-success-reset", {
        runMode: "production",
        outputPath: join(
          temporaryDirectory,
          "artifact-network-success-reset",
          "production.txt",
        ),
      });

      assert.equal(outcome.status, "SUCCESS", JSON.stringify(outcome));
      assert.equal(outcome.submissionAttempted, true);
      assert.equal(outcome.submissionConfirmed, true);
      assert.equal(outcome.failureKind, undefined);
      assert.equal(outcome.submissionDebug?.confirmationEvidence, "network");
      assert.equal(outcome.submissionDebug?.networkSubmissionEvidenceFound, true);
    },
  );

  await context.test(
    "classifies a reset without confirmation as unconfirmed rather than validation",
    async () => {
      const outcome = await run_for_path("/reset-without-evidence", {
        runMode: "production",
        outputPath: join(
          temporaryDirectory,
          "artifact-reset-without-evidence",
          "production.txt",
        ),
      });

      assert.equal(outcome.status, "INCONCLUSIVE", JSON.stringify(outcome));
      assert.equal(outcome.submissionAttempted, true);
      assert.equal(outcome.submissionConfirmed, false);
      assert.equal(outcome.failureKind, "submission.inconclusive");
      assert.equal(outcome.submissionDebug?.confirmationEvidence, "none");
      assert.doesNotMatch(outcome.reason ?? "", /validation/i);
    },
  );

  await context.test(
    "confirms a failed click when its form-like network request succeeded",
    async () => {
      const outputPath = join(
        temporaryDirectory,
        "artifact-failed-click-network-success",
        "production.txt",
      );
      const outcome = await run_for_path(
        "/failed-click-network-success",
        {
          runMode: "production",
          outputPath,
        },
      );

      assert.equal(outcome.status, "SUCCESS", JSON.stringify(outcome));
      assert.equal(outcome.submissionDebug?.confirmationEvidence, "network");
      assert.equal(outcome.submissionDebug?.buttonClickCount, 1);
    },
  );

  await context.test("reports a missing contact page and form", async () => {
    const outcome = await run_for_path("/empty");

    assert.equal(outcome.status, "FAILED");
    assert.equal(outcome.contactPageFound, false);
    assert.equal(outcome.formFound, false);
    assert.equal(
      outcome.discovery?.assessment,
      "no_form_observed_after_complete_search",
    );
    assert.equal(outcome.discovery?.presenceEvidenceStrength, "none");
    assert.equal(outcome.discovery?.searchCoverage, "complete");
    assert.match(outcome.reason ?? "", /contact page not found/i);
  });

  await context.test("continues when CAPTCHA markup is present but not blocking", async () => {
    const outcome = await run_for_path("/captcha");

    assert.equal(outcome.status, "SUCCESS", JSON.stringify(outcome));
    assert.equal(outcome.formFound, true);
    assert.equal(outcome.submissionAttempted, true);
  });

  await context.test("fails only when CAPTCHA physically blocks submission", async () => {
    const outcome = await run_for_path("/captcha-blocked");

    assert.equal(outcome.status, "FAILED", JSON.stringify(outcome));
    assert.equal(outcome.formFound, true);
    assert.equal(outcome.submissionAttempted, true);
    assert.match(outcome.reason ?? "", /CAPTCHA physically blocked/i);
  });

  await context.test("reports a CAPTCHA-disabled submit control as physical blockage", async () => {
    const outcome = await run_for_path("/captcha-disabled");

    assert.equal(outcome.status, "FAILED", JSON.stringify(outcome));
    assert.equal(outcome.submissionAttempted, false);
    assert.match(outcome.reason ?? "", /CAPTCHA physically blocked/i);
  });

  await context.test("reports a CAPTCHA-related rejected form request", async () => {
    const outcome = await run_for_path("/captcha-network-rejected");

    assert.equal(outcome.status, "FAILED", JSON.stringify(outcome));
    assert.equal(outcome.submissionAttempted, true);
    assert.match(outcome.reason ?? "", /CAPTCHA physically blocked/i);
  });

  await context.test("ignores CAPTCHA rejection traffic that occurred before submit", async () => {
    const outcome = await run_for_path("/captcha-preclick-traffic");

    assert.equal(outcome.status, "INCONCLUSIVE", JSON.stringify(outcome));
    assert.equal(outcome.failureKind, "submission.inconclusive");
    assert.doesNotMatch(outcome.reason ?? "", /CAPTCHA physically blocked/i);
  });

  await context.test("ignores invalid controls outside the selected form", async () => {
    const outcome = await run_for_path("/unrelated-invalid-control");
    assert.equal(outcome.status, "SUCCESS", JSON.stringify(outcome));
  });

  await context.test("stops unresolved native validation before any submit click", async () => {
    forbiddenSubmitClickCount = 0;
    const outcome = await run_for_path("/validation", {
      runMode: "production",
      outputPath: join(
        temporaryDirectory,
        "artifact-pre-submit-validation",
        "production.txt",
      ),
    });

    assert.equal(outcome.status, "FAILED");
    assert.equal(outcome.submissionAttempted, false);
    assert.equal(outcome.submissionConfirmed, false);
    assert.equal(outcome.failureKind, "submission.validation");
    assert.match(outcome.reason ?? "", /validation blocked/i);
    assert.equal(outcome.submissionDebug?.buttonClickCount, 0);
    assert.equal(
      outcome.submissionDebug?.preSubmitValidationApplicability,
      "applicable",
    );
    assert.equal(outcome.submissionDebug?.preSubmitValid, false);
    assert.equal(outcome.submissionDebug?.populationRecoveryAttempted, true);
    assert.equal(outcome.submissionDebug?.populationRecoverySucceeded, false);
    assert.equal(forbiddenSubmitClickCount, 0);
  });

  await context.test("runs one bounded deterministic recovery before submission", async () => {
    const outcome = await run_for_path("/pre-submit-recovery", {
      runMode: "production",
      outputPath: join(
        temporaryDirectory,
        "artifact-pre-submit-recovery",
        "production.txt",
      ),
    });

    assert.equal(outcome.status, "SUCCESS", JSON.stringify(outcome));
    assert.equal(outcome.submissionAttempted, true);
    assert.equal(outcome.submissionConfirmed, true);
    assert.equal(outcome.submissionDebug?.buttonClickCount, 1);
    assert.equal(
      outcome.submissionDebug?.preSubmitValidationApplicability,
      "applicable",
    );
    assert.equal(outcome.submissionDebug?.preSubmitValid, true);
    assert.equal(outcome.submissionDebug?.populationRecoveryAttempted, true);
    assert.equal(outcome.submissionDebug?.populationRecoverySucceeded, true);
    assert.equal(
      outcome.populatedFields.some((field) => field === "selection"),
      true,
      JSON.stringify(outcome.populatedFields),
    );
  });

  await context.test("respects form novalidate during native submission", async () => {
    const outcome = await run_for_path("/novalidate", {
      runMode: "production",
      outputPath: join(
        temporaryDirectory,
        "artifact-novalidate",
        "production.txt",
      ),
    });

    assert.equal(outcome.status, "SUCCESS", JSON.stringify(outcome));
    assert.equal(outcome.submissionAttempted, true);
    assert.equal(outcome.submissionConfirmed, true);
    assert.equal(
      outcome.submissionDebug?.preSubmitValidationApplicability,
      "notApplicable",
    );
    assert.equal(
      outcome.submissionDebug?.preSubmitValidationBypassReason,
      "formNoValidate",
    );
  });

  await context.test("respects submitter formnovalidate during native submission", async () => {
    const outcome = await run_for_path("/formnovalidate", {
      runMode: "production",
      outputPath: join(
        temporaryDirectory,
        "artifact-formnovalidate",
        "production.txt",
      ),
    });

    assert.equal(outcome.status, "SUCCESS", JSON.stringify(outcome));
    assert.equal(outcome.submissionAttempted, true);
    assert.equal(outcome.submissionConfirmed, true);
    assert.equal(
      outcome.submissionDebug?.preSubmitValidationApplicability,
      "notApplicable",
    );
    assert.equal(
      outcome.submissionDebug?.preSubmitValidationBypassReason,
      "submitterFormNoValidate",
    );
  });

  await context.test("does not apply native validity to a custom JavaScript button", async () => {
    const outcome = await run_for_path("/custom-button-invalid-native-control");

    assert.equal(outcome.status, "SUCCESS", JSON.stringify(outcome));
    assert.equal(outcome.submissionAttempted, true);
    assert.equal(outcome.submissionConfirmed, true);
  });

  await context.test("does not apply native validity to a non-form container", async () => {
    const outcome = await run_for_path(
      "/non-form-invalid-native-control",
    );

    assert.equal(outcome.status, "SUCCESS", JSON.stringify(outcome));
    assert.equal(outcome.submissionAttempted, true);
    assert.equal(outcome.submissionConfirmed, true);
  });

  await context.test("built-in discovery handles a no-form container", async () => {
    const outcome = await run_for_path("/form-like-no-form");

    assert.equal(outcome.status, "SUCCESS", JSON.stringify(outcome));
    assert.equal(outcome.formFound, true);
    assert.deepEqual(outcome.populatedFields, ["name", "email", "message"]);
  });

  await context.test("rejects a weak container in favor of a native form", async () => {
    const outcome = await run_for_path("/weak-container-fallback");

    assert.equal(outcome.status, "SUCCESS", JSON.stringify(outcome));
    assert.deepEqual(outcome.populatedFields, [
      "name",
      "email",
      "phone",
      "message",
    ]);
  });

  await context.test("production and deep-debug modes choose separate defaults", () => {
    assert.deepEqual(resolve_cli_options(["production"]), {
      runMode: "production",
      inputPath: "input/websites.json",
      outputPath: "output/production-result.txt",
    });
    assert.deepEqual(resolve_cli_options(["deep-debug"]), {
      runMode: "deep-debug",
      inputPath: "input/websites.json",
      outputPath: "output/deep-debug-result.txt",
    });
  });

  await context.test("environment run mode can drive CLI defaults", () => {
    assert.deepEqual(
      resolve_cli_options(["demo-inputs/example.json"], {
        [RUN_MODE_ENVIRONMENT_VARIABLE]: "deep-debug",
      }),
      {
        runMode: "deep-debug",
        inputPath: "demo-inputs/example.json",
        outputPath: "output/deep-debug-result.txt",
      },
    );
  });

  await context.test("loads split inputs and updates website status", async () => {
    const websitesPath = join(temporaryDirectory, "websites.json");
    const contactValuesPath = join(temporaryDirectory, "contact-values.json");
    await writeFile(
      websitesPath,
      JSON.stringify({
        websites: [
          {
            websiteUrl: `${origin}/inline`,
            status: "pending",
            statusDescription: "",
          },
        ],
      }),
      "utf8",
    );
    await writeFile(
      contactValuesPath,
      JSON.stringify({
        name: "Test User",
        email: "test@example.com",
        phone: "050-0000000",
        message: "Hello, I would like someone to contact me.",
      }),
      "utf8",
    );

    const outcome = await run_contact_outreach_workflow(
      websitesPath,
      { contactValuesPath },
    );

    assert.equal(outcome.status, "SUCCESS", JSON.stringify(outcome));
    assert.ok(outcome.channels.forms);
    assert.ok(outcome.channels.emails);
    assert.ok(outcome.channels.meetings);
    assert.equal(outcome.channels.emails.status, "FAILED");
    assert.equal(
      outcome.channels.emails.failureKind,
      "email.discovery.no_address",
    );
    assert.equal(outcome.channels.meetings.status, "FAILED");
    assert.equal(
      outcome.channels.meetings.failureKind,
      "meeting.discovery.no_option",
    );
    assert.equal(outcome.status, outcome.channels.forms.status);
    assert.equal(outcome.websiteUrl, outcome.channels.forms.websiteUrl);

    const updatedWebsites = JSON.parse(
      await readFile(websitesPath, "utf8"),
    ) as {
      websites: Array<{ status: string; statusDescription: string }>;
    };
    assert.equal(updatedWebsites.websites[0]?.status, "succeeded");
    assert.equal(
      updatedWebsites.websites[0]?.statusDescription,
      "Submission confirmed",
    );
  });

  await context.test("loads contact values beside a website list by default", async () => {
    const runDirectory = join(temporaryDirectory, "contact-form-runs-input");
    const websitesPath = join(runDirectory, "websites.json");
    await rm(runDirectory, { recursive: true, force: true });
    await mkdir(runDirectory, { recursive: true });
    await writeFile(
      websitesPath,
      JSON.stringify({
        websites: [
          {
            websiteUrl: `${origin}/inline`,
            status: "pending",
            statusDescription: "",
          },
        ],
      }),
      "utf8",
    );
    await writeFile(
      join(runDirectory, "contact-values.json"),
      JSON.stringify({
        name: "Test User",
        email: "test@example.com",
        phone: "050-0000000",
        message: "Hello, I would like someone to contact me.",
      }),
      "utf8",
    );

    const outcome = await run_contact_outreach_workflow(websitesPath);

    assert.equal(outcome.status, "SUCCESS", JSON.stringify(outcome));
  });

  await context.test("explicit debug flag enables debug behavior", () => {
    const previous_debug = process.env.DEBUG_CONTACT_FORM;
    const previous_mode = process.env[RUN_MODE_ENVIRONMENT_VARIABLE];

    try {
      delete process.env.DEBUG_CONTACT_FORM;
      process.env[RUN_MODE_ENVIRONMENT_VARIABLE] = "production";
      assert.equal(is_contact_form_debug_enabled(), false);

      process.env.DEBUG_CONTACT_FORM = "1";
      assert.equal(is_contact_form_debug_enabled(), true);
    } finally {
      restore_env_value("DEBUG_CONTACT_FORM", previous_debug);
      restore_env_value(RUN_MODE_ENVIRONMENT_VARIABLE, previous_mode);
    }
  });

  await context.test("runtime debug logs are not printed from workflow stages", async () => {
    const stageFiles = [
      "src/contact_outreach_workflow/contact_channels/forms/pipeline/B_population/B3_population_field_matching_(Deterministic).ts",
      "src/contact_outreach_workflow/contact_channels/forms/pipeline/B_population/B4_required_form_controls_(Deterministic).ts",
      "src/contact_outreach_workflow/contact_channels/forms/pipeline/B_population/B5_undefined_field_fallback_(Deterministic).ts",
      "src/contact_outreach_workflow/contact_channels/forms/pipeline/C_submission/C1_contact_form_submission_(Integration).ts",
    ];
    const sourceTexts = await Promise.all(
      stageFiles.map((path) => readFile(path, "utf8")),
    );

    assert.equal(sourceTexts.some((sourceText) => sourceText.includes("[contact-debug]")), false);
  });

  await context.test("rejects malformed JSON before opening a browser", async () => {
    const inputPath = join(temporaryDirectory, "malformed.json");
    await writeFile(inputPath, "{not-json", "utf8");

    const outcome = await run_contact_outreach_workflow(inputPath);

    assert.equal(outcome.status, "FAILED");
    assert.equal(outcome.websiteUrl, "(unknown)");
    assert.match(outcome.reason ?? "", /not valid JSON/i);
  });

  await context.test("accepts input JSON with a UTF-8 BOM", async () => {
    const inputPath = join(temporaryDirectory, "bom-input.json");
    await writeFile(
      inputPath,
      `\ufeff${JSON.stringify({
        websiteUrl: `${origin}/inline`,
        name: "Test User",
        email: "test@example.com",
        phone: "050-0000000",
        message: "Hello, I would like someone to contact me.",
      })}`,
      "utf8",
    );

    const outcome = await run_contact_outreach_workflow(inputPath);

    assert.equal(outcome.status, "SUCCESS", JSON.stringify(outcome));
  });

  await context.test("rejects a non-HTTP website URL", async () => {
    const inputPath = join(temporaryDirectory, "invalid-url.json");
    await writeFile(
      inputPath,
      JSON.stringify({
        websiteUrl: "file:///tmp/form.html",
        name: "Test User",
        email: "test@example.com",
        phone: "050-0000000",
        message: "Hello",
      }),
      "utf8",
    );

    const outcome = await run_contact_outreach_workflow(inputPath);

    assert.equal(outcome.status, "FAILED");
    assert.equal(outcome.websiteUrl, "file:///tmp/form.html");
    assert.match(outcome.reason ?? "", /HTTP or HTTPS/i);
  });

  await context.test("reports a navigation failure", async () => {
    const inputPath = join(temporaryDirectory, "unreachable.json");
    await writeFile(
      inputPath,
      JSON.stringify({
        websiteUrl: "http://127.0.0.1:65534",
        name: "Test User",
        email: "test@example.com",
        phone: "050-0000000",
        message: "Hello",
      }),
      "utf8",
    );

    const outcome = await run_contact_outreach_workflow(inputPath);

    assert.equal(outcome.status, "FAILED");
    assert.equal(outcome.channels.forms.contactPageFound, false);
    assert.equal(outcome.channels.emails.status, "FAILED");
    assert.equal(outcome.channels.meetings.status, "FAILED");
    assert.match(outcome.reason ?? "", /Could not open the target website/i);
    assert.equal(outcome.reason, outcome.channels.forms.reason);
    assert.equal(outcome.failureKind, outcome.channels.forms.failureKind);
  });
});

test("submits one mixed English-Hebrew form without rewriting campaign values", async () => {
  const outcome = await run_for_path("/hebrew-mixed");
  assert.equal(outcome.status, "SUCCESS", JSON.stringify(outcome));
  assert.deepEqual(outcome.populatedFields, [
    "name", "email", "phone", "message", "consent", "selection",
  ]);
  assert.equal(outcome.submissionAttempted, true);
  assert.equal(outcome.submissionConfirmed, true);
});

type WorkflowOptions = NonNullable<
  Parameters<typeof run_contact_outreach_workflow>[1]
>;

async function run_for_path(
  path: string,
  options?: WorkflowOptions,
  extendedValues: Partial<
    Pick<ContactFillValues, "company" | "role" | "website" | "country">
  > = {},
) {
  const safeName = path.replaceAll(/[^a-z0-9]/gi, "-");
  const inputPath = join(temporaryDirectory, `${safeName}.json`);
  await writeFile(
    inputPath,
    JSON.stringify({
      websiteUrl: `${origin}${path}`,
      name: "Test User",
      email: "test@example.com",
      phone: "050-0000000",
      message: "Hello, I would like someone to contact me.",
      ...extendedValues,
    }),
    "utf8",
  );
  const outcome = await run_contact_outreach_workflow(inputPath, options);
  return outcome.channels.forms;
}

function network_record(
  id: number,
  method: string,
  url: string,
  status: number | undefined,
  startedAt: string,
  postDataPreview?: string,
): NetworkDebugRecord {
  return {
    id,
    method,
    url,
    resourceType: "fetch",
    startedAt,
    ...(status !== undefined ? { status } : {}),
    ...(postDataPreview ? { postDataPreview } : {}),
  };
}

function page_for_path(path: string): string {
  const contactForm = `
    <form id="contact-form">
      <h1>Contact us</h1>
      <label>Full name <input name="fullName" required></label>
      <label>Email <input name="email" type="email" required></label>
      <label>Phone <input name="phone" type="tel"></label>
      <label>Message <textarea name="message" required></textarea></label>
      <button type="submit">Send message</button>
    </form>
    <div id="result"></div>
    <script>
      document.querySelector('form').addEventListener('submit', (event) => {
        event.preventDefault();
        event.target.hidden = true;
        document.querySelector('#result').textContent = 'Thank you. Your message has been sent.';
      });
    </script>`;

  switch (path) {
    case "/inline":
    case "/contact":
    case "/frame-form":
      return html(contactForm);
    case "/hebrew-mixed":
      return html(`
        <main dir="rtl"><h1>Contact / צור קשר</h1><form id="hebrew-contact">
          <label>שם מלא <input name="x1" required></label>
          <label>אימייל <input name="x2" required></label>
          <label>טלפון <input name="x3"></label>
          <label>הודעה <textarea name="x4" required></textarea></label>
          <label><input type="checkbox" name="privacy" required>אני מאשר את מדיניות הפרטיות</label>
          <button type="submit">שליחת הודעה</button>
        </form><div id="result" role="status"></div></main>
        <script>
          window.submitCount = 0;
          document.querySelector('form').onsubmit = event => {
            event.preventDefault();
            window.submitCount += 1;
            const data = new FormData(event.target);
            const exact = data.get('x1') === 'Test User' &&
              data.get('x2') === 'test@example.com' &&
              data.get('x3') === '050-0000000' &&
              data.get('x4') === 'Hello, I would like someone to contact me.';
            document.querySelector('#result').textContent = exact && window.submitCount === 1
              ? 'תודה, פנייתך התקבלה'
              : 'אירעה שגיאה';
          };
        </script>`);
    case "/search-widget-contact":
      return html(search_widget_contact_form());
    case "/anchor-submit":
      return html(anchor_submit_contact_form());
    case "/wrapped-native-form":
      return html(`
        <main><section><div class="contact-shell">
          <a href="/contact">Contact</a>
          <form><h1>Contact us</h1><input name="name"><input type="email" name="email"><textarea name="message"></textarea><button type="submit">Send message</button></form>
        </div></section></main>
        <div id="result"></div>
        <script>document.querySelector('form').onsubmit = (event) => { event.preventDefault(); document.querySelector('#result').textContent = 'Thank you. Your message has been sent.'; };</script>`);
    case "/form-like-anchor-submit":
      return html(`
        <section id="contact-panel"><h1>Contact us</h1><input name="name"><input type="email" name="email"><textarea name="message"></textarea><a id="send" href="#">Send message</a></section>
        <div id="result"></div>
        <script>document.querySelector('#send').onclick = (event) => { event.preventDefault(); document.querySelector('#result').textContent = 'Your message has been sent'; };</script>`);
    case "/form-like-contact-anchor":
      return html(`
        <section id="contact-panel"><h1>Contact us</h1><input name="name"><input type="email" name="email"><textarea name="message"></textarea><a href="/contact">Contact</a><button type="button" id="send">Send request</button></section>
        <div id="result"></div>
        <script>document.querySelector('#send').onclick = () => { document.querySelector('#result').textContent = 'Your message has been sent'; };</script>`);
    case "/submit-child-hit-target":
      return html(`
        <form><h1>Contact us</h1><input type="email" name="email"><textarea name="message"></textarea><button type="submit"><span>Send message</span></button></form>
        <div id="result"></div>
        <script>document.querySelector('form').onsubmit = (event) => { event.preventDefault(); document.querySelector('#result').textContent = 'Thank you. Your message has been sent.'; };</script>`);
    case "/linked-home":
      return html('<a href="/contact">Contact us</a>');
    case "/delayed-spa-contact":
      return delayed_spa_contact_page();
    case "/iframe-home":
      return html('<iframe title="Contact form" src="/frame-form"></iframe>');
    case "/partial":
      return html(`
        <form><h1>Contact us</h1><textarea name="message"></textarea><button>Send</button></form>
        <div id="result"></div>
        <script>document.querySelector('form').onsubmit = (event) => { event.preventDefault(); event.target.hidden = true; document.querySelector('#result').textContent = 'Thank you for your message.'; };</script>`);
    case "/extended-contact-values":
      return html(`
        <form>
          <h1>Contact us</h1>
          <label>Full name <input name="name"></label>
          <label>Email <input type="email" name="email"></label>
          <label>Phone <input type="tel" name="phone"></label>
          <label>Company <input name="company"></label>
          <label>Job title <input name="job-title"></label>
          <label>Website <input type="url" name="website"></label>
          <label>Country <select name="country"><option value="">Choose</option><option value="US">United States</option><option value="CA">Canada</option></select></label>
          <label>Message <textarea name="message"></textarea></label>
          <button type="submit">Send</button>
        </form>
        <div id="result"></div>
        <script>
          document.querySelector('form').onsubmit = (event) => {
            event.preventDefault();
            const values = Object.fromEntries(new FormData(event.target));
            const valid = values.company === 'Aura' && values['job-title'] === 'Sales Manager' && values.website === 'https://www.aura.com' && values.country === 'US';
            document.querySelector('#result').textContent = valid ? 'Thank you. Your message has been sent.' : 'Extended contact values were incorrect.';
          };
        </script>`);
    case "/newsletter-plus-contact":
      return html(`
        <form id="newsletter"><h2>Newsletter</h2><input type="email" name="newsletterEmail"><button type="submit">Subscribe</button></form>
        <form id="contact"><h1>Contact us</h1><input type="email" name="email"><textarea name="message"></textarea><button type="submit">Send</button></form>
        <div id="result"></div>
        <script>
          document.querySelector('#newsletter').onsubmit = (event) => event.preventDefault();
          document.querySelector('#contact').onsubmit = (event) => { event.preventDefault(); document.querySelector('#result').textContent = 'Thank you. Your message has been sent.'; };
        </script>`);
    case "/route-plus-contact":
      return html(`
        <form id="directions"><h2>Route directions</h2><input name="wpgmza_input_from_2" placeholder="From"><input name="wpgmza_input_to_2" placeholder="To"><button type="submit">Calculate route</button></form>
        <form id="contact"><h1>Contact us</h1><input type="email" name="email"><textarea name="message"></textarea><button type="submit">Send</button></form>
        <div id="result"></div>
        <script>document.querySelector('#contact').onsubmit = (event) => { event.preventDefault(); document.querySelector('#result').textContent = 'Thank you. Your message has been sent.'; };</script>`);
    case "/complete-outranks-progression":
      return html(`
        <form id="long-form"><h1>Contact our project team</h1><input type="email" name="email"><input name="name"><input name="company"><input name="project"><button type="button">Next</button></form>
        <form id="complete-form"><h2>Send a message</h2><textarea name="message"></textarea><button type="submit">Send</button></form>
        <div id="result"></div>
        <script>document.querySelector('#complete-form').onsubmit = (event) => { event.preventDefault(); document.querySelector('#result').textContent = 'Thank you for your message.'; };</script>`);
    case "/multi-step-one":
      return html(multi_step_contact_form(1));
    case "/multi-step-two":
      return html(multi_step_contact_form(2));
    case "/multi-step-three":
      return html(multi_step_contact_form(3));
    case "/default-submit-next":
      return html(`
        <form><h1>Contact us</h1><input type="email" name="email"><button>Next</button></form>
        <script>document.querySelector('form').onsubmit = (event) => event.preventDefault();</script>`);
    case "/progression-no-change":
      return html(`
        <form><h1>Contact us</h1><input type="email" name="email"><button type="button">Continue</button></form>`);
    case "/progression-network-request":
      return html(`
        <form><h1>Contact us</h1><input type="email" name="email"><button type="button">Continue</button></form>
        <script>document.querySelector('button').onclick = () => { fetch('/api/contact-no-ui', { method: 'POST', body: 'step=1' }); document.querySelector('form').insertAdjacentHTML('beforeend', '<input name="company">'); };</script>`);
    case "/progression-repeated-state":
      return html(`
        <form>
          <h1>Contact us</h1>
          <section data-step="one"><input type="email" name="email"><button type="button">Next</button></section>
          <section data-step="two" hidden><input name="name"><button type="button">Continue</button></section>
        </form>
        <script>
          const steps = [...document.querySelectorAll('[data-step]')];
          steps[0].querySelector('button').onclick = () => { steps[0].hidden = true; steps[1].hidden = false; };
          steps[1].querySelector('button').onclick = () => { steps[1].hidden = true; steps[0].hidden = false; };
        </script>`);
    case "/progression-cross-origin": {
      const alternateOrigin = origin.replace("127.0.0.1", "localhost");
      return html(`
        <form><h1>Contact us</h1><input type="email" name="email"><button type="button">Continue</button></form>
        <script>document.querySelector('button').onclick = () => { window.location.href = ${JSON.stringify(`${alternateOrigin}/welcome`)}; };</script>`);
    }
    case "/progression-captcha-target":
      return html(`
        <form><h1>Contact us</h1><input type="email" name="email"><div class="g-recaptcha"><button type="button">Continue</button></div></form>`);
    case "/contact-without-message":
      return html(`
        <form><h1>Contact us about your project</h1><input name="name"><input type="email" name="email"><button type="submit">Send</button></form>
        <script>document.querySelector('form').onsubmit = (event) => event.preventDefault();</script>`);
    case "/unconfirmed":
      return html(`
        <form><h1>Contact us</h1><input type="email" name="email"><textarea name="message"></textarea><button>Send</button></form>
        <script>document.querySelector('form').onsubmit = (event) => event.preventDefault();</script>`);
    case "/round3-french-success":
      return html(`
        <form><h1>Contact us</h1><input type="email" name="email"><textarea name="message"></textarea><button>Send</button></form>
        <div id="result"></div>
        <script>document.querySelector('form').onsubmit = (event) => { event.preventDefault(); document.querySelector('#result').innerHTML = '<div role="status">L\\'enregistrement a été effectué avec succès</div>'; };</script>`);
    case "/round3-visible-rejection":
      return html(`
        <form><h1>Contact us</h1><input type="email" name="email"><textarea name="message"></textarea><button>Send</button></form>
        <div id="result"></div>
        <script>document.querySelector('form').onsubmit = (event) => { event.preventDefault(); document.querySelector('#result').innerHTML = '<div role="alert">Please complete this required field.</div>'; };</script>`);
    case "/round3-preexisting-rejection":
      return html(`
        <form><h1>Contact us</h1><input type="email" name="email"><textarea name="message"></textarea><button>Send</button></form>
        <div role="alert">Please complete this required field.</div>
        <script>document.querySelector('form').onsubmit = (event) => event.preventDefault();</script>`);
    case "/round3-neutral-message":
      return html(`
        <form><h1>Contact us</h1><input type="email" name="email"><textarea name="message"></textarea><button>Send</button></form>
        <div id="result"></div>
        <script>document.querySelector('form').onsubmit = (event) => { event.preventDefault(); document.querySelector('#result').innerHTML = '<div role="status">32768 characters remaining</div>'; };</script>`);
    case "/round3-contradictory":
      return html(`
        <form><h1>Contact us</h1><input type="email" name="email"><textarea name="message"></textarea><button>Send</button></form>
        <div id="result"></div>
        <script>document.querySelector('form').onsubmit = async (event) => { event.preventDefault(); await fetch('/api/contact-no-ui', { method: 'POST', body: new FormData(event.target) }); document.querySelector('#result').innerHTML = '<div role="alert">Please complete this required field.</div>'; };</script>`);
    case "/round3-server-rejection":
      return html(`
        <form action="/api/contact-fail" method="post"><h1>Contact us</h1><input type="email" name="email"><textarea name="message"></textarea><button>Send</button></form>`);
    case "/network-success-no-ui":
      return html(network_only_contact_form("/api/contact-no-ui"));
    case "/network-success-reset":
      return html(`
        <form id="contact">
          <h1>Contact us</h1>
          <input type="email" name="email" required>
          <textarea name="message" required></textarea>
          <button type="submit">Send</button>
        </form>
        <script>
          document.querySelector('#contact').onsubmit = async (event) => {
            event.preventDefault();
            await fetch('/api/contact-no-ui', {
              method: 'POST',
              body: new FormData(event.target),
            });
            event.target.reset();
          };
        </script>`);
    case "/reset-without-evidence":
      return html(`
        <form id="contact">
          <h1>Contact us</h1>
          <input type="email" name="email" required>
          <textarea name="message" required></textarea>
          <button type="submit">Send</button>
        </form>
        <script>
          document.querySelector('#contact').onsubmit = (event) => {
            event.preventDefault();
            event.target.reset();
          };
        </script>`);
    case "/analytics-only-no-ui":
      return html(network_only_contact_form("/analytics/collect"));
    case "/captcha-preclick-traffic":
      return html(`
        <form><h1>Contact us</h1><input type="email" name="email"><textarea name="message"></textarea><button type="submit">Send</button></form>
        <script>
          fetch('/api/captcha-reject', { method: 'POST', body: 'captcha=invalid' });
          document.querySelector('form').onsubmit = (event) => event.preventDefault();
        </script>`);
    case "/unrelated-invalid-control":
      return html(`
        <form id="unrelated"><input required value=""><button type="button">Ignore</button></form>
        <form id="contact"><h1>Contact us</h1><input type="email" name="email"><textarea name="message"></textarea><button type="submit">Send</button></form>
        <div id="result"></div>
        <script>document.querySelector('#contact').onsubmit = (event) => { event.preventDefault(); document.querySelector('#result').textContent = 'Thank you. Your message has been sent.'; };</script>`);
    case "/network-failure-no-ui":
      return html(network_only_contact_form("/api/contact-fail"));
    case "/toast-network":
      return html(`
        <form>
          <h1>Contact us</h1>
          <input type="email" name="email">
          <textarea name="message"></textarea>
          <button type="submit">Send lead</button>
        </form>
        <div id="toast" role="status"></div>
        <script>
          document.querySelector('form').onsubmit = async (event) => {
            event.preventDefault();
            await fetch('/api/contact?email=test@example.com&token=secret', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                email: document.querySelector('[name=email]').value,
                message: document.querySelector('[name=message]').value,
              }),
            });
            document.querySelector('#toast').textContent = 'Message received. We will be in touch.';
          };
        </script>`);
    case "/type-button-submit-secondary-cta":
      return html(`
        <form>
          <h1>Contact us</h1>
          <input name="name" placeholder="Name">
          <input type="email" name="email">
          <textarea name="message"></textarea>
          <button type="button" id="real-submit">SUBMIT</button>
          <section>
            <p>Want to see a demo? Schedule a meeting with us</p>
            <button>SCHEDULE A MEETING</button>
          </section>
        </form>
        <div id="result"></div>
        <script>
          document.querySelector('#real-submit').addEventListener('click', () => {
            document.querySelector('#result').textContent = 'Thank you. Your message has been sent.';
          });
        </script>`);
    case "/failed-click":
      return html(`
        <form>
          <h1>Contact us</h1>
          <input type="email" name="email">
          <textarea name="message"></textarea>
          <button type="submit" onmouseover="this.remove()">Send vanishing</button>
        </form>`);
    case "/failed-click-network-success":
      return html(`
        <form>
          <h1>Contact us</h1>
          <input type="email" name="email">
          <textarea name="message"></textarea>
          <button type="submit" onmouseover="fetch('/api/contact-no-ui', { method: 'POST', body: 'message=sent' }); this.remove()">Send vanishing</button>
        </form>`);
    case "/consent":
      return html(`
        <form><h1>Contact us</h1><input type="email" name="email"><textarea name="message"></textarea><label><input type="checkbox" required> I agree to the privacy policy</label><button>Send</button></form>
        <div id="result"></div>
        <script>document.querySelector('form').onsubmit = (event) => { event.preventDefault(); document.querySelector('#result').textContent = 'Thank you. Your message has been sent.'; };</script>`);
    case "/aria-required-select":
      return html(`
        <form>
          <h1>Contact us</h1>
          <input type="email" name="email">
          <textarea name="message"></textarea>
          <label>Topic
            <select aria-required="true">
              <option value="">Choose from list</option>
              <option value="Sales Inquiry">Sales Inquiry</option>
            </select>
          </label>
          <button>Send</button>
        </form>
        <div id="result"></div>
        <script>
          document.querySelector('form').onsubmit = (event) => {
            event.preventDefault();
            const select = document.querySelector('select');
            if (select.value) {
              document.querySelector('#result').textContent = 'Thank you. Your message has been sent.';
            }
          };
        </script>`);
    case "/unknown-required-text":
      return html(`
        <form>
          <h1>Contact us</h1>
          <input name="fullName" required>
          <input type="email" name="email" required>
          <textarea name="message" required></textarea>
          <label>Company <input name="company" required></label>
          <button type="submit">Send</button>
        </form>
        <div id="result"></div>
        <script>
          document.querySelector('form').onsubmit = (event) => {
            event.preventDefault();
            if (document.querySelector('[name=company]').value === 'Hello') {
              document.querySelector('#result').textContent = 'Thank you. Your message has been sent.';
            }
          };
        </script>`);
    case "/native-dropdown-fallback":
      return html(`
        <form>
          <h1>Contact us</h1>
          <input type="email" name="email" required>
          <textarea name="message" required></textarea>
          <label>Department
            <select name="department" required>
              <option value="">Choose</option>
              <option value="sales">Sales</option>
              <option value="support">Support</option>
            </select>
          </label>
          <button type="submit">Send</button>
        </form>
        <div id="result"></div>
        <script>
          document.querySelector('form').onsubmit = (event) => {
            event.preventDefault();
            if (document.querySelector('[name=department]').value === 'sales') {
              document.querySelector('#result').textContent = 'Thank you. Your message has been sent.';
            }
          };
        </script>`);
    case "/topic-placeholder-zero":
      return html(`
        <form>
          <h1>Contact us</h1>
          <input type="email" name="email" required>
          <textarea name="message" required></textarea>
          <label>Topic
            <select name="subject" required>
              <option value="0" disabled selected>Topic</option>
              <option value="Development">Development</option>
              <option value="CRM">CRM</option>
            </select>
          </label>
          <button type="submit">Send</button>
        </form>
        <div id="result"></div>
        <script>
          document.querySelector('form').onsubmit = (event) => {
            event.preventDefault();
            if (document.querySelector('[name=subject]').value === 'Development') {
              document.querySelector('#result').textContent = 'Thank you. Your message has been sent.';
            }
          };
        </script>`);
    case "/hidden-native-styled-dropdown":
      return html(`
        <form>
          <h1>Contact us</h1>
          <input type="email" name="email" required>
          <textarea name="message" required></textarea>
          <label class="styled-select-wrapper">Topic
            <select name="subject" required class="s-hidden">
              <option value="0" disabled selected>Topic</option>
              <option value="Development">Development</option>
              <option value="CRM">CRM</option>
            </select>
            <div class="styledSelect" tabindex="0">Topic</div>
            <ul class="options">
              <li style="display: none;">Topic</li>
              <li>Development</li>
              <li>CRM</li>
            </ul>
          </label>
          <button type="submit">Send</button>
        </form>
        <div id="result"></div>
        <style>
          .s-hidden { visibility: hidden; display: inline-block; width: 1px; height: 2px; }
          .styledSelect { border: 1px solid #777; padding: 6px; width: 220px; }
          .options { display: none; list-style: none; margin: 0; padding: 0; width: 220px; }
          .options li { padding: 6px; }
        </style>
        <script>
          const wrapper = document.querySelector('.styled-select-wrapper');
          const select = wrapper.querySelector('select');
          const display = wrapper.querySelector('.styledSelect');
          const options = wrapper.querySelector('.options');
          display.addEventListener('click', () => {
            options.style.display = 'block';
          });
          options.querySelectorAll('li').forEach((item) => {
            item.addEventListener('click', () => {
              const text = item.textContent.trim();
              if (text === 'Topic') {
                return;
              }
              select.value = text;
              select.dispatchEvent(new Event('change', { bubbles: true }));
              display.textContent = text;
              options.style.display = 'none';
            });
          });
          document.querySelector('form').onsubmit = (event) => {
            event.preventDefault();
            if (select.value === 'Development') {
              document.querySelector('#result').textContent = 'Thank you. Your message has been sent.';
            }
          };
        </script>`);
    case "/hidden-native-dropdown-no-companion":
      return html(`
        <form novalidate>
          <h1>Contact us</h1>
          <input type="email" name="email" required>
          <textarea name="message" required></textarea>
          <label>Topic
            <select name="subject" required class="s-hidden">
              <option value="0" disabled selected>Topic</option>
              <option value="Development">Development</option>
            </select>
          </label>
          <button type="submit">Send</button>
        </form>
        <div id="result"></div>
        <style>
          .s-hidden { visibility: hidden; display: inline-block; width: 1px; height: 2px; }
        </style>
        <script>
          document.querySelector('form').onsubmit = (event) => {
            event.preventDefault();
            document.querySelector('#result').textContent = 'Thank you. Your message has been sent.';
          };
        </script>`);
    case "/sentinel-dropdown-placeholder":
      return html(`
        <form>
          <h1>Contact us</h1>
          <input type="email" name="email" required>
          <textarea name="message" required></textarea>
          <label>Topic
            <select name="topic" required>
              <option value="-1">Please select topic</option>
              <option value="billing">Billing</option>
              <option value="support">Support</option>
            </select>
          </label>
          <button type="submit">Send</button>
        </form>
        <div id="result"></div>
        <script>
          document.querySelector('form').onsubmit = (event) => {
            event.preventDefault();
            if (document.querySelector('[name=topic]').value === 'billing') {
              document.querySelector('#result').textContent = 'Thank you. Your message has been sent.';
            }
          };
        </script>`);
    case "/custom-dropdown-unhandled":
      return html(`
        <form>
          <h1>Contact us</h1>
          <input type="email" name="email" required>
          <textarea name="message" required></textarea>
          <div role="combobox" aria-required="true" aria-label="Service">Choose service</div>
          <button type="submit">Send</button>
        </form>
        <div id="result"></div>
        <script>
          document.querySelector('form').onsubmit = (event) => {
            event.preventDefault();
            document.querySelector('#result').textContent = 'Thank you. Your message has been sent.';
          };
        </script>`);
    case "/checkbox-choice-fallback":
      return html(`
        <form>
          <h1>Contact us</h1>
          <input type="email" name="email" required>
          <textarea name="message" required></textarea>
          <div class="hs-form-field">
            <p>Sign me up to receive news, product updates, event information, and special offers.</p>
            <label><input type="checkbox" name="opt_in_marketing_updates" value="Yes"> Yes</label>
            <label><input type="checkbox" name="opt_in_marketing_updates" value="No"> No</label>
          </div>
          <button type="submit">Send</button>
        </form>
        <div id="result"></div>
        <script>
          document.querySelector('form').onsubmit = (event) => {
            event.preventDefault();
            const choices = document.querySelectorAll('[name=opt_in_marketing_updates]');
            if (choices[0].checked && !choices[1].checked) {
              document.querySelector('#result').textContent = 'Thank you. Your message has been sent.';
            }
          };
        </script>`);
    case "/round2-active-required-controls":
      return html(`
        <form id="round2-required-form">
          <h1>Contact us</h1>
          <label>Name <input name="fullName" required></label>
          <label>Email <input name="email" type="email" required></label>
          <label>Confirm email <input name="confirm_email" type="email" required></label>
          <label>Phone <input name="phone" type="tel" required></label>
          <label>Confirm phone <input name="confirm_phone" type="tel" required></label>
          <label>Message <textarea name="message" required></textarea></label>
          <label>Reference <input name="reference" minlength="10" maxlength="12" required></label>
          <label>Department
            <select name="department" required>
              <option value="">Choose department</option>
              <option value="sales">Sales</option>
              <option value="support">Support</option>
            </select>
          </label>
          <fieldset aria-required="true">
            <legend>Priority</legend>
            <label><input type="radio" name="priority" value="standard"> Standard</label>
            <label><input type="radio" name="priority" value="urgent"> Urgent</label>
          </fieldset>
          <label><input type="checkbox" name="required_updates" required> Receive required updates</label>
          <button type="submit">Send</button>
        </form>
        <div id="result"></div>
        <script>
          document.querySelector('#round2-required-form').onsubmit = (event) => {
            event.preventDefault();
            const form = event.currentTarget;
            const valid =
              form.confirm_email.value === 'test@example.com' &&
              form.confirm_phone.value === '050-0000000' &&
              form.reference.value.length >= 10 &&
              form.department.value === 'sales' &&
              form.priority.value === 'standard' &&
              form.required_updates.checked;
            if (valid) {
              document.querySelector('#result').textContent = 'Thank you. Your message has been sent.';
            }
          };
        </script>`);
    case "/round2-aria-required-widgets":
      return html(`
        <form id="round2-aria-form">
          <h1>Contact us</h1>
          <input name="email" type="email" required>
          <textarea name="message" required></textarea>
          <div id="service-combobox" role="combobox" aria-required="true" aria-controls="service-options" aria-expanded="false">Choose service</div>
          <div id="service-options" role="listbox" hidden>
            <div role="option" aria-selected="false">Consulting</div>
            <div role="option" aria-selected="false">Support</div>
          </div>
          <div id="contact-method" role="radiogroup" aria-required="true" aria-label="Contact method">
            <button type="button" role="radio" aria-checked="false">Email</button>
            <button type="button" role="radio" aria-checked="false">Phone</button>
          </div>
          <div id="required-consent" role="checkbox" aria-required="true" aria-checked="false">I agree</div>
          <button type="submit">Send</button>
        </form>
        <div id="result"></div>
        <script>
          const combo = document.querySelector('#service-combobox');
          const options = document.querySelector('#service-options');
          combo.onclick = () => {
            options.hidden = false;
            combo.setAttribute('aria-expanded', 'true');
          };
          options.querySelectorAll('[role=option]').forEach((option) => {
            option.onclick = () => {
              option.setAttribute('aria-selected', 'true');
              combo.textContent = option.textContent;
              combo.setAttribute('aria-expanded', 'false');
              options.hidden = true;
            };
          });
          document.querySelectorAll('#contact-method [role=radio]').forEach((radio) => {
            radio.onclick = () => radio.setAttribute('aria-checked', 'true');
          });
          const consent = document.querySelector('#required-consent');
          consent.onclick = () => consent.setAttribute('aria-checked', 'true');
          document.querySelector('#round2-aria-form').onsubmit = (event) => {
            event.preventDefault();
            const complete =
              combo.textContent === 'Consulting' &&
              document.querySelector('#contact-method [aria-checked=true]') &&
              consent.getAttribute('aria-checked') === 'true';
            if (complete) {
              document.querySelector('#result').textContent = 'Thank you. Your message has been sent.';
            }
          };
        </script>`);
    case "/round2-hidden-conditional":
      return html(`
        <form id="round2-hidden-form">
          <h1>Contact us</h1>
          <input name="email" type="email" required>
          <textarea name="message" required></textarea>
          <section hidden>
            <label>Other topic <input name="inactive_other_topic" required></label>
          </section>
          <button type="submit">Send</button>
        </form>
        <div id="result"></div>
        <script>
          document.querySelector('#round2-hidden-form').onsubmit = (event) => {
            event.preventDefault();
            const form = event.currentTarget;
            const data = new FormData(form);
            const conditional = form.elements.inactive_other_topic;
            if (!data.has('inactive_other_topic') && conditional.disabled) {
              document.querySelector('#result').textContent = 'Thank you. Your message has been sent.';
            }
          };
        </script>`);
    case "/confirm-step":
      return html(`
        <form id="contact-form">
          <h1>Contact us</h1>
          <input name="email" type="email">
          <textarea name="message"></textarea>
          <button>Send</button>
        </form>
        <div id="result"></div>
        <script>
          document.querySelector('form').onsubmit = (event) => {
            event.preventDefault();
            document.querySelector('#contact-form').hidden = true;
            document.querySelector('#result').innerHTML = '<form id="confirm-form"><button name="s" type="submit" class="button-primary confirm" value="">CONFIRM→</button></form>';
            document.querySelector('#confirm-form').onsubmit = (confirmEvent) => {
              confirmEvent.preventDefault();
              document.querySelector('#result').textContent = 'Thank you. Your message has been sent.';
            };
          };
        </script>`);
    case "/captcha":
      return html(`
        <form><h1>Contact us</h1><input type="email" name="email"><textarea name="message"></textarea><div class="g-recaptcha" style="width:20px;height:20px"></div><button>Send</button></form>
        <div id="result"></div>
        <script>document.querySelector('form').onsubmit = (event) => { event.preventDefault(); document.querySelector('#result').textContent = 'Your message has been sent.'; };</script>`);
    case "/cookie-overlay":
      return html(`
        <form><h1>Contact us</h1><input type="email" name="email"><textarea name="message"></textarea><button>Send</button></form>
        <div id="result"></div>
        <div id="cookie-consent" role="dialog" aria-modal="true" style="position:fixed;inset:0;z-index:9999;background:white">
          <p>We use cookies for tracking and privacy preferences.</p>
          <button id="accept-cookies" type="button">Accept all</button>
          <button id="reject-cookies" type="button">Reject non-essential cookies</button>
        </div>
        <script>
          document.querySelector('#reject-cookies').onclick = () => document.querySelector('#cookie-consent').remove();
          document.querySelector('#accept-cookies').onclick = () => document.querySelector('#cookie-consent').remove();
          document.querySelector('form').onsubmit = (event) => { event.preventDefault(); document.querySelector('#result').textContent = 'Your message has been sent.'; };
        </script>`);
    case "/round3-onetrust-overlay":
      return html(`
        <form><h1>Contact us</h1><input type="email" name="email"><textarea name="message"></textarea><button>Send</button></form>
        <div id="result"></div>
        <div id="onetrust-banner-sdk" style="position:fixed;inset:0;z-index:9999;background:white">
          <p>Cookie privacy consent</p>
          <button id="onetrust-accept-btn-handler" type="button">Accept All Cookies</button>
          <button id="onetrust-reject-all-handler" type="button">Reject All</button>
        </div>
        <script>
          document.querySelector('#onetrust-reject-all-handler').onclick = () => document.querySelector('#onetrust-banner-sdk').remove();
          document.querySelector('#onetrust-accept-btn-handler').onclick = () => document.querySelector('#onetrust-banner-sdk').remove();
          document.querySelector('form').onsubmit = (event) => { event.preventDefault(); document.querySelector('#result').textContent = 'Your message has been sent.'; };
        </script>`);
    case "/captcha-blocked":
      return html(`
        <form><h1>Contact us</h1><input type="email" name="email"><textarea name="message"></textarea><div class="g-recaptcha" style="width:20px;height:20px"></div><button>Send</button></form>
        <div id="result"></div>
        <script>document.querySelector('form').onsubmit = (event) => { event.preventDefault(); document.querySelector('#result').innerHTML = '<div role="alert">Please complete CAPTCHA verification.</div>'; };</script>`);
    case "/captcha-disabled":
      return html(`
        <form><h1>Contact us</h1><input type="email" name="email"><textarea name="message"></textarea><div class="g-recaptcha" style="width:20px;height:20px"></div><button disabled>Send</button></form>`);
    case "/captcha-network-rejected":
      return html(`
        <form action="/api/captcha-reject" method="post"><h1>Contact us</h1><input type="email" name="email"><textarea name="message"></textarea><input type="hidden" name="g-recaptcha-response" value=""><div class="g-recaptcha" style="width:20px;height:20px"></div><button>Send</button></form>`);
    case "/validation":
      return html(`
        <form>
          <h1>Contact us</h1>
          <input type="email" name="email">
          <textarea name="message"></textarea>
          <label>Topic <select required><option value="">Choose</option></select></label>
          <button type="submit" onclick="fetch('/api/should-not-click', { method: 'POST' })">Send</button>
        </form>`);
    case "/pre-submit-recovery":
      return html(`
        <form id="contact">
          <h1>Contact us</h1>
          <input type="email" name="email" required>
          <textarea name="message" required></textarea>
          <div style="height:1800px"></div>
          <button id="send" type="submit">Send</button>
        </form>
        <div id="result"></div>
        <script>
          const form = document.querySelector('#contact');
          const send = document.querySelector('#send');
          const observer = new IntersectionObserver((entries) => {
            if (!entries.some((entry) => entry.isIntersecting) ||
                document.querySelector('[name=late_topic]')) return;
            send.insertAdjacentHTML(
              'beforebegin',
              '<label>Topic <select name="late_topic" required><option value="">Choose</option><option value="sales">Sales</option></select></label>'
            );
          }, { threshold: 0.5 });
          observer.observe(send);
          form.onsubmit = (event) => {
            event.preventDefault();
            if (document.querySelector('[name=late_topic]').value === 'sales') {
              document.querySelector('#result').textContent =
                'Thank you. Your message has been sent.';
            }
          };
        </script>`);
    case "/novalidate":
      return html(`
        <form novalidate>
          <h1>Contact us</h1>
          <input type="email" name="email">
          <textarea name="message"></textarea>
          <select required><option value="">Choose</option></select>
          <button type="submit">Send</button>
        </form>
        <div id="result"></div>
        <script>document.querySelector('form').onsubmit = (event) => {
          event.preventDefault();
          document.querySelector('#result').textContent = 'Thank you. Your message has been sent.';
        };</script>`);
    case "/formnovalidate":
      return html(`
        <form>
          <h1>Contact us</h1>
          <input type="email" name="email">
          <textarea name="message"></textarea>
          <select required><option value="">Choose</option></select>
          <button type="submit" formnovalidate>Send</button>
        </form>
        <div id="result"></div>
        <script>document.querySelector('form').onsubmit = (event) => {
          event.preventDefault();
          document.querySelector('#result').textContent = 'Thank you. Your message has been sent.';
        };</script>`);
    case "/custom-button-invalid-native-control":
      return html(`
        <form>
          <h1>Contact us</h1>
          <input type="email" name="email">
          <textarea name="message"></textarea>
          <select required><option value="">Choose</option></select>
          <button id="send" type="button">Send</button>
        </form>
        <div id="result"></div>
        <script>document.querySelector('#send').onclick = () => {
          document.querySelector('#result').textContent = 'Thank you. Your message has been sent.';
        };</script>`);
    case "/non-form-invalid-native-control":
      return html(`
        <section id="contact">
          <h1>Contact us</h1>
          <input type="email" name="email">
          <textarea name="message"></textarea>
          <select required><option value="">Choose</option></select>
          <button id="send" type="button">Send</button>
        </section>
        <div id="result"></div>
        <script>document.querySelector('#send').onclick = () => {
          document.querySelector('#result').textContent = 'Thank you. Your message has been sent.';
        };</script>`);
    case "/form-like-no-form":
      return html(form_like_container());
    case "/weak-container-fallback":
      return html(`
        <div><h1>Search</h1><input><button>Search</button></div>
        ${contactForm}`);
    default:
      return html("<h1>Welcome</h1><p>There is no contact information here.</p>");
  }
}

function multi_step_contact_form(progression_steps: number): string {
  const steps = Array.from({ length: progression_steps }, (_, index) => {
    const field = index === 0
      ? '<label>Email <input type="email" name="email"></label>'
      : index === 1
        ? '<label>Name <input name="name"></label>'
        : `<label>Company <input name="company-${index}"></label>`;
    const label = index === 0 ? "Next" : "Continue";
    return `<section data-step="${index}"${index === 0 ? "" : " hidden"}>${field}<button type="button" data-progress>${label}</button></section>`;
  }).join("");
  const final_step = `
    <section data-step="${progression_steps}" hidden>
      <label>Message <textarea name="message"></textarea></label>
      <button type="submit">Send</button>
    </section>`;

  return `
    <form>
      <h1>Contact our project team</h1>
      ${steps}
      ${final_step}
    </form>
    <div id="result"></div>
    <script>
      const steps = [...document.querySelectorAll('[data-step]')];
      document.querySelectorAll('[data-progress]').forEach((button, index) => {
        button.addEventListener('click', () => {
          steps[index].hidden = true;
          steps[index + 1].hidden = false;
        });
      });
      document.querySelector('form').addEventListener('submit', (event) => {
        event.preventDefault();
        document.querySelector('#result').textContent = 'Thank you. Your message has been sent.';
      });
    </script>`;
}

function search_widget_contact_form(): string {
  return `
    <form id="contact-form">
      <h1>Contact us</h1>
      <label>Full name <input name="fullName" required></label>
      <label>Email <input name="email" type="email" required></label>
      <div>
        <label>Country <input name="search" autocomplete="off" placeholder="Search countries"></label>
        <label>Phone <input name="phone" type="tel"></label>
      </div>
      <label>Message <textarea name="message" required></textarea></label>
      <button type="submit">Send message</button>
    </form>
    <div id="result"></div>
    <script>
      document.querySelector('form').addEventListener('submit', (event) => {
        event.preventDefault();
        event.target.hidden = true;
        document.querySelector('#result').textContent = 'Thank you. Your message has been sent.';
      });
    </script>`;
}

function anchor_submit_contact_form(): string {
  return `
    <form id="contact-form">
      <h1>Contact us</h1>
      <label>Full name <input name="fullName" required></label>
      <label>Email <input name="email" type="email" required></label>
      <label>Phone <input name="phone" type="tel"></label>
      <label>Message <textarea name="message" required></textarea></label>
      <a id="submit" href="#">Submit</a>
    </form>
    <div id="result"></div>
    <script>
      document.querySelector('#submit').addEventListener('click', (event) => {
        event.preventDefault();
        document.querySelector('#contact-form').hidden = true;
        document.querySelector('#result').textContent = 'Thank you. Your message has been sent.';
      });
    </script>`;
}

function network_only_contact_form(endpoint: string): string {
  return `
    <form id="contact-form">
      <h1>Contact us</h1>
      <label>Full name <input name="fullName" required></label>
      <label>Email <input name="email" type="email" required></label>
      <label>Phone <input name="phone" type="tel"></label>
      <label>Message <textarea name="message" required></textarea></label>
      <button type="submit">Send</button>
    </form>
    <script>
      document.querySelector('form').addEventListener('submit', async (event) => {
        event.preventDefault();
        await fetch(${JSON.stringify(endpoint)}, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name: document.querySelector('[name=fullName]').value,
            email: document.querySelector('[name=email]').value,
            phone: document.querySelector('[name=phone]').value,
            message: document.querySelector('[name=message]').value,
          }),
        });
      });
    </script>`;
}

function delayed_spa_contact_page(): string {
  const delayed_contact_form = `
    <form id="contact-form">
      <h1>Contact us</h1>
      <label>Full name <input name="fullName" required></label>
      <label>Email <input name="email" type="email" required></label>
      <label>Phone <input name="phone" type="tel"></label>
      <label>Message <textarea name="message" required></textarea></label>
      <button type="submit">Send message</button>
    </form>
    <div id="result"></div>`;

  return html(`
    <main id="app"></main>
    <script>
      setTimeout(() => {
        document.querySelector('#app').innerHTML = ${JSON.stringify(delayed_contact_form)};
        document.querySelector('form').addEventListener('submit', (event) => {
          event.preventDefault();
          event.target.hidden = true;
          document.querySelector('#result').textContent = 'Thank you. Your message has been sent.';
        });
      }, 1000);
    </script>`);
}

function form_like_container(): string {
  return `
    <section id="contact-panel">
      <h1>Contact us</h1>
      <input data-contact-field="name">
      <input data-contact-field="email">
      <textarea data-contact-field="message"></textarea>
      <button type="button" data-contact-submit="send">Send</button>
    </section>
    <div id="result"></div>
    <script>
      document.querySelector('[data-contact-submit="send"]').addEventListener('click', () => {
        document.querySelector('#result').textContent = 'Your message has been sent';
      });
    </script>`;
}

function restore_env_value(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function html(body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>POC fixture</title></head><body>${body}</body></html>`;
}
