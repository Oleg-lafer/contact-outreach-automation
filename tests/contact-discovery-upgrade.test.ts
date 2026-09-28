import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import type { ContactRequest } from "../src/contact_outreach_workflow/contact_channels/forms/shared_files_forms/forms_types_(Support).js";
import { ContactRouteScanTimeoutError, discover_contact_routes } from "../src/contact_outreach_workflow/orchestrator/C_contact_routes/C1_contact_route_discovery_(Integration).js";
import type { DeepDebugContext, DeepDebugEventInput } from "../src/contact_outreach_workflow/shared_files_orchestrator/deep_debug_types_(Support).js";
import { run_contact_outreach_core } from "../src/contact_outreach_workflow/orchestrator/contact_outreach_core_(Integration).js";
import { score_contact_route } from "../src/contact_outreach_workflow/orchestrator/C_contact_routes/C2_contact_route_scoring_(Deterministic).js";
import { discover_contact_form } from "../src/contact_outreach_workflow/contact_channels/forms/pipeline/A_discovery/A1_contact_form_discovery_(Integration).js";
import { populate_contact_form } from "../src/contact_outreach_workflow/contact_channels/forms/pipeline/B_population/B1_contact_form_population_(Integration).js";
import { find_submit_control } from "../src/contact_outreach_workflow/contact_channels/forms/pipeline/C_submission/C3_submit_control_selection_(Deterministic).js";
import { assess_contact_form } from "../src/contact_outreach_workflow/contact_channels/forms/shared_files_forms/contact_form_intent_(Deterministic).js";

const CONTACT_REQUEST: ContactRequest = {
  websiteUrl: "http://local.test/",
  name: "Test Person",
  email: "test@example.com",
  phone: "555-0100",
  message: "Fixture inquiry",
};
let browser: Browser;

test.before(async () => {
  browser = await chromium.launch({ headless: true });
});

test.after(async () => {
  await browser.close();
});

test("form discovery excerpts do not split an emoji at the 500-code-unit limit", async () => {
  await with_local_page(
    `<main><form id="x"><p>Contact ${"a".repeat(489)}😀</p>` +
      `<input type="email"><textarea></textarea><button>Send</button></form></main>`,
    async (page) => {
      const assessment = await assess_contact_form(page.locator("form"));
      assert.ok(assessment.diagnostics, assessment.reason);
      const excerpt = assessment.diagnostics?.contextExcerpt;
      assert.equal(excerpt?.length, 499);
      assert.ok(excerpt?.endsWith("a"));
      assert.doesNotMatch(excerpt ?? "", /[\uD800-\uDBFF]$/);
    },
  );
});

test("expanded inquiry route phrases share one contact-intent classifier", () => {
  const phrases = [
    "Contact",
    "Book a Call",
    "Book a Meeting",
    "Schedule a Demo",
    "Talk to Sales",
    "Consultation",
    "Start a Project",
    "Work With Us",
    "Request a Quote",
    "Free Audit",
    "Let's Talk",
    "New Business Inquiry",
  ];
  for (const phrase of phrases) {
    assert.ok(score_contact_route(phrase) > 0, phrase);
  }
});

test("Hebrew inquiry routes are recognized without broad Hebrew false positives", () => {
  for (const phrase of [
    "צור קשר",
    "דברו איתנו",
    "השאירו פרטים",
    "בקשת הצעת מחיר",
    "קבעו פגישה",
  ]) {
    assert.ok(score_contact_route(phrase) > 0, phrase);
  }
  assert.equal(score_contact_route("קשרי משקיעים"), 0);
  assert.equal(score_contact_route("חדשות החברה"), 0);
  assert.ok(
    score_contact_route("/%D7%A6%D7%95%D7%A8-%D7%A7%D7%A9%D7%A8") > 0,
  );
  assert.ok(score_contact_route("/tzor-kesher") > 0);
  assert.ok(score_contact_route("\u200fצ\u05b9ור קשר") > 0);
});

test("macro route discovery decodes and ranks Hebrew URL paths", async () => {
  await with_local_page(
    `<nav>
       <a href="/%D7%A6%D7%95%D7%A8-%D7%A7%D7%A9%D7%A8">צור קשר</a>
       <a href="/investors">קשרי משקיעים</a>
       <a href="/news">חדשות</a>
     </nav>`,
    async (page) => {
      const result = await discover_contact_routes(page);
      assert.deepEqual(
        result.candidates.map((candidate) => new URL(candidate.url).pathname),
        ["/%D7%A6%D7%95%D7%A8-%D7%A7%D7%A9%D7%A8"],
      );
    },
  );
});

