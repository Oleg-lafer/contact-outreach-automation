import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";
import { run_emails_workflow } from "../src/contact_outreach_workflow/contact_channels/emails/emails_orchestrator.js";
import {
  build_bounded_channel_page_plan,
} from "../src/contact_outreach_workflow/shared_files_orchestrator/channel_discovery_page_plan_(Deterministic).js";
import {
  extract_literal_emails,
  extract_mailto_recipient_emails,
} from "../src/contact_outreach_workflow/contact_channels/emails/pipeline/A_discovery/A2_email_extraction_(Deterministic).js";
import {
  build_email_report_sections,
  create_email_channel_outcome,
} from "../src/contact_outreach_workflow/contact_channels/emails/pipeline/E_reporting/E1_email_reporting_(Support).js";
import { open_target_website } from "../src/contact_outreach_workflow/orchestrator/B_browser/B_browser_session_(Integration).js";
import type {
  ContactRequest,
  ContactRouteDiscoveryResult,
} from "../src/contact_outreach_workflow/shared_files_orchestrator/outreach_types_(Support).js";

let server: Server;
let origin: string;
const requested_paths: string[] = [];

before(async () => {
  server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    requested_paths.push(path);
    response.setHeader("Content-Type", "text/html; charset=utf-8");

    if (path === "/broken") {
      response.statusCode = 500;
      response.end("<main>Temporarily unavailable</main>");
      return;
    }
    if (path === "/frame") {
      response.end("<main>Frame contact: frame@company.test</main>");
      return;
    }
    if (path === "/contact") {
      response.end("<main>Legal inquiries: legal@company.test</main>");
      return;
    }
    if (path === "/support") {
      response.end(
        "<main>Support: support@company.test or founder@gmail.com</main>",
      );
      return;
    }
    if (path === "/team") {
      response.end("<main>Our founder: founder@company.test</main>");
      return;
    }
    if (path === "/fourth") {
      response.end("<main>Fourth route: fourth@company.test</main>");
      return;
    }
    if (path === "/empty") {
      response.end("<main>Contact our team through the form.</main>");
      return;
    }

    response.end(`
      <main>
        <p>Sales: Sales@Company.test.</p>
        <p>Sender echo: sender@company.test</p>
        <p>No reply: noreply@company.test and do-not-reply@company.test</p>
        <p hidden>hidden-text@company.test</p>
        <a style="display:none" href="mailto:hidden-link@company.test">Hidden</a>
        <a href="MAILTO:Team%40Company.test;privacy@company.test?cc=query-only@company.test&body=body-only@company.test">
          Email the team
        </a>
        <script>const ignored = "script-only@company.test";</script>
        <iframe src="/frame"></iframe>
      </main>
    `);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Email fixture server did not expose a TCP port");
  }
  origin = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

test("extracts and normalizes literal and mailto recipient addresses", () => {
  assert.deepEqual(
    extract_literal_emails(
      "Write Sales@Example.test, privacy@example.test. Invalid a..b@example.test and user@localhost.",
    ),
    ["privacy@example.test", "sales@example.test"],
  );
  assert.deepEqual(
    extract_mailto_recipient_emails(
      "mailto:Sales%40Example.test,privacy@example.test;LEGAL@example.test?cc=ignored@example.test&body=also-ignored@example.test",
    ),
    [
      "legal@example.test",
      "privacy@example.test",
      "sales@example.test",
    ],
  );
});

test("plans only the starting page and first three distinct same-origin candidates", () => {
  const routes: ContactRouteDiscoveryResult = {
    startingUrl: "https://example.test/",
    candidates: [
      { url: "https://example.test/", score: 20, label: "duplicate" },
      { url: "mailto:hello@example.test", score: 19, label: "mail" },
      { url: "https://external.test/contact", score: 18, label: "external" },
      { url: "https://example.test/#contact", score: 17, label: "hash" },
      { url: "https://example.test/contact", score: 16, label: "contact" },
      { url: "https://example.test/support", score: 15, label: "support" },
      { url: "https://example.test/team", score: 14, label: "fourth" },
    ],
  };

  assert.deepEqual(build_bounded_channel_page_plan(routes), [
    "https://example.test/",
    "https://example.test/#contact",
    "https://example.test/contact",
    "https://example.test/support",
  ]);
});

test("discovers all usable published emails while keeping the forms page isolated", async () => {
  requested_paths.length = 0;
  const contact_request = request_for("/");
  const session = await open_target_website(contact_request);
  const primary_url = session.page.url();

  try {
    const outcome = await run_emails_workflow(
      contact_request,
      session,
      routes_for("/", ["/contact", "/support", "/team", "/fourth"]),
    );

    assert.equal(outcome.status, "SUCCESS", JSON.stringify(outcome));
    assert.deepEqual(outcome.emails, [
      "founder@company.test",
      "founder@gmail.com",
      "frame@company.test",
      "legal@company.test",
      "privacy@company.test",
      "sales@company.test",
      "support@company.test",
      "team@company.test",
    ]);
    assert.equal(outcome.plannedPageCount, 4);
    assert.equal(outcome.inspectedPages.length, 4);
    assert.equal(outcome.failedPages.length, 0);
    assert.equal(requested_paths.includes("/fourth"), false);
    assert.equal(session.page.url(), primary_url);
    assert.deepEqual(session.context.pages(), [session.page]);
  } finally {
    await session.close();
  }
});

test("returns PARTIAL for incomplete page coverage and continues after a failed route", async () => {
  const contact_request = request_for("/");
  const session = await open_target_website(contact_request);

  try {
    const outcome = await run_emails_workflow(
      contact_request,
      session,
      routes_for("/", ["/broken", "/support"]),
    );

    assert.equal(outcome.status, "PARTIAL", JSON.stringify(outcome));
    assert.equal(outcome.failureKind, "email.discovery.incomplete");
    assert.equal(outcome.plannedPageCount, 3);
    assert.equal(outcome.inspectedPages.length, 2);
    assert.equal(outcome.failedPages.length, 1);
    assert.match(outcome.failedPages[0]?.reason ?? "", /HTTP 500/i);
    assert.equal(outcome.emails.includes("support@company.test"), true);
  } finally {
    await session.close();
  }
});

test("email outcome status semantics distinguish no address from blocked coverage", () => {
  const no_address = create_email_channel_outcome(`${origin}/empty`, {
    emails: [],
    plannedPages: [`${origin}/empty`],
    inspectedPages: [`${origin}/empty`],
    failedPages: [],
  });
  assert.equal(no_address.status, "FAILED");
  assert.equal(no_address.failureKind, "email.discovery.no_address");

  const blocked = create_email_channel_outcome(`${origin}/broken`, {
    emails: [],
    plannedPages: [`${origin}/broken`],
    inspectedPages: [],
    failedPages: [{ url: `${origin}/broken`, reason: "HTTP 500" }],
  });
  assert.equal(blocked.status, "FAILED");
  assert.equal(blocked.failureKind, "email.discovery.failed");

  const partial_without_email = create_email_channel_outcome(`${origin}/`, {
    emails: [],
    plannedPages: [`${origin}/`, `${origin}/broken`],
    inspectedPages: [`${origin}/`],
    failedPages: [{ url: `${origin}/broken`, reason: "HTTP 500" }],
  });
  assert.equal(partial_without_email.status, "PARTIAL");
  assert.equal(
    partial_without_email.failureKind,
    "email.discovery.incomplete",
  );
});

test("email reporting uses prefixed fields that cannot shadow form analytics", () => {
  const outcome = create_email_channel_outcome(`${origin}/`, {
    emails: ["hello@company.test"],
    plannedPages: [`${origin}/`],
    inspectedPages: [`${origin}/`],
    failedPages: [],
  });
  const [section] = build_email_report_sections(outcome);
  const report = section?.lines.join("\n") ?? "";

  assert.equal(section?.title, "EMAIL DISCOVERY");
  assert.match(report, /^Email status: SUCCESS$/m);
  assert.match(report, /^Discovered email: hello@company\.test$/m);
  assert.doesNotMatch(report, /^Status:/m);
  assert.doesNotMatch(report, /^Reason:/m);
  assert.doesNotMatch(report, /^Failure kind:/m);
});

function request_for(path: string): ContactRequest {
  return {
    websiteUrl: `${origin}${path}`,
    name: "Fixture User",
    email: "sender@company.test",
    phone: "050-0000000",
    message: "Please contact me.",
  };
}

function routes_for(
  starting_path: string,
  candidate_paths: string[],
): ContactRouteDiscoveryResult {
  return {
    startingUrl: `${origin}${starting_path}`,
    candidates: candidate_paths.map((path, index) => ({
      url: `${origin}${path}`,
      score: 100 - index,
      label: path,
    })),
  };
}
