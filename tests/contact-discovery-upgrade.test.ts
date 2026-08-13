import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import type { ContactRequest } from "../src/contact_outreach_workflow/contact_channels/forms/shared_files_forms/forms_types_(Support).js";
import { discover_contact_routes } from "../src/contact_outreach_workflow/orchestrator/C_contact_routes/C1_contact_route_discovery_(Integration).js";
import { score_contact_route } from "../src/contact_outreach_workflow/orchestrator/C_contact_routes/C2_contact_route_scoring_(Deterministic).js";
import { discover_contact_form } from "../src/contact_outreach_workflow/contact_channels/forms/pipeline/A_discovery/A1_contact_form_discovery_(Integration).js";
import { populate_contact_form } from "../src/contact_outreach_workflow/contact_channels/forms/pipeline/B_population/B1_contact_form_population_(Integration).js";
import { find_submit_control } from "../src/contact_outreach_workflow/contact_channels/forms/pipeline/C_submission/C3_submit_control_selection_(Deterministic).js";

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

test("same-page inquiry anchors accept strong contact forms that offer no message", async () => {
  await with_local_page(
    `<a href="#consultation">Book a Call</a>
     <form id="consultation"><h2>Consultation</h2><input type="email" name="email"><input name="company"><button>Request a call</button></form>
     <style>#consultation { display:none } #consultation:target { display:block }</style>`,
    async (page) => {
      const result = await discover_contact_form(
        { page, close: async () => undefined },
        page.url(),
      );
      assert.ok(result.candidate, result.reason);
      assert.equal(result.candidate.classification, "complete");
      assert.equal(result.candidate.messageDisposition, "notOffered");
    },
  );
});

test("a present but unresolved message-capable control remains blocking", async () => {
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
      assert.equal(population.messageDisposition, "unresolved");
      assert.match(population.blockingReason ?? "", /message field/i);
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
      },
    );
  } finally {
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
