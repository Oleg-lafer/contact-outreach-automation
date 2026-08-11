import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
  classify_browser_stage_failure,
  create_browser_stage_run_summary,
  normalize_browser_stage_error,
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
  assert.equal(launch.category, "OUR_SYSTEM_FAILURE");
  assert.equal(launch.responsibleParty, "OUR_SYSTEM");

  const tls = classify_browser_stage_failure(stage({
    mainDocumentRequested: true,
    mainDocumentFailure: "net::ERR_CERT_DATE_INVALID",
    error: { name: "Error", message: "page.goto: net::ERR_CERT_DATE_INVALID" },
  }));
  assert.equal(tls.category, "DESTINATION_FAILURE");
  assert.equal(tls.subcategory, "tls_or_certificate_failure");

  const dns = classify_browser_stage_failure(stage({
    mainDocumentRequested: true,
    mainDocumentFailure: "net::ERR_NAME_NOT_RESOLVED",
    error: { name: "Error", message: "page.goto: net::ERR_NAME_NOT_RESOLVED" },
  }));
  assert.equal(dns.category, "UNDETERMINED");
  assert.equal(dns.responsibleParty, "THIRD_PARTY_PATH");

  const rateLimit = classify_browser_stage_failure(stage({
    mainDocumentRequested: true,
    mainDocumentReceived: true,
    mainDocumentStatus: 429,
  }));
  assert.equal(rateLimit.category, "ACCESS_RESTRICTION");
  assert.equal(rateLimit.responsibleParty, "UNKNOWN");

  const proxy = classify_browser_stage_failure(stage({
    error: { name: "Error", code: "EPROXY", message: "proxy authentication required" },
  }));
  assert.equal(proxy.category, "OUR_SYSTEM_FAILURE");
  assert.equal(proxy.subcategory, "proxy_configuration_or_connection");

  const resources = classify_browser_stage_failure(stage({
    error: { name: "Error", code: "ENOMEM", message: "out of memory" },
  }));
  assert.equal(resources.category, "OUR_SYSTEM_FAILURE");
  assert.equal(resources.subcategory, "local_resource_exhaustion");

  const cdp = classify_browser_stage_failure(stage({ phase: "CDP_CONNECTION" }));
  assert.equal(cdp.category, "OUR_SYSTEM_FAILURE");
  assert.equal(cdp.subcategory, "cdp_connection");

  const redacted = normalize_browser_stage_error(
    new Error(`Failed for ${CONTACT_VALUES.email}: ${"x".repeat(5_000)}`),
    [CONTACT_VALUES.email],
  );
  assert.doesNotMatch(redacted.message, /browser-diagnostic-secret/i);
  assert.ok(redacted.message.length < 2_100);
  assert.match(redacted.stackFingerprint ?? "", /^[a-f0-9]{16}$/);
});

test("HTTP access restrictions and destination outages are classified from main-document evidence", async () => {
  const [forbidden, unavailable] = await Promise.all([
    runSite("/forbidden", "forbidden", "production"),
    runSite("/server-error", "server-error", "deep-debug"),
  ]);
  assert.equal(forbidden.browserStage?.outcome, "FAILED");
  assert.equal(forbidden.browserStage?.category, "ACCESS_RESTRICTION");
  assert.equal(forbidden.browserStage?.mainDocumentStatus, 403);
  assert.equal(unavailable.browserStage?.category, "DESTINATION_FAILURE");
  assert.equal(unavailable.browserStage?.subcategory, "http_5xx");
  assert.equal(unavailable.browserStage?.mainDocumentStatus, 503);
  assert.ok(unavailable.deepDebug);
  assert.ok(unavailable.browserStage?.diagnosticArtifactPath);
  const artifact = await readFile(unavailable.browserStage!.diagnosticArtifactPath!, "utf8");
  const manifest = JSON.parse(
    await readFile(unavailable.deepDebug!.manifestPath, "utf8"),
  ) as { outcome?: { status?: string; channels?: unknown } };
  assert.equal(manifest.outcome?.status, "FAILED");
  assert.equal(manifest.outcome?.channels, undefined);
  assert.doesNotMatch(artifact, new RegExp(CONTACT_VALUES.email, "i"));
  assert.doesNotMatch(artifact, new RegExp(CONTACT_VALUES.phone.replace(/[+]/g, "\\+")));
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
    schemaVersion: 1,
    entered: true,
    outcome: "FAILED",
    originalUrl: "https://fixture.test/",
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
    mainDocumentRequested: false,
    mainDocumentReceived: false,
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
    evidence: [],
    contradictions: [],
    ...overrides,
  };
}
