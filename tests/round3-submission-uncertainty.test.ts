import assert from "node:assert/strict";
import test from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import type {
  NetworkDebugRecord,
  NetworkSubmissionEvidenceSummary,
  SubmissionRejectionEvidence,
} from "../src/contact_outreach_workflow/contact_channels/forms/shared_files_forms/forms_types_(Support).js";
import { dismiss_cookie_obstructions } from "../src/contact_outreach_workflow/shared_files_orchestrator/page_obstructions_(Deterministic).js";
import { assess_authoritative_submission_evidence } from "../src/contact_outreach_workflow/contact_channels/forms/pipeline/C_submission/C10_submission_evidence_assessment_(Deterministic).js";
import {
  classify_new_submission_messages,
  has_visible_success_message,
} from "../src/contact_outreach_workflow/contact_channels/forms/pipeline/C_submission/C6_submission_confirmation_(Deterministic).js";
import { analyze_network_submission_evidence } from "../src/contact_outreach_workflow/contact_channels/forms/pipeline/C_submission/C7_network_submission_evidence_(Deterministic).js";
import { submission_signal_rulebook } from "../src/contact_outreach_workflow/contact_channels/forms/shared_files_forms/submission_signal_rulebook_(Support).js";
import { score_submission_signals } from "../src/contact_outreach_workflow/contact_channels/forms/shared_files_forms/submission_signal_scoring_(Deterministic).js";

const click_timestamp = "2026-07-23T12:00:00.000Z";

test("Round 3 recognizes only bounded provider submission evidence", () => {
  const oscar = analyze_network_submission_evidence(
    [
      network_record(
        "https://v3.oscar-campus.com/isep/forms",
        200,
        "xhr",
      ),
    ],
    click_timestamp,
    { pageUrlBeforeSubmission: "https://www.isep.fr/contact/" },
  );
  assert.equal(oscar.confirmsSubmission, true);
  assert.equal(oscar.providerRuleId, "oscar-campus-form-submit");

  const formsite = analyze_network_submission_evidence(
    [
      network_record(
        "https://fs27.formsite.com/res/submit;jsessionid=fixture",
        200,
        "document",
      ),
    ],
    click_timestamp,
    { pageUrlBeforeSubmission: "https://example.edu/contact/" },
  );
  assert.equal(formsite.confirmsSubmission, true);
  assert.equal(formsite.providerRuleId, "formsite-form-submit");

  const formstack_success = analyze_network_submission_evidence(
    [
      network_record(
        "https://example.formstack.com/forms/index.php",
        200,
        "document",
      ),
    ],
    click_timestamp,
    { pageUrlBeforeSubmission: "https://example.edu/contact/" },
  );
  assert.equal(formstack_success.confirmsSubmission, false);

  const formstack_rejection = analyze_network_submission_evidence(
    [
      network_record(
        "https://example.formstack.com/forms/index.php",
        400,
        "document",
      ),
    ],
    click_timestamp,
    { pageUrlBeforeSubmission: "https://example.edu/contact/" },
  );
  assert.equal(formstack_rejection.rejectsSubmission, true);
  assert.equal(formstack_rejection.rejectionCategory, "server");
  assert.equal(formstack_rejection.providerRuleId, "formstack-rejection-only");

  const telemetry = analyze_network_submission_evidence(
    [
      network_record(
        "https://forms.hscollectedforms.net/collected-forms/submit/form",
        204,
        "xhr",
      ),
    ],
    click_timestamp,
    { pageUrlBeforeSubmission: "https://example.edu/contact/" },
  );
  assert.equal(telemetry.confirmsSubmission, false);
  assert.equal(telemetry.rejectsSubmission, false);
  assert.match(telemetry.reason, /tracking|analytics/i);
});

