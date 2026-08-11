import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";
import { run_meetings_workflow } from "../src/contact_outreach_workflow/contact_channels/meetings/meetings_orchestrator.js";
import {
  classify_meeting_candidate,
  merge_meeting_links,
} from "../src/contact_outreach_workflow/contact_channels/meetings/pipeline/A_discovery/A2_meeting_link_classification_(Deterministic).js";
import {
  build_meeting_report_sections,
  create_meeting_channel_outcome,
} from "../src/contact_outreach_workflow/contact_channels/meetings/pipeline/C_reporting/C1_meeting_reporting_(Support).js";
import { open_target_website } from "../src/contact_outreach_workflow/orchestrator/B_browser/B_browser_session_(Integration).js";
import type {
  ContactRequest,
  ContactRouteDiscoveryResult,
} from "../src/contact_outreach_workflow/shared_files_orchestrator/outreach_types_(Support).js";

let server: Server;
let cross_origin_server: Server;
let origin: string;
let cross_origin: string;
const requested_paths: string[] = [];
const cross_origin_requested_paths: string[] = [];

before(async () => {
  cross_origin_server = createServer((request, response) => {
    cross_origin_requested_paths.push(request.url ?? "/");
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(
      '<a href="https://calendly.com/ignored/cross-frame">Schedule a demo</a>',
    );
  });
  cross_origin = await listen(cross_origin_server);

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
      response.end(`
        <main>
          <a href="https://meetings.hubspot.com/acme/demo">Meet with our sales team</a>
        </main>
      `);
      return;
    }
    if (path === "/contact") {
      response.end(`
        <main>
          <a href="/book-demo">Schedule a demo</a>
          <a href="https://scheduler.vendor.test/acme/discovery">
            Schedule a discovery call
          </a>
          <section>
            <h2>Support appointments</h2>
            <a href="https://calendly.com/acme/support">Book a support appointment</a>
          </section>
          <iframe src="/frame"></iframe>
          <iframe src="${cross_origin}/frame"></iframe>
        </main>
      `);
      return;
    }
    if (path === "/team") {
      response.end(`
        <main>
          <a href="https://calendly.com/acme/demo">Talk to sales</a>
          <iframe src="https://acme.chilipiper.com/book/me/sales"></iframe>
        </main>
      `);
      return;
    }
    if (path === "/fourth") {
      response.end(
        '<a href="https://calendly.com/acme/fourth">Schedule a meeting</a>',
      );
      return;
    }
    if (path === "/empty") {
      response.end("<main>Contact us through the form.</main>");
      return;
    }

    response.end(`
      <main>
        <a href="https://calendly.com/acme/demo">Schedule a demo</a>
        <button data-cal-link="acme/strategy">Book a strategy session</button>
        <a href="https://scheduler.vendor.test/acme/discovery">
          Schedule a discovery call
        </a>
        <a hidden href="https://calendly.com/acme/hidden">Schedule a call</a>
        <a href="javascript:void(0)">Schedule a meeting</a>
        <button>Schedule a meeting</button>
      </main>
    `);
  });
  origin = await listen(server);
});

after(async () => {
  await close_server(server);
  await close_server(cross_origin_server);
});

test("classifies provider and generic business scheduling candidates deterministically", () => {
  const source = "https://example.test/contact";
  const calendly = classify_meeting_candidate({
    rawUrl: "https://calendly.com/acme/demo",
    attribute: "href",
    label: "Book time",
    context: "",
    kind: "visible_link",
    baseUrl: source,
    sourcePageUrl: source,
  });
  assert.equal(calendly?.provider, "calendly");

  const cal_embed = classify_meeting_candidate({
    rawUrl: "acme/strategy",
    attribute: "data-cal-link",
    label: "",
    context: "",
    kind: "embedded_widget",
    baseUrl: source,
    sourcePageUrl: source,
  });
  assert.equal(cal_embed?.url, "https://cal.com/acme/strategy");
  assert.equal(cal_embed?.provider, "cal.com");

  const custom = classify_meeting_candidate({
    rawUrl: "/schedule-discovery-call",
    attribute: "href",
    label: "Schedule a discovery call",
    context: "",
    kind: "visible_link",
    baseUrl: source,
    sourcePageUrl: source,
  });
  assert.equal(custom?.url, "https://example.test/schedule-discovery-call");
  assert.equal(custom?.provider, "custom");

  for (const rejected of [
    {
      rawUrl: "https://calendly.com/pricing",
      label: "Learn more",
      context: "",
    },
    {
      rawUrl: "https://calendly.com/acme/interview",
      label: "Schedule an interview",
      context: "Candidate careers",
    },
    {
      rawUrl: "https://example.test/support-call",
      label: "Book a support appointment",
      context: "Help desk",
    },
    {
      rawUrl: "mailto:sales@example.test",
      label: "Schedule a meeting",
      context: "",
    },
  ]) {
    assert.equal(
      classify_meeting_candidate({
        ...rejected,
        attribute: "href",
        kind: "visible_link",
        baseUrl: source,
        sourcePageUrl: source,
      }),
      undefined,
      rejected.rawUrl,
    );
  }
});

test("deduplicates destinations and merges sorted source evidence", () => {
  const merged = merge_meeting_links([
    {
      url: "https://calendly.com/acme/demo",
      provider: "calendly",
      sources: [
        {
          pageUrl: "https://example.test/contact",
          kind: "visible_link",
          label: "Schedule a demo",
        },
      ],
    },
    {
      url: "https://calendly.com/acme/demo",
      provider: "calendly",
      sources: [
        {
          pageUrl: "https://example.test/",
          kind: "embedded_widget",
        },
      ],
    },
  ]);

  assert.equal(merged.length, 1);
  assert.deepEqual(
    merged[0]?.sources.map((source) => source.pageUrl),
    ["https://example.test/", "https://example.test/contact"],
  );
});

