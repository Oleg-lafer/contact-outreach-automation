import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
  classify_browser_stage_failure,
  create_browser_stage_run_summary,
  normalize_browser_stage_error,
  write_browser_stage_run_summary_files,
} from "../src/contact_outreach_workflow/shared_files_orchestrator/browser_stage_diagnostics_(Support).js";
import type {
  BrowserStageResult,
  ContactOutreachOutcome,
} from "../src/contact_outreach_workflow/shared_files_orchestrator/outreach_types_(Support).js";
import { run_contact_outreach_workflow } from "../src/contact_outreach_workflow/contact_outreach_orchestrator.js";
import { analyzeRun } from "../src/contact_form_analytics/run_analyzer.js";
import {
  is_browser_submission_transport_allowed,
  open_target_website,
  plan_browser_recovery_candidates,
} from "../src/contact_outreach_workflow/orchestrator/B_browser/B_browser_session_(Integration).js";
import { redact_diagnostic_text, redact_diagnostic_url } from "../src/contact_outreach_workflow/shared_files_orchestrator/diagnostic_redaction_(Support).js";
import { resolve_browser_recovery_enabled } from "../src/contact_outreach_workflow/shared_files_orchestrator/outreach_constants_(Support).js";

const CONTACT_VALUES = {
  name: "Browser Diagnostic Person",
  email: "browser-diagnostic-secret@example.test",
  phone: "+1 202 555 0188",
  message: "Browser diagnostic secret message.",
};

let server: Server;
let origin: string;
let temporaryDirectory: string;
let flakyResetRequests = 0;

before(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "browser-stage-diagnostics-"));
  server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    if (pathname === "/delayed-domcontentloaded") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.write(
        "<html><head><title>Real consulting company</title></head><body>" +
        "<main><h1>Business consulting and marketing services</h1>" +
        "<p>We provide strategy, research, implementation, and support for growing organizations worldwide.</p>" +
        "<a href='/about'>About our company</a></main>",
      );
      setTimeout(() => response.end("</body></html>"), 16_000);
      return;
    }
    if (pathname === "/forbidden") {
      response.writeHead(403, { "content-type": "text/html" });
      response.end("<title>Access denied</title><h1>Forbidden</h1>");
      return;
    }
    if (pathname === "/server-error") {
      response.writeHead(503, { "content-type": "text/html" });
      response.end("<title>Service unavailable</title><h1>Service unavailable</h1>");
      return;
    }
    if (pathname === "/cloudflare-403") {
      response.writeHead(403, { "content-type": "text/html" });
      response.end("<title>Just a moment...</title><main><h1>Business consulting services</h1><p>" +
        "Our experienced team provides strategy, growth, implementation, and ongoing support for organizations worldwide." +
        "</p><a href='/contact'>Contact</a></main>");
      return;
    }
    if (pathname === "/cloudflare-challenge") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<title>Just a moment...</title><main><h1>Checking your browser</h1><p>Performing security verification before proceeding.</p></main>");
      return;
    }
    if (pathname === "/blocked-english") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<title>Access denied</title><main><h1>Your request was blocked</h1><p>You have been blocked from accessing this website.</p></main>");
      return;
    }
    if (pathname === "/cloudflare-523") {
      response.writeHead(523, { "content-type": "text/html" });
      response.end("<title>Just a moment...</title><h1>Cloudflare Ray ID</h1><p>Origin is unreachable.</p>");
      return;
    }
    if (pathname === "/not-found") {
      response.writeHead(404, { "content-type": "text/html" });
      response.end("<title>Company</title><main><h1>Page not found</h1><p>404 - the requested page was not found.</p></main>");
      return;
    }
    if (pathname === "/empty") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<html><head><title>Company</title></head><body></body></html>");
      return;
    }
    if (pathname === "/no-content") {
      response.writeHead(204);
      response.end();
      return;
    }
    if (pathname === "/wix-error") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<title>Wix domain</title><main><h1>This domain isn't connected to a website yet</h1><p>Is this your domain?</p></main>");
      return;
    }
    if (pathname === "/parked") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<title>Example domain</title><main><h1>Buy this domain</h1><p>This domain is for sale through Afternic.</p></main>");
      return;
    }
    if (pathname === "/expired") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<title>Website expired</title><main><h1>This website has expired</h1><p>Please contact the site owner.</p></main>");
      return;
    }
    if (pathname === "/wordpress-error") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<title>WordPress error</title><main><p>There has been a critical error on this website.</p></main>");
      return;
    }
    if (pathname === "/blocked-hebrew") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<title>גישה נדחתה</title><main><h1>הבקשה נחסמה</h1><p>אין לך הרשאה לצפות באתר זה.</p></main>");
      return;
    }
    if (pathname === "/stalled-empty") {
      response.writeHead(200, { "content-type": "text/html" });
      response.write("<html><head><title>Loading</title></head><body>");
      setTimeout(() => response.end("</body></html>"), 12_000);
      return;
    }
    if (pathname === "/flaky-reset") {
      flakyResetRequests += 1;
      if (flakyResetRequests === 1) {
        request.socket.destroy();
        return;
      }
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<title>Recovered company</title><main id='recovered'><h1>Recovered consulting company</h1>" +
        "<p>We provide detailed strategy, design, implementation, training, and ongoing support for business teams.</p>" +
        "<a href='/contact'>Contact our team</a></main>");
      return;
    }
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<title>About</title><p>Ordinary company page.</p>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server did not bind.");
  origin = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve()),
  );
  await rm(temporaryDirectory, { recursive: true, force: true });
});