test("Round 3 classifies rejection and contradiction authoritatively", () => {
  const rejection = visible_rejection("validation");
  const rejected = assess_authoritative_submission_evidence({
    visibleEvidence: {
      confirmationEvidence: "none",
      rejectionEvidence: [rejection],
      newMessages: [],
    },
    networkEvidence: no_network_evidence(),
    captchaBlocked: false,
  });
  assert.equal(rejected.disposition, "rejected");
  assert.equal(rejected.failureKind, "submission.rejected");
  assert.equal(rejected.signalScore.displayResult, "Failure -3");

  const contradictory = assess_authoritative_submission_evidence({
    visibleEvidence: {
      confirmationEvidence: "none",
      rejectionEvidence: [rejection],
      newMessages: [],
    },
    networkEvidence: {
      ...no_network_evidence(),
      found: true,
      confirmsSubmission: true,
      confidence: "strong",
      bestRequest: {
        method: "POST", status: 200, url: "https://site.test/submit", resourceType: "xhr",
      },
    },
    captchaBlocked: false,
  });
  assert.equal(contradictory.disposition, "contradictory");
  assert.equal(contradictory.failureKind, "submission.contradictory");
  assert.equal(contradictory.confirmed, false);
  assert.equal(contradictory.signalScore.totalScore, -2);

  const captcha = assess_authoritative_submission_evidence({
    visibleEvidence: {
      confirmationEvidence: "none",
      rejectionEvidence: [visible_rejection("captcha")],
      newMessages: [],
    },
    networkEvidence: no_network_evidence(),
    captchaBlocked: false,
  });
  assert.equal(captcha.disposition, "captchaBlocked");
  assert.equal(captcha.failureKind, "submission.captcha");

  const positive_with_captcha_rejection =
    assess_authoritative_submission_evidence({
      visibleEvidence: {
        confirmationEvidence: "successText",
        rejectionEvidence: [visible_rejection("captcha")],
        newMessages: [],
      },
      networkEvidence: no_network_evidence(),
      captchaBlocked: true,
    });
  assert.equal(
    positive_with_captcha_rejection.disposition,
    "contradictory",
  );
  assert.equal(
    positive_with_captcha_rejection.failureKind,
    "submission.contradictory",
  );
});

test("submission assessment reports bounded unknown candidates and excludes neutral network traffic", () => {
  const assessed = assess_authoritative_submission_evidence({
    visibleEvidence: {
      confirmationEvidence: "none",
      rejectionEvidence: [],
      newMessages: [{ selector: "#notice", frameUrl: "https://site.test/contact", text: "Reference SECRET-42 recorded" }],
    },
    networkEvidence: no_network_evidence(),
    captchaBlocked: false,
    urlBeforeSubmission: "https://site.test/contact?token=secret",
    urlAfterSubmission: "https://site.test/received?id=123",
    redactionValues: ["SECRET-42"],
  });
  assert.equal(assessed.signalScore.displayResult, "Inconclusive");
  assert.deepEqual(assessed.unknownSignals.map((item) => item.kind), ["message", "url"]);
  assert.equal(JSON.stringify(assessed.unknownSignals).includes("SECRET-42"), false);
  assert.equal(JSON.stringify(assessed.unknownSignals).includes("id=123"), false);

  const neutral = assess_authoritative_submission_evidence({
    visibleEvidence: { confirmationEvidence: "none", rejectionEvidence: [], newMessages: [] },
    networkEvidence: { ...no_network_evidence(), found: true, confidence: "medium" },
    captchaBlocked: false,
  });
  assert.equal(neutral.unknownSignals.length, 0);
});

test("submission signal rulebook is compact, typed, and arithmetically executable", () => {
  assert.equal(submission_signal_rulebook.signals.length, 10);
  assert.deepEqual(
    submission_signal_rulebook.signals.map((signal) => signal.id),
    [
      "visible_success_text",
      "success_url",
      "ai_verified_visible_success",
      "network_confirmation",
      "validation_rejection",
      "captcha_rejection",
      "captcha_blocked",
      "server_rejection",
      "generic_rejection",
      "network_rejection",
    ],
  );

  const success = score_submission_signals({
    visibleEvidence: {
      confirmationEvidence: "successText",
      rejectionEvidence: [],
    },
    networkEvidence: {
      found: true,
      confirmsSubmission: true,
      rejectsSubmission: false,
      confidence: "strong",
      summary: "provider confirmation",
      reason: "fixture",
      providerRuleId: "formsite-form-submit",
      bestRequest: {
        method: "POST",
        status: 200,
        url: "https://forms.test/submit",
        resourceType: "xhr",
      },
    },
    captchaBlocked: false,
  });
  assert.equal(success.totalScore, 5);
  assert.equal(success.classification, "success");
  assert.equal(success.displayResult, "Success 5");
  assert.deepEqual(
    success.ledger.filter((entry) => entry.retained).map((entry) => entry.score),
    [3, 2],
  );

  const failure = score_submission_signals({
    visibleEvidence: {
      confirmationEvidence: "none",
      rejectionEvidence: [visible_rejection("validation")],
    },
    networkEvidence: {
      found: true,
      confirmsSubmission: false,
      rejectsSubmission: true,
      confidence: "strong",
      summary: "network rejection",
      reason: "fixture",
      bestRejectionRequest: {
        method: "POST",
        status: 403,
        url: "https://forms.test/submit",
        resourceType: "xhr",
      },
    },
    captchaBlocked: false,
  });
  assert.equal(failure.totalScore, -5);
  assert.equal(failure.displayResult, "Failure -5");

  const balanced = score_submission_signals({
    visibleEvidence: {
      confirmationEvidence: "successText",
      rejectionEvidence: [visible_rejection("validation")],
    },
    networkEvidence: no_network_evidence(),
    captchaBlocked: false,
  });
  assert.equal(balanced.totalScore, 0);
  assert.equal(balanced.classification, "inconclusive");
  assert.equal(balanced.displayResult, "Inconclusive");
  assert.equal(balanced.hasBothPolarities, true);
});