test("macro route discovery times out a hung frame and records focused diagnostics", async () => {
  const events: DeepDebugEventInput[] = [];
  const frame = {
    url: () => "https://hung.example.test/frame",
    locator: () => ({ evaluateAll: () => new Promise<never>(() => undefined) }),
  };
  const page = {
    url: () => "https://hung.example.test/",
    frames: () => [frame],
  } as unknown as Page;
  const deepDebug = { record: (event: DeepDebugEventInput) => events.push(event) } as unknown as DeepDebugContext;
  const started = Date.now();

  await assert.rejects(
    discover_contact_routes(page, { timeoutMs: 30, deepDebug }),
    (error: unknown) => {
      assert.ok(error instanceof ContactRouteScanTimeoutError);
      assert.equal(error.activeFrameUrl, "https://hung.example.test/frame");
      assert.equal(error.completedFrames, 0);
      return true;
    },
  );

  assert.ok(Date.now() - started < 500);
  const timeoutEvent = events.find((event) => event.operation === "scan-contact-links" && event.outcome === "failed");
  assert.equal(timeoutEvent?.frameUrl, "https://hung.example.test/frame");
  assert.deepEqual(timeoutEvent?.data, { timeoutMs: 30, completedFrames: 0, discoveredLinks: 0 });
});

test("full-site watchdog returns TIMED_OUT even before browser setup completes", async () => {
  const outcome = await run_contact_outreach_core(
    { ...CONTACT_REQUEST, websiteUrl: "http://127.0.0.1:9/" },
    { runMode: "production", siteTimeoutMs: 1 },
  );
  assert.equal(outcome.executionStatus, "TIMED_OUT");
  assert.match(outcome.reason ?? "", /Full website workflow timed out/);
});