test("browser-stage classifier assigns only evidence-backed responsibility", () => {
  const launch = classify_browser_stage_failure(stage({
    phase: "BROWSER_LAUNCH",
    error: { name: "Error", message: "browser launch failed" },
  }));
  assert.equal(launch.category, "OUR_AUTOMATION");
  assert.equal(launch.responsibleParty, "OUR_AUTOMATION");
  assert.equal(launch.classificationBasis, "DIRECT");

  const tls = classify_browser_stage_failure(stage({
    mainDocumentRequested: true,
    mainDocumentFailure: "net::ERR_CERT_DATE_INVALID",
    error: { name: "Error", message: "page.goto: net::ERR_CERT_DATE_INVALID" },
  }));
  assert.equal(tls.category, "DESTINATION_WEBSITE");
  assert.equal(tls.subcategory, "tls_or_certificate_failure");

  const dns = classify_browser_stage_failure(stage({
    mainDocumentRequested: true,
    mainDocumentFailure: "net::ERR_NAME_NOT_RESOLVED",
    error: { name: "Error", message: "page.goto: net::ERR_NAME_NOT_RESOLVED" },
  }));
  assert.equal(dns.category, "NETWORK_INFRASTRUCTURE");
  assert.equal(dns.responsibleParty, "NETWORK_INFRASTRUCTURE");
  assert.equal(dns.classificationBasis, "INFERRED");
  assert.ok(dns.missingEvidence.includes("resolver query result"));

  const rateLimit = classify_browser_stage_failure(stage({
    mainDocumentRequested: true,
    mainDocumentReceived: true,
    mainDocumentStatus: 429,
  }));
  assert.equal(rateLimit.category, "ACCESS_RESTRICTION");
  assert.equal(rateLimit.responsibleParty, "ACCESS_RESTRICTION");

  const cloudflareOriginFailure = classify_browser_stage_failure(stage({
    mainDocumentRequested: true,
    mainDocumentReceived: true,
    mainDocumentStatus: 530,
    content: {
      inspected: true,
      meaningfulContent: false,
      accessRestrictionIndicators: ["antibot_challenge"],
      pageQualityIndicators: [],
    },
  }));
  assert.equal(cloudflareOriginFailure.category, "DESTINATION_WEBSITE");
  assert.equal(cloudflareOriginFailure.subcategory, "http_5xx");

  const proxy = classify_browser_stage_failure(stage({
    error: { name: "Error", code: "EPROXY", message: "proxy authentication required" },
  }));
  assert.equal(proxy.category, "OUR_AUTOMATION");
  assert.equal(proxy.subcategory, "proxy_configuration_or_connection");

  const resources = classify_browser_stage_failure(stage({
    error: { name: "Error", code: "ENOMEM", message: "out of memory" },
  }));
  assert.equal(resources.category, "OUR_AUTOMATION");
  assert.equal(resources.subcategory, "local_resource_exhaustion");

  const cdp = classify_browser_stage_failure(stage({ phase: "CDP_CONNECTION" }));
  assert.equal(cdp.category, "OUR_AUTOMATION");
  assert.equal(cdp.subcategory, "cdp_connection");

  const redacted = normalize_browser_stage_error(
    new Error(`Failed for ${CONTACT_VALUES.email}: ${"x".repeat(5_000)}`),
    [CONTACT_VALUES.email],
  );
  assert.doesNotMatch(redacted.message, /browser-diagnostic-secret/i);
  assert.ok(redacted.message.length < 2_100);
  assert.match(redacted.stackFingerprint ?? "", /^[a-f0-9]{16}$/);
  assert.ok(redacted.stack);
});