test("discovers links and widgets without navigating external destinations", async () => {
  requested_paths.length = 0;
  cross_origin_requested_paths.length = 0;
  const contact_request = request_for("/");
  const session = await open_target_website(contact_request);
  const primary_url = session.page.url();
  const completed_external_requests: string[] = [];
  session.context.on("requestfinished", (request) => {
    if (new URL(request.url()).origin !== origin) {
      completed_external_requests.push(request.url());
    }
  });

  try {
    const outcome = await run_meetings_workflow(
      contact_request,
      session,
      routes_for("/", ["/contact", "/team", "/empty", "/fourth"]),
    );

    assert.equal(outcome.status, "SUCCESS", JSON.stringify(outcome));
    assert.deepEqual(
      outcome.meetingLinks.map((link) => link.url),
      [
        `${origin}/book-demo`,
        "https://acme.chilipiper.com/book/me/sales",
        "https://cal.com/acme/strategy",
        "https://calendly.com/acme/demo",
        "https://meetings.hubspot.com/acme/demo",
        "https://scheduler.vendor.test/acme/discovery",
      ].sort((left, right) => left.localeCompare(right)),
    );
    assert.equal(
      outcome.meetingLinks.find(
        (link) => link.url === "https://calendly.com/acme/demo",
      )?.sources.length,
      2,
    );
    assert.equal(outcome.plannedPageCount, 4);
    assert.equal(outcome.inspectedPages.length, 4);
    assert.equal(requested_paths.includes("/fourth"), false);
    assert.deepEqual(cross_origin_requested_paths, []);
    assert.deepEqual(completed_external_requests, []);
    assert.equal(session.page.url(), primary_url);
    assert.deepEqual(session.context.pages(), [session.page]);
  } finally {
    await session.close();
  }
});

test("returns PARTIAL and continues after an inaccessible planned page", async () => {
  const contact_request = request_for("/");
  const session = await open_target_website(contact_request);

  try {
    const outcome = await run_meetings_workflow(
      contact_request,
      session,
      routes_for("/", ["/broken", "/team"]),
    );

    assert.equal(outcome.status, "PARTIAL", JSON.stringify(outcome));
    assert.equal(outcome.failureKind, "meeting.discovery.incomplete");
    assert.equal(outcome.plannedPageCount, 3);
    assert.equal(outcome.inspectedPages.length, 2);
    assert.equal(outcome.failedPages.length, 1);
    assert.match(outcome.failedPages[0]?.reason ?? "", /HTTP 500/i);
    assert.equal(outcome.meetingLinks.length > 0, true);
  } finally {
    await session.close();
  }
});

test("meeting outcome distinguishes no option from blocked coverage", () => {
  const no_option = create_meeting_channel_outcome(`${origin}/empty`, {
    meetingLinks: [],
    plannedPages: [`${origin}/empty`],
    inspectedPages: [`${origin}/empty`],
    failedPages: [],
  });
  assert.equal(no_option.status, "FAILED");
  assert.equal(no_option.failureKind, "meeting.discovery.no_option");

  const blocked = create_meeting_channel_outcome(`${origin}/broken`, {
    meetingLinks: [],
    plannedPages: [`${origin}/broken`],
    inspectedPages: [],
    failedPages: [{ url: `${origin}/broken`, reason: "HTTP 500" }],
  });
  assert.equal(blocked.status, "FAILED");
  assert.equal(blocked.failureKind, "meeting.discovery.failed");

  const partial_without_link = create_meeting_channel_outcome(`${origin}/`, {
    meetingLinks: [],
    plannedPages: [`${origin}/`, `${origin}/broken`],
    inspectedPages: [`${origin}/`],
    failedPages: [{ url: `${origin}/broken`, reason: "HTTP 500" }],
  });
  assert.equal(partial_without_link.status, "PARTIAL");
  assert.equal(
    partial_without_link.failureKind,
    "meeting.discovery.incomplete",
  );
});

test("meeting reporting keeps all legacy form labels unambiguous", () => {
  const outcome = create_meeting_channel_outcome(`${origin}/`, {
    meetingLinks: [
      {
        url: "https://calendly.com/acme/demo",
        provider: "calendly",
        sources: [
          {
            pageUrl: `${origin}/`,
            kind: "visible_link",
            label: "Schedule a demo",
          },
        ],
      },
    ],
    plannedPages: [`${origin}/`],
    inspectedPages: [`${origin}/`],
    failedPages: [],
  });
  const [section] = build_meeting_report_sections(outcome);
  const report = section?.lines.join("\n") ?? "";

  assert.equal(section?.title, "MEETING DISCOVERY");
  assert.match(report, /^Meeting status: SUCCESS$/m);
  assert.match(report, /^Meeting link: https:\/\/calendly\.com\/acme\/demo/m);
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

async function listen(target_server: Server): Promise<string> {
  await new Promise<void>((resolve) => {
    target_server.listen(0, "127.0.0.1", resolve);
  });
  const address = target_server.address();
  if (!address || typeof address === "string") {
    throw new Error("Meeting fixture server did not expose a TCP port");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function close_server(target_server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    target_server.close((error) => (error ? reject(error) : resolve()));
  });
}