test("full-site watchdog preserves completed browser-stage evidence during later channel work", async () => {
  const server = createServer((request, response) => {
    if (request.url === "/contact") return;
    response.writeHead(200, { "content-type": "text/html" });
    response.end(
      "<title>Fixture company</title><main><h1>Business consulting services</h1>" +
      "<p>We provide strategy, implementation, training, and ongoing support for organizations worldwide.</p>" +
      "<a href='/contact'>Contact our team</a></main>",
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server did not bind.");
  try {
    const outcome = await run_contact_outreach_core(
      { ...CONTACT_REQUEST, websiteUrl: `http://127.0.0.1:${address.port}/` },
      { runMode: "production", siteTimeoutMs: 5_000 },
    );
    assert.equal(outcome.executionStatus, "TIMED_OUT");
    assert.equal(outcome.browserStage?.schemaVersion, 3);
    assert.ok(["LOADED", "LOADED_AFTER_TIMEOUT"].includes(outcome.browserStage?.outcome ?? ""));
    assert.equal(outcome.browserStage?.pageQuality, "USABLE");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("Hebrew form semantics populate supplied values verbatim and accept only required privacy consent", async () => {
  await with_local_page(
    `<main dir="rtl"><h1>צור קשר</h1>
      <form id="contact">
        <label>שם מלא <input name="x1" required></label>
        <label>אימייל <input name="x2" required></label>
        <label>טלפון <input name="x3"></label>
        <label>הודעה <textarea name="x4" required></textarea></label>
        <label><input id="privacy" type="checkbox" required>אני מאשר את מדיניות הפרטיות</label>
        <label><input id="marketing" type="checkbox">אני מאשר דיוור ועדכונים שיווקיים</label>
        <button type="submit">שליחת הודעה</button>
      </form>
    </main>`,
    async (page) => {
      const discovery = await discover_contact_form(
        { page, close: async () => undefined },
        page.url(),
      );
      assert.ok(discovery.candidate, discovery.reason);
      const request = {
        ...CONTACT_REQUEST,
        websiteUrl: page.url(),
        name: "Test Person שמור",
        message: "Exact campaign message — do not translate",
      };
      const population = await populate_contact_form(request, discovery.candidate);
      assert.equal(population.blockingReason, undefined);
      assert.equal(await page.locator('[name="x1"]').inputValue(), request.name);
      assert.equal(await page.locator('[name="x2"]').inputValue(), request.email);
      assert.equal(await page.locator('[name="x3"]').inputValue(), request.phone);
      assert.equal(await page.locator('[name="x4"]').inputValue(), request.message);
      assert.equal(await page.locator("#privacy").isChecked(), true);
      assert.equal(await page.locator("#marketing").isChecked(), false);
      const submit = await find_submit_control(discovery.candidate);
      assert.ok(submit.control, submit.reason);
      assert.equal((await submit.control.textContent())?.trim(), "שליחת הודעה");
    },
  );
});

test("Hebrew multi-step forms use the existing bounded progression classification", async () => {
  await with_local_page(
    `<main><h1>השאירו פרטים</h1><form>
      <label>שם מלא <input name="person"></label>
      <label>אימייל <input type="email" name="mail"></label>
      <button type="button">המשך</button>
    </form></main>`,
    async (page) => {
      const result = await discover_contact_form(
        { page, close: async () => undefined },
        page.url(),
      );
      assert.ok(result.candidate, result.reason);
      assert.equal(result.candidate.classification, "progression");
    },
  );
});

test("Hebrew newsletter, search, login, directions, and job forms remain rejected", async () => {
  for (const fixture of [
    `<main><h1>ניוזלטר</h1><form><input type="email"><button>הרשמה לעדכונים</button></form></main>`,
    `<main><h1>חיפוש</h1><form><input name="query"><button>חיפוש</button></form></main>`,
    `<main><h1>כניסה לחשבון</h1><form><input type="email"><button>התחברות</button></form></main>`,
    `<main><h1>הוראות הגעה</h1><form><input name="from"><button>תכנון מסלול</button></form></main>`,
    `<main><h1>דרושים</h1><form><input type="email"><button>הגשת מועמדות</button></form></main>`,
  ]) {
    await with_local_page(fixture, async (page) => {
      const result = await discover_contact_form(
        { page, close: async () => undefined },
        page.url(),
      );
      assert.equal(result.candidate, undefined, fixture);
    });
  }
});

test("macro route discovery ranks and deduplicates only same-origin web routes", async () => {
  await with_local_page(
    `<nav>
       <a href="/contact">Contact</a>
       <a href="/contact">Contact our team</a>
       <a href="#sales-consultation">Book a consultation</a>
       <a href="/support">Help and support</a>
       <a href="mailto:hello@example.com">Email us</a>
       <a href="tel:+15550100">Call us</a>
       <a href="javascript:void(0)">Contact popup</a>
       <a href="https://other.test/contact">External contact</a>
     </nav>`,
    async (page) => {
      const result = await discover_contact_routes(page);
      const urls = result.candidates.map((candidate) => candidate.url);

      assert.equal(result.startingUrl, "http://local.test/");
      assert.equal(page.url(), result.startingUrl);
      assert.equal(urls.filter((url) => url === "http://local.test/contact").length, 1);
      assert.ok(urls.includes("http://local.test/#sales-consultation"));
      assert.ok(urls.includes("http://local.test/support"));
      assert.equal(urls.some((url) => /mailto:|tel:|javascript:|other\.test/.test(url)), false);
      assert.equal(result.candidates[0]?.url, "http://local.test/#sales-consultation");
      assert.ok(
        urls.indexOf("http://local.test/contact") <
          urls.indexOf("http://local.test/support"),
      );
      assert.deepEqual(
        result.candidates.map((candidate) => candidate.score),
        [...result.candidates]
          .map((candidate) => candidate.score)
          .sort((left, right) => right - left),
      );
    },
  );
});

test("same-page inquiry anchors reject contact forms that offer no message", async () => {
  await with_local_page(
    `<a href="#consultation">Book a Call</a>
     <form id="consultation"><h2>Consultation</h2><input type="email" name="email"><input name="company"><button>Request a call</button></form>
     <style>#consultation { display:none } #consultation:target { display:block }</style>`,
    async (page) => {
      const result = await discover_contact_form(
        { page, close: async () => undefined },
        page.url(),
      );
      assert.equal(result.candidate, undefined);
      assert.equal(result.failureKind, "population.message_not_found");
      assert.match(result.reason ?? "", /message field/i);
    },
  );
});

test("a contenteditable message control is populated deterministically", async () => {
  await with_local_page(
    `<main><h1>Contact us</h1><form><input type="email" name="email"><input name="name"><div contenteditable="true" aria-label="Tell us"></div><button>Send</button></form></main>`,
    async (page) => {
      const discovery = await discover_contact_form(
        { page, close: async () => undefined },
        page.url(),
      );
      assert.ok(discovery.candidate, discovery.reason);
      const population = await populate_contact_form(
        { ...CONTACT_REQUEST, websiteUrl: page.url() },
        discovery.candidate,
      );
      assert.equal(population.messageDisposition, "populated");
      assert.equal(population.blockingReason, undefined);
      assert.equal(
        await page.locator('[contenteditable="true"]').textContent(),
        CONTACT_REQUEST.message,
      );
    },
  );
});

test("newsletter forms remain rejected and write redacted discovery diagnostics", async () => {
  const artifact_directory = await mkdtemp(join(tmpdir(), "discovery-upgrade-"));
  try {
    await with_local_page(
      `<main><h1>Newsletter</h1><form><input type="email" name="email"><button>Subscribe</button></form></main>`,
      async (page) => {
        const result = await discover_contact_form(
          { page, close: async () => undefined },
          page.url(),
          { artifactDirectory: artifact_directory },
        );
        assert.equal(result.candidate, undefined);
        assert.ok(result.debug?.screenshotPath);
        await stat(result.debug!.screenshotPath!);
        const report = await readFile(result.debug!.reportPath, "utf8");
        assert.match(report, /newsletter or subscription semantics/i);
        assert.doesNotMatch(report, /Fixture inquiry|test@example\.com/);
        const debug = JSON.parse(report) as {
          version: number;
          summary: { candidates: Array<{ candidateId: string; inspectionId: string; ruleId: string; controls: unknown[] }> };
        };
        assert.equal(debug.version, 2);
        assert.equal(debug.summary.candidates[0]?.candidateId, "candidate-1");
        assert.equal(debug.summary.candidates[0]?.inspectionId, "inspection-1");
        assert.equal(debug.summary.candidates[0]?.ruleId, "DISCOVERY-REJECT-NEWSLETTER");
        assert.ok((debug.summary.candidates[0]?.controls.length ?? 21) <= 20);
      },
    );
  } finally {
    await rm(artifact_directory, { recursive: true, force: true });
  }
});

test("discovery diagnostics distinguish a resolved navigation from an HTTP error", async () => {
  const artifact_directory = await mkdtemp(join(tmpdir(), "discovery-http-error-"));
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.route("http://local.test/", (route) => route.fulfill({
      status: 200,
      contentType: "text/html",
      body: '<main><a href="/contact">Contact us</a></main>',
    }));
    await page.route("http://local.test/contact", (route) => route.fulfill({
      status: 404,
      contentType: "text/html",
      body: '<main><h1>404 Not Found</h1></main>',
    }));
    await page.goto("http://local.test/");
    const result = await discover_contact_form(
      { page, close: async () => undefined },
      page.url(),
      { artifactDirectory: artifact_directory },
    );
    const debug = JSON.parse(await readFile(result.debug!.reportPath, "utf8")) as {
      summary: {
        attemptedRoutes: Array<{ result: string; diagnosticResult: string; mainDocumentStatus: number; inspectionCompleted: boolean; pageQuality: string }>;
        inspectionAttempts: Array<{ inspectionId: string; mainDocumentStatus?: number; pageQuality: string }>;
        coverageAssessment: { completeEnoughForNoFormConclusion: boolean; incompleteReasons: string[] };
      };
    };
    const route = debug.summary.attemptedRoutes.find((item) => item.mainDocumentStatus === 404);
    assert.equal(route?.result, "opened");
    assert.equal(route?.diagnosticResult, "http_error");
    assert.equal(route?.inspectionCompleted, true);
    assert.equal(route?.pageQuality, "error_page");
    assert.ok(debug.summary.inspectionAttempts.some((item) => item.mainDocumentStatus === 404));
    assert.equal(debug.summary.coverageAssessment.completeEnoughForNoFormConclusion, false);
    assert.ok(debug.summary.coverageAssessment.incompleteReasons.some((reason) => reason.includes("http_error")));
  } finally {
    await context.close();
    await rm(artifact_directory, { recursive: true, force: true });
  }
});

test("email-only and inaccessible contact routes have distinct reasons", async () => {
  await with_local_page(
    `<main><h1>Contact</h1><a href="mailto:hello@example.com">Email us</a></main>`,
    async (page) => {
      const result = await discover_contact_form(
        { page, close: async () => undefined },
        page.url(),
      );
      assert.match(result.reason ?? "", /only email contact/i);
    },
  );

  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.route("http://local.test/", (route) =>
      route.fulfill({ contentType: "text/html", body: '<a href="/contact">Contact</a>' }),
    );
    await page.route("http://local.test/contact", (route) => route.abort());
    await page.goto("http://local.test/");
    const result = await discover_contact_form(
      { page, close: async () => undefined },
      page.url(),
    );
    assert.equal(result.transportFailure, true);
    assert.match(result.reason ?? "", /inaccessible/i);
  } finally {
    await context.close();
  }
});

async function with_local_page(
  html: string,
  callback: (page: Page) => Promise<void>,
): Promise<void> {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.route("http://local.test/**", (route) =>
      route.fulfill({ contentType: "text/html; charset=utf-8", body: html }),
    );
    await page.goto("http://local.test/");
    await callback(page);
  } finally {
    await context.close();
  }
}