test("browser-stage classifier identifies our timeout contribution, misclassification, and lifecycle evidence", () => {
  const progressingTimeout = classify_browser_stage_failure(stage({
    timeoutSource: "PLAYWRIGHT_NAVIGATION",
    mainDocumentRequested: true,
    mainDocumentReceived: true,
    mainDocumentStatus: 200,
    error: { name: "TimeoutError", message: "page.goto: Timeout 15000ms exceeded" },
  }));
  assert.equal(progressingTimeout.category, "OUR_AUTOMATION");
  assert.equal(progressingTimeout.subcategory, "navigation_timeout_policy_ended_progressing_load");
  assert.equal(progressingTimeout.confidence, "MEDIUM");
  assert.match(progressingTimeout.strongestEvidenceAgainst ?? "", /not produced meaningful/i);

  const stalledTimeout = classify_browser_stage_failure(stage({
    timeoutSource: "PLAYWRIGHT_NAVIGATION",
    error: { name: "TimeoutError", message: "page.goto: Timeout 15000ms exceeded" },
  }));
  assert.equal(stalledTimeout.category, "UNDETERMINED");
  assert.ok(stalledTimeout.missingEvidence.includes("progress after the deadline"));

  const misclassified = classify_browser_stage_failure(stage({
    mainDocumentReceived: true,
    mainDocumentStatus: 200,
    content: {
      inspected: true,
      meaningfulContent: true,
      accessRestrictionIndicators: [],
      pageQualityIndicators: [],
    },
    pageQuality: "USABLE",
  }));
  assert.equal(misclassified.category, "OUR_AUTOMATION");
  assert.equal(misclassified.confidence, "HIGH");

  const closed = classify_browser_stage_failure(stage({
    health: {
      browserConnected: false,
      pageClosed: true,
      browserDisconnectedObserved: true,
      contextClosedObserved: true,
      pageCrashObserved: false,
      pageCloseObserved: true,
      browserDisconnectInitiator: "OUR_AUTOMATION",
      contextCloseInitiator: "OUR_AUTOMATION",
      pageCloseInitiator: "OUR_AUTOMATION",
    },
  }));
  assert.equal(closed.category, "OUR_AUTOMATION");
  assert.equal(closed.classificationBasis, "DIRECT");
});

test("nested browser errors retain a bounded redacted causal chain", () => {
  const root = new Error(`root ${CONTACT_VALUES.email}`);
  const outer = new Error("outer failure", { cause: root });
  const evidence = normalize_browser_stage_error(outer, [CONTACT_VALUES.email]);
  assert.equal(evidence.cause?.name, "Error");
  assert.doesNotMatch(JSON.stringify(evidence), /browser-diagnostic-secret/i);
  assert.ok((evidence.cause?.stack?.length ?? 0) <= 12_020);
});

test("HTTP access restrictions and destination outages are classified from main-document evidence", async () => {
  const [forbidden, unavailable] = await Promise.all([
    runSite("/forbidden", "forbidden", "production"),
    runSite("/server-error", "server-error", "deep-debug"),
  ]);
  assert.equal(forbidden.browserStage?.outcome, "FAILED");
  assert.equal(forbidden.browserStage?.category, "ACCESS_RESTRICTION");
  assert.equal(forbidden.browserStage?.mainDocumentStatus, 403);
  assert.equal(unavailable.browserStage?.category, "DESTINATION_WEBSITE");
  assert.equal(unavailable.browserStage?.subcategory, "http_5xx");
  assert.equal(unavailable.browserStage?.mainDocumentStatus, 503);
  assert.ok(unavailable.deepDebug);
  assert.ok(unavailable.browserStage?.diagnosticArtifactPath);
  assert.equal(unavailable.browserStage?.schemaVersion, 3);
  assert.ok((unavailable.browserStage?.timeline.length ?? 0) > 0);
  assert.ok((unavailable.browserStage?.resourceSnapshots.length ?? 0) >= 2);
  const artifact = await readFile(unavailable.browserStage!.diagnosticArtifactPath!, "utf8");
  const manifest = JSON.parse(
    await readFile(unavailable.deepDebug!.manifestPath, "utf8"),
  ) as { outcome?: { status?: string; channels?: unknown } };
  assert.equal(manifest.outcome?.status, "FAILED");
  assert.equal(manifest.outcome?.channels, undefined);
  assert.doesNotMatch(artifact, new RegExp(CONTACT_VALUES.email, "i"));
  assert.doesNotMatch(artifact, new RegExp(CONTACT_VALUES.phone.replace(/[+]/g, "\\+")));
});