test("submission signal scoring suppresses duplicate evidence families", () => {
  const result = score_submission_signals({
    visibleEvidence: {
      confirmationEvidence: "successText",
      rejectionEvidence: [visible_rejection("captcha")],
    },
    stagehandEvidence: "aiVisibleText",
    networkEvidence: no_network_evidence(),
    captchaBlocked: true,
  });
  assert.equal(result.totalScore, 0);
  assert.equal(result.hasBothPolarities, true);
  assert.deepEqual(
    result.ledger.filter((entry) => entry.retained).map((entry) => entry.signalId),
    ["visible_success_text", "captcha_rejection"],
  );
  assert.deepEqual(
    result.ledger.filter((entry) => !entry.retained).map((entry) => entry.signalId),
    ["ai_verified_visible_success", "captcha_blocked"],
  );
});

test("Round 3 classifies only explicit new messages and redacts excerpts", () => {
  const evidence = classify_new_submission_messages(
    [
      {
        selector: '[role="alert"]',
        frameUrl: "https://fixture.test/contact",
        text: "Email test.user@example.com is required. Please complete this required field.",
      },
      {
        selector: ".notification",
        frameUrl: "https://fixture.test/contact",
        text: "32768 characters remaining",
      },
    ],
    ["test.user@example.com"],
  );
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0]?.category, "validation");
  assert.doesNotMatch(evidence[0]?.excerpt ?? "", /test\.user@example\.com/);
  assert.match(evidence[0]?.excerpt ?? "", /\[redacted-contact-value\]/);
});

test("Round 3 recognizes the evidenced French success phrase", async () => {
  await with_page(async (page) => {
    await page.setContent(
      `<div role="status">L'enregistrement a été effectué avec succès</div>`,
    );
    assert.equal(await has_visible_success_message(page), true);
  });
});

test("Round 3 dismisses supported CMP families with privacy-first actions", async () => {
  const fixtures = [
    {
      vendor: "oneTrust",
      container: 'id="onetrust-banner-sdk"',
      control: 'id="onetrust-reject-all-handler"',
      label: "Reject All",
    },
    {
      vendor: "tarteaucitron",
      container: 'id="tarteaucitronAlertBig"',
      control: 'id="tarteaucitronAllDenied2"',
      label: "Refuser tout",
    },
    {
      vendor: "cookiebot",
      container: 'id="CybotCookiebotDialog"',
      control: 'id="CybotCookiebotDialogBodyButtonDecline"',
      label: "Alles ablehnen",
    },
    {
      vendor: "ccm19",
      container: 'class="ccm-modal"',
      control: 'class="ccm--decline-cookies"',
      label: "Nur Notwendige",
    },
    {
      vendor: "cookieYes",
      container: 'class="cky-consent-container"',
      control: 'class="cky-btn-reject"',
      label: "Rechazar",
    },
    {
      vendor: "drupal",
      container: 'id="sliding-popup"',
      control: 'class="decline-button"',
      label: "Recusar",
    },
  ] as const;

  await with_page(async (page) => {
    for (const fixture of fixtures) {
      await page.setContent(cmp_fixture(fixture.container, fixture.control, fixture.label));
      const actions = await dismiss_cookie_obstructions(
        page,
        page.locator("#submit"),
      );
      assert.equal(actions.length, 1, fixture.vendor);
      assert.equal(actions[0]?.action, "reject", fixture.vendor);
      assert.equal(actions[0]?.cleared, true, fixture.vendor);
    }
  });
});

