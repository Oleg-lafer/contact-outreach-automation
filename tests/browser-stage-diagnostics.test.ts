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

const CONTACT_VALUES = {
  name: "Browser Diagnostic Person",
  email: "browser-diagnostic-secret@example.test",
  phone: "+1 202 555 0188",
  message: "Browser diagnostic secret message.",
};

let server: Server;
let origin: string;
let temporaryDirectory: string;

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
    },
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
  assert.equal(unavailable.browserStage?.schemaVersion, 2);
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
  assert.equal(summary.schemaVersion, 2);
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
      artifact: classify_browser_stage_failure(stage({
        mainDocumentFailure: "net::ERR_NAME_NOT_RESOLVED",
      })),
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
    schemaVersion: 2,
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
    waitUntil: "domcontentloaded",
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