test("browser page quality rejects challenges, HTTP errors, empty, parked, expired, and deterministic site errors", async () => {
  const paths = [
    "/cloudflare-403",
    "/cloudflare-challenge",
    "/blocked-english",
    "/cloudflare-523",
    "/not-found",
    "/empty",
    "/no-content",
    "/wix-error",
    "/parked",
    "/expired",
    "/wordpress-error",
    "/blocked-hebrew",
  ];
  const results: BrowserStageResult[] = [];
  for (const path of paths) results.push(await openBrowserStage(path));

  assert.equal(results[0]?.category, "ACCESS_RESTRICTION");
  assert.equal(results[0]?.mainDocumentStatus, 403);
  assert.equal(results[1]?.category, "ACCESS_RESTRICTION");
  assert.equal(results[2]?.category, "ACCESS_RESTRICTION");
  assert.equal(results[3]?.category, "DESTINATION_WEBSITE");
  assert.equal(results[3]?.subcategory, "http_5xx");
  assert.equal(results[4]?.subcategory, "http_404");
  assert.equal(results[5]?.pageQuality, "EMPTY");
  assert.equal(results[6]?.subcategory, "http_204_no_content");
  assert.equal(results[7]?.pageQuality, "SITE_ERROR");
  assert.equal(results[8]?.pageQuality, "PARKED");
  assert.equal(results[9]?.pageQuality, "EXPIRED");
  assert.equal(results[10]?.pageQuality, "SITE_ERROR");
  assert.equal(results[11]?.category, "ACCESS_RESTRICTION");
  assert.ok(results.every((result) => result.outcome === "FAILED"));
});

test("stalled committed navigation is stopped and inspected after the bounded readiness window", async () => {
  const started = Date.now();
  const result = await openBrowserStage("/stalled-empty");
  assert.equal(result.outcome, "FAILED");
  assert.equal(result.phase, "POST_TIMEOUT_INSPECTION");
  assert.equal(result.content.inspected, true);
  assert.ok(Date.now() - started < 14_000);
});

test("bounded recovery retries a transient no-document failure and hands off the winning page", async () => {
  flakyResetRequests = 0;
  const session = await open_target_website(
    { websiteUrl: `${origin}/flaky-reset`, ...CONTACT_VALUES },
    {
      allowNavigationFailure: true,
      environment: { ...process.env, CONTACT_FORM_BROWSER_RECOVERY: "on" },
      redactionValues: Object.values(CONTACT_VALUES),
    },
  );
  try {
    assert.equal(session.browserStage?.outcome, "LOADED", JSON.stringify(session.browserStage));
    assert.equal(session.browserStage?.recovered, true);
    assert.equal(session.browserStage?.recoveryEligible, true);
    assert.deepEqual(
      session.browserStage?.navigationAttempts.map((attempt) => attempt.candidateKind),
      ["ORIGINAL", "ORIGINAL_RETRY"],
    );
    assert.ok((session.browserStage?.navigationAttempts.length ?? 0) <= 3);
    assert.ok((session.browserStage?.durationMs ?? Infinity) < 40_000);
    assert.equal(await session.page.locator("#recovered").count(), 1);
  } finally {
    await session.close();
  }
});

test("recovery does not retry access restrictions, terminal HTTP failures, or parked pages", async () => {
  const results: BrowserStageResult[] = [];
  for (const path of ["/forbidden", "/server-error", "/not-found", "/parked"]) {
    results.push(await openBrowserStage(path, "on"));
  }
  assert.equal(results[0]?.category, "ACCESS_RESTRICTION");
  assert.ok(results.every((result) => result.navigationAttempts.length === 1));
  assert.ok(results.every((result) => result.recoveryEligible === false));
});