test("Round 3 pierces an open Usercentrics shadow root", async () => {
  await with_page(async (page) => {
    await page.setContent(`
      <button id="submit" style="position:fixed;left:40px;top:40px">Send</button>
      <div id="usercentrics-root" style="position:fixed;inset:0;z-index:10"></div>
      <script>
        const host = document.querySelector('#usercentrics-root');
        const root = host.attachShadow({mode: 'open'});
        root.innerHTML = '<button data-testid="uc-deny-all-button">Alles ablehnen</button>';
        root.querySelector('button').onclick = () => host.remove();
      </script>
    `);
    const actions = await dismiss_cookie_obstructions(
      page,
      page.locator("#submit"),
    );
    assert.equal(actions.length, 1);
    assert.equal(actions[0]?.vendor, "usercentrics");
    assert.equal(actions[0]?.cleared, true);
  });
});

test("Round 3 uses Accept last and never dismisses a non-cookie overlay", async () => {
  await with_page(async (page) => {
    await page.setContent(
      cmp_fixture(
        'role="dialog" aria-modal="true"',
        'id="accept-only"',
        "Accept all cookies",
      ),
    );
    const accepted = await dismiss_cookie_obstructions(
      page,
      page.locator("#submit"),
    );
    assert.equal(accepted[0]?.action, "accept");
    assert.equal(accepted[0]?.cleared, true);

    await page.setContent(`
      <button id="submit" style="position:fixed;left:40px;top:40px">Send</button>
      <div id="video-overlay" role="dialog" aria-modal="true"
           style="position:fixed;inset:0;z-index:10">
        <button onclick="this.parentElement.remove()">Play full video</button>
      </div>
    `);
    const untouched = await dismiss_cookie_obstructions(
      page,
      page.locator("#submit"),
    );
    assert.deepEqual(untouched, []);
    assert.equal(await page.locator("#video-overlay").isVisible(), true);
  });
});

test("Round 3 enforces the three-action consent budget", async () => {
  await with_page(async (page) => {
    await page.setContent(`
      <button id="submit" style="position:fixed;left:40px;top:40px">Send</button>
      <div id="onetrust-banner-sdk" style="position:fixed;inset:0;z-index:10">
        <button id="onetrust-reject-all-handler">Reject All</button>
      </div>
    `);
    const actions = await dismiss_cookie_obstructions(
      page,
      page.locator("#submit"),
    );
    assert.equal(actions.length, 3);
    assert.equal(actions.every((action) => action.cleared === false), true);
    assert.equal(await page.locator("#onetrust-banner-sdk").isVisible(), true);
  });
});

function network_record(
  url: string,
  status: number,
  resource_type: string,
): NetworkDebugRecord {
  return {
    id: 1,
    method: "POST",
    url,
    resourceType: resource_type,
    startedAt: "2026-07-23T12:00:00.100Z",
    status,
    postDataPreview:
      '{"encoding":"form","fields":[{"name":"email","kind":"string","length":18}]}',
  };
}

function no_network_evidence(): NetworkSubmissionEvidenceSummary {
  return {
    found: false,
    confirmsSubmission: false,
    rejectsSubmission: false,
    confidence: "none",
    summary: "no network submission evidence",
    reason: "none",
  };
}

function visible_rejection(
  category: SubmissionRejectionEvidence["category"],
): SubmissionRejectionEvidence {
  return {
    source: "visibleMessage",
    category,
    patternId: `fixture-${category}`,
    confidence: "strong",
  };
}

function cmp_fixture(
  container_attributes: string,
  control_attributes: string,
  label: string,
): string {
  return `
    <button id="submit" style="position:fixed;left:40px;top:40px">Send</button>
    <div ${container_attributes} style="position:fixed;inset:0;z-index:10">
      <p>Cookie privacy consent</p>
      <button ${control_attributes} onclick="this.parentElement.remove()">${label}</button>
    </div>
  `;
}

async function with_page(action: (page: Page) => Promise<void>): Promise<void> {
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await action(page);
  } finally {
    await browser?.close();
  }
}