test("structured URL redaction preserves public hosts and protects sensitive components", () => {
  const redacted = redact_diagnostic_url(
    "https://user:pass@myisraelbusiness.example/Israel/team?q=Israel&email=person@example.test#private",
    ["Israel", "person@example.test"],
  );
  assert.match(redacted, /^https:\/\/\[redacted\]:\[redacted\]@myisraelbusiness\.example\//);
  assert.match(redacted, /\/\[redacted\]\/team/);
  assert.doesNotMatch(redacted, /person@example\.test|#private/);
  assert.match(redacted, /myisraelbusiness\.example/);
  assert.match(
    redact_diagnostic_text("page.goto failed at https://myisraelbusiness.example/Israel", ["Israel"], 2_000),
    /https:\/\/myisraelbusiness\.example\/\[redacted\]/,
  );
  assert.equal(is_browser_submission_transport_allowed("http://public.example/"), false);
  assert.equal(is_browser_submission_transport_allowed("https://public.example/"), true);
  assert.equal(is_browser_submission_transport_allowed("http://127.0.0.1:3000/"), true);
});

test("browser recovery is off by default and accepts only on or off", () => {
  assert.equal(resolve_browser_recovery_enabled({}), false);
  assert.equal(resolve_browser_recovery_enabled({ CONTACT_FORM_BROWSER_RECOVERY: "off" }), false);
  assert.equal(resolve_browser_recovery_enabled({ CONTACT_FORM_BROWSER_RECOVERY: "on" }), true);
  assert.throws(
    () => resolve_browser_recovery_enabled({ CONTACT_FORM_BROWSER_RECOVERY: "true" }),
    /Expected "on" or "off"/,
  );
});

test("browser recovery candidate ordering is deterministic and bounded", () => {
  assert.deepEqual(
    plan_browser_recovery_candidates(
      "https://example.test/contact?q=1",
      "WWW_THEN_CANONICAL",
      "https://contact.example.test/",
    ),
    [
      { kind: "WWW_HTTPS", url: "https://www.example.test/contact?q=1" },
      { kind: "CANONICAL_HTTPS", url: "https://contact.example.test/" },
    ],
  );
  assert.deepEqual(
    plan_browser_recovery_candidates("https://example.test/contact", "WWW_THEN_ORIGINAL"),
    [
      { kind: "WWW_HTTPS", url: "https://www.example.test/contact" },
      { kind: "ORIGINAL_RETRY", url: "https://example.test/contact" },
    ],
  );
  assert.deepEqual(plan_browser_recovery_candidates("https://example.test/", "NONE"), []);
});

test("browser context keeps invalid-TLS bypass disabled", async () => {
  const source = await readFile(
    "src/contact_outreach_workflow/orchestrator/B_browser/B_browser_session_(Integration).ts",
    "utf8",
  );
  assert.match(source, /newContext\(\{\s*ignoreHTTPSErrors:\s*false\s*\}\)/);
  assert.doesNotMatch(source, /ignoreHTTPSErrors:\s*true/);
});

test("campaign browser summary writes five reconciled category ledgers", async () => {
  const summary = create_browser_stage_run_summary([
    outcome("https://ours.test/", classify_browser_stage_failure(stage({ phase: "BROWSER_LAUNCH" }))),
    outcome("https://network.test/", classify_browser_stage_failure(stage({
      mainDocumentFailure: "net::ERR_NAME_NOT_RESOLVED",
    }))),
  ]);
  const directory = join(temporaryDirectory, "browser-summary-v2");
  await write_browser_stage_run_summary_files(directory, summary);
  const names = await readdir(directory);
  assert.equal(summary.schemaVersion, 3);
  assert.equal(summary.categoryCounts.OUR_AUTOMATION, 1);
  assert.equal(summary.categoryCounts.NETWORK_INFRASTRUCTURE, 1);
  assert.equal(summary.ourAutomationSubcategoryCounts.browser_launch, 1);
  assert.ok(names.includes("browser-stage-our-automation.csv"));
  assert.ok(names.includes("browser-stage-destination-website.csv"));
  assert.ok(names.includes("browser-stage-access-restriction.csv"));
  assert.ok(names.includes("browser-stage-network-infrastructure.csv"));
  assert.ok(names.includes("browser-stage-undetermined.csv"));
});

test("a timed-out navigation with meaningful content is retained without retry in both modes", async () => {
  const [production, deepDebug] = await Promise.all([
    runSite("/delayed-domcontentloaded", "timeout-production", "production"),
    runSite("/delayed-domcontentloaded", "timeout-deep-debug", "deep-debug"),
  ]);
  for (const outcome of [production, deepDebug]) {
    assert.equal(outcome.browserStage?.outcome, "LOADED_AFTER_TIMEOUT");
    assert.equal(outcome.browserStage?.attempt, 1);
    assert.equal(outcome.browserStage?.mainDocumentReceived, true);
    assert.equal(outcome.browserStage?.content.meaningfulContent, true);
    assert.equal(outcome.browserStage?.ruleId, "BRW-LOADED-AFTER-TIMEOUT");
  }
  assert.equal(production.browserStage?.timeline.length, 0);
  assert.equal(production.browserStage?.resourceSnapshots.length, 0);
  assert.ok((deepDebug.browserStage?.timeline.length ?? 0) > 0);
  assert.ok((deepDebug.browserStage?.resourceSnapshots.length ?? 0) >= 2);
  assert.ok(deepDebug.deepDebug);
});

test("aggregate reconciliation excludes sites that never entered the browser", () => {
  const loaded = outcome("https://loaded.test/", stage({ outcome: "LOADED" }));
  const failedStage = classify_browser_stage_failure(stage({
    mainDocumentReceived: false,
    error: { name: "TimeoutError", message: "page.goto: Timeout 15000ms exceeded" },
  }));
  const failed = outcome("https://timeout.test/", failedStage);
  const preBrowser = outcome("https://database.test/");
  preBrowser.reason = "connect ETIMEDOUT";
  const summary = create_browser_stage_run_summary([loaded, failed, preBrowser]);
  assert.equal(summary.entered, 2);
  assert.equal(summary.failures, 1);
  assert.equal(summary.notEntered, 1);
  assert.equal(summary.categoryCounts.UNDETERMINED, 1);
  assert.equal(summary.categoryPercentagesOfFailures.UNDETERMINED, 100);
  assert.equal(summary.categoryPercentagesOfEntrants.UNDETERMINED, 50);
  assert.deepEqual(summary.subcategoryCounts, { navigation_timeout_before_main_document: 1 });
  assert.equal(summary.preBrowserExclusions[0]?.websiteUrl, "https://database.test/");
  assert.deepEqual(Object.values(summary.reconciliation), [true, true, true, true]);
});

test("analytics keeps database timeouts and resend prevention out of browser failures", async () => {
  const runPath = join(temporaryDirectory, "analytics-regression");
  await writeHistoricalReport(runPath, 1, "connect ETIMEDOUT", "runtime.error");
  await writeHistoricalReport(
    runPath,
    2,
    "Skipped because campaign already has a successful attempt.",
    "outreach.resend_prevented",
  );
  await writeHistoricalReport(
    runPath,
    3,
    "Could not open the target website: page.goto: Timeout 15000ms exceeded.",
    "navigation.failed",
  );
  const { result } = await analyzeRun(runPath, { writeOutputs: false });
  const forms = result.channels.forms;
  assert.equal(forms.stages.find((item) => item.stage === "pre_browser")?.stopped, 2);
  assert.equal(forms.stages.find((item) => item.stage === "browser")?.stopped, 1);
  assert.equal(forms.sites.find((site) => site.id === "001")?.subcategory, "pre_browser_runtime_failure");
  assert.equal(forms.sites.find((site) => site.id === "002")?.terminalStage, "pre_browser");
  assert.equal(forms.sites.find((site) => site.id === "003")?.terminalStage, "browser");
});

test("analytics reads schema-v1 and schema-v2 browser artifacts into the five-category model", async () => {
  const runPath = join(temporaryDirectory, "browser-schema-compatibility");
  const fixtures = [
    {
      id: 1,
      artifact: {
        ...stage(),
        schemaVersion: 1,
        category: "OUR_SYSTEM_FAILURE",
        responsibleParty: "OUR_SYSTEM",
        subcategory: "legacy_runtime_failure",
      } as unknown,
    },
    {
      id: 2,
      artifact: {
        ...classify_browser_stage_failure(stage({
          mainDocumentFailure: "net::ERR_NAME_NOT_RESOLVED",
        })),
        schemaVersion: 2,
      },
    },
  ];
  for (const fixture of fixtures) {
    const site = join(runPath, String(fixture.id).padStart(3, "0"));
    const debug = join(site, "deep-debug", `run-${fixture.id}`);
    const artifactPath = join(debug, "browser", "browser-stage.json");
    await mkdir(join(debug, "browser"), { recursive: true });
    await writeFile(artifactPath, JSON.stringify(fixture.artifact), "utf8");
    await writeFile(join(site, "result.txt"), [
      "==================== RUN ====================",
      `Website: https://schema-${fixture.id}.test/`,
      "",
      "==================== BROWSER STAGE ====================",
      "Entered: yes",
      "Outcome: FAILED",
      `Browser-stage artifact: ${artifactPath}`,
      "",
      "==================== RESULT ====================",
      "Status: FAILED",
      "Failure kind: navigation.failed",
      "",
      "==================== DISCOVERY ====================",
      "Assessment: site_inspection_blocked",
      "Search coverage: blocked",
    ].join("\n"), "utf8");
  }
  const { result } = await analyzeRun(runPath, { writeOutputs: false });
  assert.equal(result.channels.forms.sites[0]?.browserStage?.schemaVersion, 1);
  assert.equal(result.channels.forms.sites[0]?.browserStage?.category, "OUR_AUTOMATION");
  assert.equal(result.channels.forms.sites[0]?.browserStage?.responsibleParty, "OUR_AUTOMATION");
  assert.equal(result.channels.forms.sites[1]?.browserStage?.schemaVersion, 2);
  assert.equal(result.channels.forms.sites[1]?.browserStage?.category, "NETWORK_INFRASTRUCTURE");
});

test("analytics recovers one unreferenced browser artifact and reports ambiguous candidates", async () => {
  const runPath = join(temporaryDirectory, "browser-artifact-fallback");
  const uniqueSite = join(runPath, "001");
  const uniqueDebug = join(uniqueSite, "deep-debug", "only-run", "browser");
  await mkdir(uniqueDebug, { recursive: true });
  await writeFile(join(uniqueDebug, "browser-stage.json"), JSON.stringify(stage({
    outcome: "LOADED",
    mainDocumentReceived: true,
    mainDocumentStatus: 200,
    content: {
      inspected: true,
      meaningfulContent: true,
      accessRestrictionIndicators: [],
      pageQualityIndicators: [],
    },
  })), "utf8");
  await writeFile(join(uniqueSite, "deep-debug.txt"), [
    "==================== RUN ====================",
    "Website: https://unique.test/",
    "",
    "==================== RESULT ====================",
    "Status: FAILED",
    "Reason: Full website workflow timed out during contact-channel coordination.",
    "Failure kind: runtime.error",
  ].join("\n"), "utf8");

  const ambiguousSite = join(runPath, "002");
  await mkdir(ambiguousSite, { recursive: true });
  await writeFile(join(ambiguousSite, "deep-debug.txt"), [
    "==================== RUN ====================",
    "Website: https://ambiguous.test/",
    "",
    "==================== RESULT ====================",
    "Status: FAILED",
    "Failure kind: runtime.error",
  ].join("\n"), "utf8");
  for (const name of ["first", "second"]) {
    const browser = join(ambiguousSite, "deep-debug", name, "browser");
    await mkdir(browser, { recursive: true });
    await writeFile(join(browser, "browser-stage.json"), JSON.stringify(stage()), "utf8");
  }

  const { result } = await analyzeRun(runPath, { writeOutputs: false });
  assert.equal(result.channels.forms.sites.find((site) => site.id === "001")?.browserStage?.outcome, "LOADED");
  assert.equal(result.channels.forms.sites.find((site) => site.id === "002")?.browserStage, undefined);
  assert.ok(result.errors.some((error) => error.code === "ambiguous_browser_stage_artifacts"));
});

test("browser analytics normalizes legacy status precedence and reports usable KPIs", async () => {
  const runPath = join(temporaryDirectory, "browser-legacy-normalization");
  const fixtures = [
    { ...stage({
      outcome: "FAILED",
      category: "OUR_AUTOMATION",
      responsibleParty: "OUR_AUTOMATION",
      subcategory: "usable_navigation_misclassified_as_failure",
      mainDocumentReceived: true,
      mainDocumentStatus: 403,
      content: { inspected: true, meaningfulContent: true, accessRestrictionIndicators: [], pageQualityIndicators: [] },
    }), schemaVersion: 2 },
    { ...stage({
      outcome: "FAILED",
      category: "ACCESS_RESTRICTION",
      responsibleParty: "ACCESS_RESTRICTION",
      subcategory: "http_525",
      mainDocumentReceived: true,
      mainDocumentStatus: 525,
    }), schemaVersion: 2 },
    { ...stage({ outcome: "LOADED", mainDocumentReceived: true, mainDocumentStatus: 404 }), schemaVersion: 2 },
    { ...stage({
      outcome: "LOADED",
      mainDocumentReceived: true,
      mainDocumentStatus: 200,
      content: { inspected: true, meaningfulContent: true, accessRestrictionIndicators: [], pageQualityIndicators: [] },
    }), schemaVersion: 2 },
  ];
  for (const [index, artifact] of fixtures.entries()) {
    const site = join(runPath, String(index + 1).padStart(3, "0"));
    const browser = join(site, "deep-debug", "run", "browser");
    const artifactPath = join(browser, "browser-stage.json");
    await mkdir(browser, { recursive: true });
    await writeFile(artifactPath, JSON.stringify(artifact), "utf8");
    await writeFile(join(site, "result.txt"), [
      "==================== RUN ====================",
      `Website: https://legacy-${index + 1}.test/`,
      "",
      "==================== BROWSER STAGE ====================",
      "Entered: yes",
      `Outcome: ${artifact.outcome}`,
      `Browser-stage artifact: ${artifactPath}`,
      "",
      "==================== RESULT ====================",
      `Status: ${artifact.outcome === "FAILED" ? "FAILED" : "SUCCESS"}`,
    ].join("\n"), "utf8");
  }

  const analysis = await analyzeRun(runPath);
  const summary = JSON.parse(await readFile(
    join(analysis.latestDirectory!, "stages", "browser", "browser-stage-summary.json"),
    "utf8",
  )) as {
    schemaVersion: number;
    categoryCounts: Record<string, number>;
    kpis: Record<string, number>;
  };
  assert.equal(summary.schemaVersion, 3);
  assert.equal(summary.categoryCounts.ACCESS_RESTRICTION, 1);
  assert.equal(summary.categoryCounts.DESTINATION_WEBSITE, 1);
  assert.equal(summary.categoryCounts.OUR_AUTOMATION, 0);
  assert.equal(summary.kpis.usablePages, 1);
  assert.equal(summary.kpis.falseLoaded, 1);
  assert.equal(summary.kpis.transportLoaded, 4);
  assert.equal(summary.kpis.preBrowser, 0);
});

async function runSite(
  pathname: string,
  name: string,
  runMode: "production" | "deep-debug",
): Promise<ContactOutreachOutcome> {
  const directory = join(temporaryDirectory, name);
  await mkdir(directory, { recursive: true });
  const inputPath = join(directory, "input.json");
  const outputPath = join(directory, `${runMode}.txt`);
  await writeFile(
    inputPath,
    `${JSON.stringify({ websiteUrl: `${origin}${pathname}`, ...CONTACT_VALUES })}\n`,
    "utf8",
  );
  return run_contact_outreach_workflow(inputPath, {
    runMode,
    outputPath,
    engine: "playwright",
  });
}

async function openBrowserStage(
  path: string,
  recovery: "on" | "off" = "off",
): Promise<BrowserStageResult> {
  const session = await open_target_website(
    { websiteUrl: `${origin}${path}`, ...CONTACT_VALUES },
    {
      allowNavigationFailure: true,
      environment: { ...process.env, CONTACT_FORM_BROWSER_RECOVERY: recovery },
      redactionValues: Object.values(CONTACT_VALUES),
    },
  );
  try {
    assert.ok(session.browserStage);
    return session.browserStage;
  } finally {
    await session.close();
  }
}

async function writeHistoricalReport(
  runPath: string,
  id: number,
  reason: string,
  failureKind: string,
): Promise<void> {
  const directory = join(runPath, String(id).padStart(3, "0"));
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "deep-debug.txt"),
    [
      "==================== RUN ====================",
      `Website: https://historical-${id}.test/`,
      "",
      "==================== RESULT ====================",
      "Status: FAILED",
      `Reason: ${reason}`,
      `Failure kind: ${failureKind}`,
      "",
      "==================== DISCOVERY ====================",
      "Assessment: site_inspection_blocked",
      "Presence evidence strength: none",
      "Search coverage: blocked",
      `Discovery description: ${reason}`,
      "",
    ].join("\n"),
    "utf8",
  );
}

function outcome(websiteUrl: string, browserStage?: BrowserStageResult): ContactOutreachOutcome {
  return {
    websiteUrl,
    executionStatus: "RUN_FAILED",
    status: "FAILED",
    channels: {
      forms: {
        websiteUrl,
        contactPageFound: false,
        formFound: false,
        populatedFields: [],
        submissionAttempted: false,
        submissionConfirmed: false,
        status: "FAILED",
      },
      emails: {
        websiteUrl,
        status: "FAILED",
        emails: [],
        plannedPageCount: 0,
        inspectedPages: [],
        failedPages: [],
      },
      meetings: {
        websiteUrl,
        status: "FAILED",
        meetingLinks: [],
        plannedPageCount: 0,
        inspectedPages: [],
        failedPages: [],
      },
    },
    ...(browserStage ? { browserStage } : {}),
  };
}

function stage(overrides: Partial<BrowserStageResult> = {}): BrowserStageResult {
  return {
    schemaVersion: 3,
    entered: true,
    outcome: "FAILED",
    originalUrl: "https://fixture.test/",
    normalizedUrl: "https://fixture.test/",
    finalUrl: "https://fixture.test/",
    startedAt: "2026-08-10T00:00:00.000Z",
    finishedAt: "2026-08-10T00:00:01.000Z",
    durationMs: 1_000,
    phase: "INITIAL_NAVIGATION",
    operation: "page.goto",
    attempt: 1,
    timeoutMs: 15_000,
    waitUntil: "commit",
    navigationAttempts: [],
    selectedCandidateKind: "ORIGINAL",
    selectedCandidate: { attempt: 1, kind: "ORIGINAL", url: "https://fixture.test/" },
    recoveryEnabled: false,
    recoveryEligible: false,
    recovered: false,
    preflightEvidence: [],
    pageQuality: "UNUSABLE",
    pageQualityEvidence: [],
    securityEvidence: {
      scheme: "https",
      cleartext: false,
      tlsRequired: true,
      formSubmissionAllowed: true,
    },
    redirectChain: [],
    navigationStartedAt: "2026-08-10T00:00:00.000Z",
    navigationFinishedAt: "2026-08-10T00:00:01.000Z",
    timeline: [],
    mainDocumentRequested: false,
    mainDocumentReceived: false,
    responseHeadersReceived: false,
    transportEvidenceBasis: "UNAVAILABLE",
    content: {
      inspected: false,
      meaningfulContent: false,
      accessRestrictionIndicators: [],
      pageQualityIndicators: [],
    },
    health: {
      browserConnected: true,
      pageClosed: false,
      browserDisconnectedObserved: false,
      contextClosedObserved: false,
      pageCrashObserved: false,
      pageCloseObserved: false,
    },
    proxyConfigured: false,
    runtime: {
      pid: 1,
      node: process.version,
      platform: process.platform,
      rssBytes: 1,
      heapUsedBytes: 1,
      userCpuMicros: 1,
      systemCpuMicros: 1,
    },
    resourceSnapshots: [],
    evidence: [],
    contradictions: [],
    missingEvidence: [],
    ...overrides,
  };
}
