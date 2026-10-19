import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { chromium } from "playwright";
import { analyzeRun } from "../src/contact_form_analytics/contact_form_run_analyzer.js";
import { renderMermaidReport } from "../src/contact_form_analytics/report_writer.js";
import {
  buildBrowserDiscoverySignalDashboardData,
  renderBrowserDiscoverySignalsHtml,
} from "../src/contact_form_analytics/browser_discovery_signal_dashboard.js";
import {
  buildSignalDashboardData,
  renderSignalDashboardHtml,
} from "../src/contact_form_analytics/signal_dashboard.js";

const makeRun = async (): Promise<string> => mkdtemp(path.join(os.tmpdir(), "contact-form-analytics-"));

const siteDirectory = async (runPath: string, id: number): Promise<string> => {
  const directory = path.join(runPath, String(id).padStart(3, "0"));
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, `input-id-${id}.json`),
    JSON.stringify({ id, websiteUrl: `https://site-${id}.test/`, name: "Test", email: "test@example.test", message: "Hello" }),
  );
  return directory;
};

interface DiscoveryFixture {
  assessment: string;
  description?: string;
  coverage?: string;
  strength?: string;
}

const writeDiscovery = async (runPath: string, id: number, fixture: DiscoveryFixture): Promise<string> => {
  const directory = await siteDirectory(runPath, id);
  const found = fixture.assessment === "confirmed_form_present";
  const description = fixture.description ?? fixture.assessment;
  await writeFile(
    path.join(directory, "discovery-result.json"),
    JSON.stringify({
      version: 1,
      result: {
        websiteUrl: `https://site-${id}.test/`,
        assessment: fixture.assessment,
        contactFormFound: found,
        presenceEvidenceStrength: fixture.strength ?? (found ? "strong" : "none"),
        searchCoverage: fixture.coverage ?? "complete",
        description,
        evidence: [],
        limitations: [],
      },
    }),
  );
  return directory;
};

interface FullFixture {
  status: "SUCCESS" | "INCONCLUSIVE" | "PARTIAL" | "FAILED";
  failureKind?: string;
  reason?: string;
  assessment?: string;
  attempted?: boolean;
  confirmed?: boolean;
}

interface SignalFullFixture {
  status: "SUCCESS" | "INCONCLUSIVE" | "PARTIAL" | "FAILED";
  failureKind?: string;
  attempted?: boolean;
  confirmed?: boolean;
  disposition?: string;
  confirmation?: string;
  rejection?: string;
  networkSubmission?: string;
  networkRejection?: string;
  providerRule?: string;
  bestRequest?: string;
  networkReason?: string;
  debugPath?: string;
  arithmeticLines?: string[];
  fileName?: "result.txt" | "deep-debug.txt" | "production.txt";
}

const writeFull = async (runPath: string, id: number, fixture: FullFixture): Promise<string> => {
  const directory = await siteDirectory(runPath, id);
  const assessment = fixture.assessment ?? "confirmed_form_present";
  const report = [
    "==================== RUN ====================",
    "Run mode: production",
    `Website: https://site-${id}.test/`,
    "",
    "==================== RESULT ====================",
    `Status: ${fixture.status}`,
    ...(fixture.reason ? [`Reason: ${fixture.reason}`] : []),
    ...(fixture.failureKind ? [`Failure kind: ${fixture.failureKind}`] : []),
    "",
    "==================== DISCOVERY ====================",
    `Assessment: ${assessment}`,
    `Presence evidence strength: ${assessment === "confirmed_form_present" ? "strong" : "none"}`,
    `Search coverage: ${assessment === "site_inspection_blocked" ? "blocked" : "complete"}`,
    `Discovery description: ${fixture.reason ?? assessment}`,
    "",
    "==================== SUBMISSION ====================",
    `Attempted: ${fixture.attempted ? "yes" : "no"}`,
    `Confirmed: ${fixture.confirmed ? "yes" : "no"}`,
  ].join("\n");
  await writeFile(path.join(directory, "production.txt"), report);
  return directory;
};

const writeBrowserStage = async (
  sitePath: string,
  fixture: {
    outcome: "LOADED" | "LOADED_AFTER_TIMEOUT" | "FAILED";
    category?: "OUR_AUTOMATION" | "DESTINATION_WEBSITE" | "NETWORK_INFRASTRUCTURE";
    subcategory?: string;
    ruleId?: string;
    recovered?: boolean;
  },
): Promise<void> => {
  const browserDirectory = path.join(sitePath, "deep-debug", "run-1", "browser");
  await mkdir(browserDirectory, { recursive: true });
  await writeFile(path.join(browserDirectory, "browser-stage.json"), JSON.stringify({
    schemaVersion: 3,
    entered: true,
    outcome: fixture.outcome,
    phase: "INITIAL_NAVIGATION",
    operation: "page.goto",
    originalUrl: "https://fixture.test/",
    finalUrl: "https://fixture.test/",
    durationMs: 100,
    timeoutMs: 15_000,
    waitUntil: "commit",
    navigationAttempts: [{ attempt: 1 }],
    mainDocumentRequested: true,
    mainDocumentReceived: fixture.outcome !== "FAILED",
    mainDocumentStatus: fixture.outcome === "FAILED" ? null : 200,
    content: { meaningfulContent: fixture.outcome !== "FAILED" },
    health: { browserConnected: true, pageClosed: false },
    category: fixture.category ?? "",
    responsibleParty: fixture.category ?? "",
    subcategory: fixture.subcategory ?? "",
    confidence: "HIGH",
    ruleId: fixture.ruleId ?? "",
    reason: fixture.subcategory ?? "browser fixture",
    classificationBasis: "DIRECT",
    strongestSupportingEvidence: "fixture evidence",
    strongestEvidenceAgainst: "none",
    missingEvidence: [],
    pageQuality: fixture.outcome === "FAILED" ? "" : "USABLE",
    recoveryEligible: fixture.recovered ?? false,
    recovered: fixture.recovered ?? false,
  }));
};

const writeSignalFull = async (
  runPath: string,
  id: number,
  fixture: SignalFullFixture,
): Promise<string> => {
  const directory = await siteDirectory(runPath, id);
  const report = [
    "==================== RUN ====================",
    "Run mode: deep-debug",
    `Website: https://site-${id}.test/`,
    "",
    "==================== RESULT ====================",
    `Status: ${fixture.status}`,
    ...(fixture.failureKind ? [`Failure kind: ${fixture.failureKind}`] : []),
    "",
    "==================== DISCOVERY ====================",
    "Assessment: confirmed_form_present",
    "Presence evidence strength: strong",
    "Search coverage: complete",
    "Discovery description: test form",
    "",
    "==================== SUBMISSION ====================",
    `Attempted: ${fixture.attempted === false ? "no" : "yes"}`,
    `Confirmed: ${fixture.confirmed ? "yes" : "no"}`,
    ...(fixture.disposition ? [`Post-click disposition: ${fixture.disposition}`] : []),
    ...(fixture.rejection ? [`Rejection evidence: ${fixture.rejection}`] : []),
    `Confirmation evidence: ${fixture.confirmation ?? "none"}`,
    ...(fixture.arithmeticLines ?? []),
    "",
    "==================== NETWORK ====================",
    `Network submission evidence: ${fixture.networkSubmission ?? "no (none)"}`,
    `Network rejection evidence: ${fixture.networkRejection ?? "no"}`,
    ...(fixture.providerRule ? [`Network provider rule: ${fixture.providerRule}`] : []),
    `Best submission request: ${fixture.bestRequest ?? "none"}`,
    `Network evidence reason: ${fixture.networkReason ?? "no form-like post-click network request was found"}`,
    ...(fixture.debugPath
      ? [
          "",
          "==================== ARTIFACTS ====================",
          `Debug artifacts: ${fixture.debugPath}`,
        ]
      : []),
  ].join("\n");
  await writeFile(path.join(directory, fixture.fileName ?? "result.txt"), report);
  return directory;
};

const writeConfirmationEvents = async (
  debugDirectory: string,
  event: Record<string, unknown>,
  malformedLine = false,
  format: "legacy" | "gzip" = "legacy",
): Promise<void> => {
  await mkdir(
    format === "legacy" ? path.join(debugDirectory, "confirmation") : debugDirectory,
    { recursive: true },
  );
  await writeFile(path.join(debugDirectory, "submission-debug.json"), "{}");
  const confirmationLine = JSON.stringify({
      stage: "confirmation",
      operation: "wait-for-submission-confirmation",
      data: event,
    });
  if (format === "gzip") {
    const timeline = [
      JSON.stringify({ stage: "runtime", operation: "unrelated-runtime-event" }),
      confirmationLine,
      ...(malformedLine ? ["{bad-json"] : []),
    ].join("\n") + "\n";
    await writeFile(path.join(debugDirectory, "timeline.jsonl.gz"), gzipSync(timeline));
  } else {
    await writeFile(
      path.join(debugDirectory, "confirmation", "events.jsonl"),
      `${confirmationLine}\n${malformedLine ? "{bad-json\n" : ""}`,
    );
  }
};

test("deep-debug report is accepted as a full primary artifact", async () => {
  const runPath = await makeRun();
  await writeSignalFull(runPath, 1, {
    status: "FAILED",
    failureKind: "discovery.no_form",
    attempted: false,
    fileName: "deep-debug.txt",
  });

  const { result } = await analyzeRun(runPath, { writeOutputs: false });
  const site = result.channels.forms.sites[0];

  assert.equal(result.channels.forms.counts.processed, 1);
  assert.equal(result.channels.forms.counts.incomplete, 0);
  assert.equal(result.channels.forms.counts.stopped, 1);
  assert.equal(site?.mode, "full");
  assert.equal(site?.status, "FAILED");
  assert.match(site?.sourcePaths.join("\n") ?? "", /deep-debug\.txt$/m);
  assert.equal(result.errors.some((error) => error.code === "missing_primary_result"), false);
});

test("schema-v2 discovery observability aggregates dispositions and contradictions", async () => {
  const runPath = await makeRun();
  const directory = await writeFull(runPath, 1, {
    status: "FAILED",
    failureKind: "discovery.rejected_form",
    assessment: "strong_form_evidence",
  });
  const debugDirectory = path.join(directory, "deep-debug", "run-1");
  await mkdir(debugDirectory, { recursive: true });
  await writeFile(path.join(debugDirectory, "discovery-debug.json"), JSON.stringify({
    version: 2,
    summary: {
      diagnosticDisposition: "probable_missed_form",
      assessmentRuleId: "DISCOVERY-EVIDENCE-STRONG-INDIRECT",
      inspectionAttempts: [{
        inspectionId: "inspection-1",
        pageQuality: "error_page",
        screenshotPath: "discovery-failure.jpeg",
      }],
      candidates: [{
        candidateId: "candidate-1",
        ruleId: "DISCOVERY-REJECT-NO-EMAIL",
        signals: { hasSubmit: true, visibleControlCount: 0 },
      }],
      evidence: [{ evidenceId: "evidence-1" }],
      attemptedRoutes: [{ result: "opened", diagnosticResult: "http_error" }],
      coverageAssessment: { incompleteReasons: ["http_error: /contact"] },
    },
  }));

  const { result, latestDirectory } = await analyzeRun(runPath, {
    generatedAt: new Date("2026-01-01T00:00:00.000Z"),
  });
  const observability = result.channels.forms.discoveryObservability;
  assert.equal(observability.availableSites.count, 1);
  assert.equal(observability.dispositions.probable_missed_form.count, 1);
  assert.equal(observability.routeOutcomes.http_error?.count, 1);
  assert.equal(observability.candidateRules["DISCOVERY-REJECT-NO-EMAIL"]?.count, 1);
  assert.equal(observability.contradictions.opened_route_with_http_error?.count, 1);
  assert.equal(observability.contradictions.submit_reported_with_zero_visible_controls?.count, 1);
  assert.ok(latestDirectory);
  assert.match(
    await readFile(path.join(latestDirectory!, "channels", "forms", "discovery-observability-sites.csv"), "utf8"),
    /inspection-1.*candidate-1.*evidence-1/,
  );
});

test("Discovery mode classifies every assessment without double-counting", async () => {
  const runPath = await makeRun();
  const assessments: DiscoveryFixture[] = [
    { assessment: "confirmed_form_present" },
    { assessment: "strong_form_evidence", strength: "strong", coverage: "partial" },
    { assessment: "possible_form_evidence", strength: "weak", coverage: "partial" },
    { assessment: "contact_channel_without_form", description: "Contact page contains only a mailto email address." },
    { assessment: "no_form_observed_after_complete_search" },
    { assessment: "no_form_observed_after_limited_search", coverage: "partial" },
    {
      assessment: "site_inspection_blocked",
      coverage: "blocked",
      description: "Website inspection was blocked before discovery began: net::ERR_NAME_NOT_RESOLVED",
    },
  ];
  for (let index = 0; index < assessments.length; index += 1) {
    const fixture = assessments[index];
    assert.ok(fixture);
    await writeDiscovery(runPath, index + 1, fixture);
  }
  await writeFile(path.join(runPath, "summary.json"), JSON.stringify({ workflowMode: "discovery", selectedCount: 20, completedCount: 999 }));

  const { result } = await analyzeRun(runPath, { writeOutputs: false });
  const forms = result.channels.forms;
  assert.equal(result.runMode, "discovery");
  assert.deepEqual(forms.counts, {
    planned: 20,
    processed: 7,
    completed: 0,
    qualified: 1,
    stopped: 6,
    incomplete: 0,
    notStarted: 13,
    terminalResults: 7,
  });
  assert.equal(forms.finalAttribution.workflow_attributable.count, 0);
  assert.equal(forms.finalAttribution.non_workflow_attributable.count, 3);
  assert.equal(forms.finalAttribution.indeterminate.count, 3);
  assert.equal(forms.sites.find((site) => site.id === "004")?.subcategory, "email_only");
  assert.equal(forms.sites.find((site) => site.id === "007")?.terminalStage, "browser");
  assert.equal(forms.sites.find((site) => site.id === "001")?.stageStates.population, "not_applicable");
  assert.equal(forms.sites.find((site) => site.id === "001")?.stageStates.submission, "not_applicable");
  assert.equal(forms.reconciliation.processedEqualsStates, true);
  assert.equal(forms.reconciliation.stoppedEqualsAttributions, true);
  assert.equal(forms.reconciliation.stageSubcategoriesDoNotDoubleCount, true);
});

test("Full mode attributes browser, population, submission, partial, and incomplete outcomes", async () => {
  const runPath = await makeRun();
  await writeFull(runPath, 1, { status: "SUCCESS", attempted: true, confirmed: true });
  const successDirectory = path.join(runPath, "001");
  await writeFile(path.join(successDirectory, "submission-debug.json"), JSON.stringify({ captcha: { present: false }, warning: "timeout" }));
  await writeFull(runPath, 2, {
    status: "FAILED",
    failureKind: "navigation.failed",
    reason: "page.goto: net::ERR_NAME_NOT_RESOLVED",
    assessment: "site_inspection_blocked",
  });
  await writeFull(runPath, 3, {
    status: "FAILED",
    failureKind: "navigation.failed",
    reason: "page.goto: Timeout 15000ms exceeded",
    assessment: "site_inspection_blocked",
  });
  await writeFull(runPath, 4, {
    status: "FAILED",
    failureKind: "population.blocked",
    reason: "Required message field could not be populated",
  });
  await writeFull(runPath, 5, {
    status: "FAILED",
    failureKind: "submission.captcha",
    reason: "CAPTCHA physically blocked submission",
    attempted: true,
  });
  const partialDirectory = await writeFull(runPath, 6, {
    status: "PARTIAL",
    failureKind: "submission.unconfirmed",
    reason: "Submission was attempted, but no explicit confirmation appeared",
    attempted: true,
  });
  await writeFile(path.join(partialDirectory, "submission-debug.json"), JSON.stringify({ captcha: { present: false } }));
  await siteDirectory(runPath, 7);

  const { result } = await analyzeRun(runPath, { writeOutputs: false });
  const forms = result.channels.forms;
  assert.equal(forms.counts.completed, 1);
  assert.equal(forms.counts.stopped, 5);
  assert.equal(forms.counts.incomplete, 1);
  assert.equal(forms.finalAttribution.workflow_attributable.count, 1);
  assert.equal(forms.finalAttribution.non_workflow_attributable.count, 2);
  assert.equal(forms.finalAttribution.indeterminate.count, 2);
  assert.equal(forms.sites.find((site) => site.id === "001")?.ruleId, "RPT-FULL-SUCCESS");
  assert.equal(forms.sites.find((site) => site.id === "003")?.subcategory, "navigation_timeout");
  assert.equal(forms.sites.find((site) => site.id === "004")?.terminalStage, "population");
  assert.equal(forms.sites.find((site) => site.id === "005")?.causeFamily, "policy_scope_boundary");
  assert.equal(forms.sites.find((site) => site.id === "006")?.subcategory, "submission_unconfirmed");
  assert.equal(forms.sites.find((site) => site.id === "007")?.runState, "incomplete");
  assert.equal(forms.sites.find((site) => site.id === "007")?.attribution, "not_applicable");
});

test("legacy Discovery reassessment is conservative, auditable, and leaves v3 decisions intact", async () => {
  const runPath = await makeRun();
  const sites = await Promise.all([1, 2, 3, 4].map((id) => writeFull(runPath, id, {
    status: "FAILED",
    failureKind: "discovery.rejected_form",
    assessment: "possible_form_evidence",
  })));
  const writeDebug = async (
    sitePath: string,
    version: number,
    overrides: Record<string, unknown> = {},
  ): Promise<void> => {
    const debugDirectory = path.join(sitePath, "deep-debug", "run-1");
    await mkdir(debugDirectory, { recursive: true });
    await writeFile(path.join(debugDirectory, "discovery-debug.json"), JSON.stringify({
      version,
      summary: {
        diagnosticDisposition: "possible_missed_form",
        assessmentRuleId: "DISCOVERY-EVIDENCE-POSSIBLE-INDIRECT",
        inspectionAttempts: [{
          inspectionId: "inspection-1",
          pageQuality: "usable",
          navigationOutcome: "not_navigated",
          pageSignals: { contactChannels: [] },
        }],
        candidates: [],
        frames: [],
        interactions: [],
        evidence: [{
          evidenceId: "evidence-1",
          kind: "formLikeNetwork",
          strength: "weak",
        }],
        evidenceNetworkRecords: [{
          ruleId: "DISCOVERY-NETWORK-SEMANTIC",
          providerMatched: false,
          url: "https://telemetry.test/form-data",
        }],
        attemptedRoutes: [],
        coverageAssessment: {
          completeEnoughForNoFormConclusion: true,
          routesSkipped: 0,
          incompleteReasons: [],
        },
        ...overrides,
      },
    }));
  };

  await writeDebug(sites[0]!, 2, {
    candidates: [{ candidateId: "candidate-low", score: 4, accepted: false }],
    evidence: [
      { evidenceId: "evidence-1", kind: "formLikeNetwork", strength: "weak" },
      { evidenceId: "evidence-2", kind: "rejectedForm", strength: "weak" },
    ],
  });
  await writeDebug(sites[1]!, 2, {
    candidates: [{
      candidateId: "candidate-message",
      score: 6,
      accepted: false,
      ruleId: "DISCOVERY-REJECT-NO-SUBMIT",
      reason: "form has no visible submit control",
      controls: [{ tagName: "textarea", type: "textarea" }],
    }],
    evidence: [{ evidenceId: "evidence-2", kind: "rejectedForm", strength: "moderate" }],
    evidenceNetworkRecords: [],
  });
  await writeDebug(sites[2]!, 2, {
    coverageAssessment: {
      completeEnoughForNoFormConclusion: true,
      routesSkipped: 1,
      incompleteReasons: [],
    },
  });
  await writeDebug(sites[3]!, 3, {
    evidenceRulebookVersion: "2.0.0",
    assessmentRuleId: "DISCOVERY-EVIDENCE-POSSIBLE-STRUCTURAL",
  });

  const { result, latestDirectory } = await analyzeRun(runPath, {
    generatedAt: new Date("2026-01-02T00:00:00.000Z"),
  });
  const byId = new Map(result.channels.forms.sites.map((site) => [site.numericId, site]));
  assert.equal(byId.get(1)?.discoveryAssessment, "no_form_observed_after_complete_search");
  assert.equal(byId.get(1)?.discoveryReassessment?.changed, true);
  assert.equal(byId.get(1)?.discoveryReassessment?.recordedAssessment, "possible_form_evidence");
  assert.deepEqual(byId.get(1)?.discoveryReassessment?.ignoredEvidenceRuleIds, [
    "DISCOVERY-NETWORK-SEMANTIC",
  ]);
  assert.equal(byId.get(2)?.discoveryAssessment, "possible_form_evidence");
  assert.match(byId.get(2)?.discoveryReassessment?.reasons.join(" ") ?? "", /high-quality form candidate/i);
  assert.equal(byId.get(3)?.discoveryAssessment, "possible_form_evidence");
  assert.match(byId.get(3)?.discoveryReassessment?.reasons.join(" ") ?? "", /skipped one or more routes/i);
  assert.equal(byId.get(4)?.discoveryReassessment?.sourceSchemaVersion, 3);
  assert.equal(byId.get(4)?.discoveryReassessment?.changed, false);

  const discovery = result.channels.forms.stages.find((stage) => stage.stage === "discovery");
  assert.equal(discovery?.attribution.non_workflow_attributable.count, 1);
  assert.equal(discovery?.attribution.indeterminate.count, 3);
  assert.ok(latestDirectory);
  const csv = await readFile(path.join(
    latestDirectory!, "channels", "forms", "discovery-reassessment-sites.csv",
  ), "utf8");
  assert.match(csv, /recorded_assessment,effective_assessment/);
  assert.match(csv, /possible_form_evidence,no_form_observed_after_complete_search/);
  assert.match(csv, /DISCOVERY-REASSESSMENT-V2-CONSERVATIVE-NO-FORM/);
});

test("Mermaid funnel uses stage-specific explanations and highlights automation-attributable stops", async () => {
  const runPath = await makeRun();
  await writeFull(runPath, 1, { status: "SUCCESS", attempted: true, confirmed: true });
  await writeFull(runPath, 2, {
    status: "FAILED",
    failureKind: "navigation.failed",
    reason: "Browser launch failure prevented navigation",
    assessment: "site_inspection_blocked",
  });
  await writeFull(runPath, 3, {
    status: "FAILED",
    failureKind: "navigation.failed",
    reason: "page.goto: net::ERR_NAME_NOT_RESOLVED",
    assessment: "site_inspection_blocked",
  });
  await writeFull(runPath, 4, {
    status: "FAILED",
    failureKind: "navigation.failed",
    reason: "page.goto: Timeout 15000ms exceeded",
    assessment: "site_inspection_blocked",
  });
  await writeFull(runPath, 5, {
    status: "FAILED",
    failureKind: "discovery.no_form",
    reason: "No form was observed after a complete search",
    assessment: "no_form_observed_after_complete_search",
  });
  await writeFull(runPath, 6, {
    status: "FAILED",
    failureKind: "discovery.no_form",
    reason: "Only possible form evidence was observed",
    assessment: "possible_form_evidence",
  });
  await writeFull(runPath, 7, {
    status: "FAILED",
    failureKind: "population.blocked",
    reason: "Required message field could not be populated",
  });
  await writeFull(runPath, 8, {
    status: "FAILED",
    failureKind: "submission.no_control",
    reason: "No actionable submit control was found",
  });
  await writeFull(runPath, 9, {
    status: "FAILED",
    failureKind: "submission.captcha",
    reason: "CAPTCHA physically blocked submission",
    attempted: true,
  });
  await writeFull(runPath, 10, {
    status: "PARTIAL",
    failureKind: "submission.unconfirmed",
    reason: "Submission was attempted, but no explicit confirmation appeared",
    attempted: true,
  });

  const outcome = await analyzeRun(runPath);
  const report = renderMermaidReport(outcome.result.channels.forms);
  assert.match(report, /Automation-related loading issue: 1/);
  assert.match(report, /Link or website is broken/);
  assert.match(report, /Unable to determine the cause/);
  assert.match(report, /No suitable contact form is available/);
  assert.match(report, /Unable to determine whether a suitable form exists/);
  assert.match(report, /The form could not be completed automatically: 1/);
  assert.match(report, /The automation could not complete or verify the submission: 1/);
  assert.match(report, /The website prevented or rejected the submission: 1/);
  assert.match(report, /Unable to determine the submission outcome: 1/);
  assert.doesNotMatch(report, /Automation-related discovery issue/);
  assert.doesNotMatch(report, /(?:Non-workflow|Indeterminate|Workflow-attributable):/);
  assert.match(report, /classDef stage fill:#374151,stroke:#111827,color:#f9fafb/);
  assert.match(report, /\"wrappingWidth\": 600/);
  assert.match(report, /classDef failure fill:#fee2e2,stroke:#b91c1c,color:#1f2937/);
  assert.match(report, /color:#dc2626 !important;font-weight:700/);

  const svg = await readFile(
    path.join(outcome.latestDirectory!, "channels", "forms", "qualitative-statistics-mermaid.svg"),
    "utf8",
  );
  assert.match(svg, /Automation-related loading issue/);
  assert.match(svg, /The form could not be completed automatically/);
  assert.match(svg, /The automation could not complete or verify the submission/);
  assert.match(svg, /(?:#374151|rgb\(55,\s*65,\s*81\))/i);
  assert.match(svg, /(?:#fee2e2|rgb\(254,\s*226,\s*226\))/i);
  assert.match(svg, /(?:#dc2626|rgb\(220,\s*38,\s*38\))/i);
  assert.match(svg, /font-weight:\s*700/i);
});

test("Browser and Discovery outcome explorer partitions entrants and canonicalizes observed signals", async () => {
  const runPath = await makeRun();
  const success = await writeFull(runPath, 1, { status: "SUCCESS", attempted: true, confirmed: true });
  const externalBrowser = await writeFull(runPath, 2, {
    status: "FAILED",
    failureKind: "navigation.failed",
    reason: "page.goto: net::ERR_NAME_NOT_RESOLVED",
    assessment: "site_inspection_blocked",
  });
  const automationBrowser = await writeFull(runPath, 3, {
    status: "FAILED",
    failureKind: "navigation.failed",
    reason: "Browser launch failure prevented navigation",
    assessment: "site_inspection_blocked",
  });
  const unresolvedBrowser = await writeFull(runPath, 4, {
    status: "FAILED",
    failureKind: "navigation.failed",
    reason: "Navigation timed out",
    assessment: "site_inspection_blocked",
  });
  const externalDiscovery = await writeFull(runPath, 5, {
    status: "FAILED",
    failureKind: "discovery.no_form",
    reason: "No form was observed after a complete search",
    assessment: "no_form_observed_after_complete_search",
  });
  const unresolvedDiscovery = await writeFull(runPath, 6, {
    status: "FAILED",
    failureKind: "discovery.no_form",
    reason: "Only possible form evidence was observed",
    assessment: "possible_form_evidence",
  });

  await writeBrowserStage(success, { outcome: "LOADED", recovered: true });
  await writeBrowserStage(externalBrowser, {
    outcome: "FAILED",
    category: "DESTINATION_WEBSITE",
    subcategory: "dns_resolution_failure",
    ruleId: "BRW-DNS-FAILURE",
  });
  await writeBrowserStage(automationBrowser, {
    outcome: "FAILED",
    category: "OUR_AUTOMATION",
    subcategory: "browser_launch_failure",
    ruleId: "BRW-STRUCTURED-OUR-SYSTEM",
  });
  await writeBrowserStage(unresolvedBrowser, {
    outcome: "FAILED",
    category: "NETWORK_INFRASTRUCTURE",
    subcategory: "navigation_timeout",
    ruleId: "BRW-STRUCTURED-NETWORK",
  });

  const writeDiscoveryDebug = async (
    sitePath: string,
    summary: Record<string, unknown>,
  ): Promise<void> => {
    const debugDirectory = path.join(sitePath, "deep-debug", "run-1");
    await mkdir(debugDirectory, { recursive: true });
    await writeFile(
      path.join(debugDirectory, "discovery-debug.json"),
      JSON.stringify({ version: 2, summary }),
    );
  };
  await writeDiscoveryDebug(success, {
    diagnosticDisposition: "confirmed_usable_form",
    assessmentRuleId: "DISCOVERY-EVIDENCE-CONFIRMED-FORM",
    inspectionAttempts: [{ inspectionId: "success-inspection", pageQuality: "usable" }],
    candidates: [{ candidateId: "success-candidate", ruleId: "DISCOVERY-CANDIDATE-COMPLETE" }],
    evidence: [{ evidenceId: "success-evidence" }],
    attemptedRoutes: [{ result: "opened", diagnosticResult: "loaded" }],
    coverageAssessment: { incompleteReasons: [] },
  });
  await writeDiscoveryDebug(externalDiscovery, {
    diagnosticDisposition: "complete_no_usable_form_observed",
    assessmentRuleId: "DISCOVERY-EVIDENCE-COMPLETE-NO-FORM",
    inspectionAttempts: [{ inspectionId: "external-inspection", pageQuality: "usable" }],
    candidates: [{ candidateId: "external-candidate", ruleId: "DISCOVERY-REJECT-NEWSLETTER" }],
    evidence: [],
    attemptedRoutes: [{ result: "opened", diagnosticResult: "loaded" }],
    coverageAssessment: { incompleteReasons: [] },
  });
  await writeDiscoveryDebug(unresolvedDiscovery, {
    diagnosticDisposition: "possible_missed_form",
    assessmentRuleId: "DISCOVERY-EVIDENCE-POSSIBLE-INDIRECT",
    inspectionAttempts: [{ inspectionId: "unresolved-inspection", pageQuality: "error_page" }],
    candidates: [{ candidateId: "unresolved-candidate", ruleId: "DISCOVERY-REJECT-NO-SUBMIT" }],
    evidence: [],
    attemptedRoutes: [{ result: "failed", diagnosticResult: "timed_out" }],
    coverageAssessment: {
      incompleteReasons: [
        "timed_out: https://private-route-one.test/contact",
        "timed_out: https://private-route-two.test/contact",
      ],
    },
  });

  const { result } = await analyzeRun(runPath, { writeOutputs: false });
  const forms = result.channels.forms;
  const data = buildBrowserDiscoverySignalDashboardData(forms);
  assert.deepEqual(data.browser.buckets.map((bucket) => bucket.count), [3, 1, 2]);
  assert.deepEqual(
    data.browser.buckets.map((bucket) => bucket.percentageOfEntrants),
    [50, 16.67, 33.33],
  );
  assert.deepEqual(data.discovery.buckets.map((bucket) => bucket.count), [1, 1, 1]);
  assert.deepEqual(
    data.discovery.buckets.map((bucket) => bucket.percentageOfEntrants),
    [33.33, 33.33, 33.33],
  );
  assert.equal(data.browser.reconciles, true);
  assert.equal(data.discovery.reconciles, true);
  const timeoutSignal = data.discovery.buckets[2].signals.find(
    (signal) => signal.label === "Route timed out" && signal.family === "Incomplete evidence",
  );
  assert.equal(timeoutSignal?.count, 1);
  assert.deepEqual(timeoutSignal?.siteIds, ["006"]);
  for (const section of [data.browser, data.discovery]) {
    for (const bucket of section.buckets) {
      for (const signal of bucket.signals) {
        assert.equal(signal.siteIds.length, new Set(signal.siteIds).size);
        assert.ok(signal.count > 0);
      }
    }
  }

  const incompleteSource = forms.sites[0]!;
  const withIncomplete = {
    ...forms,
    sites: [
      ...forms.sites,
      {
        ...incompleteSource,
        id: "synthetic-incomplete",
        runState: "incomplete" as const,
        terminalStage: "reporting" as const,
        attribution: "not_applicable" as const,
        discoveryAssessment: "",
        stageStates: {
          ...incompleteSource.stageStates,
          browser: "advanced" as const,
          discovery: "incomplete" as const,
        },
      },
    ],
  };
  const incompleteData = buildBrowserDiscoverySignalDashboardData(withIncomplete);
  assert.deepEqual(incompleteData.discovery.buckets.map((bucket) => bucket.count), [1, 1, 2]);
  assert.equal(incompleteData.discovery.reconciles, true);

  const report = renderBrowserDiscoverySignalsHtml(forms);
  assert.match(report, /Browser &amp; Discovery Outcome Explorer/);
  assert.match(report, /Browser continued/);
  assert.match(report, /Destination-related stop/);
  assert.match(report, /Automation involvement cannot be ruled out/);
  assert.match(report, /No suitable form available/);
  assert.match(report, /Route timed out/);
  assert.match(report, /--green-bg: #dcfce7/);
  assert.match(report, /--grey-bg: #f3f4f6/);
  assert.match(report, /--red-bg: #fee2e2/);
  assert.match(report, /aria-expanded="false"/);
  assert.match(report, /data-ready="false"/);
  assert.match(report, /class="explorer-layout"/);
  assert.match(report, /id="outcome-details"/);
  assert.doesNotMatch(report, /scrollIntoView/);
  assert.match(report, /visibleLimit = 50/);
  assert.match(report, /Search by attempt ID or website/);
  assert.doesNotMatch(report, /private-route/);
  assert.deepEqual(
    buildBrowserDiscoverySignalDashboardData(forms),
    buildBrowserDiscoverySignalDashboardData(forms),
  );

  const dashboardPath = path.join(runPath, "browser-discovery-signals.html");
  await writeFile(dashboardPath, report);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    await page.goto(pathToFileURL(dashboardPath).href);
    await page.locator("#browser-discovery-explorer[data-ready='true']").waitFor();
    assert.equal(await page.locator(".outcome-card").count(), 6);
    const sidePanel = page.locator("#outcome-details");
    assert.equal(await sidePanel.isVisible(), true);
    assert.equal(await sidePanel.locator(":scope > *").count(), 0);
    const summaryBox = await page.locator(".summary-column").boundingBox();
    const panelBox = await sidePanel.boundingBox();
    assert.ok(summaryBox && panelBox && panelBox.x > summaryBox.x);

    const browserExternalCard = page.locator("#browser-external_stop");
    await page.evaluate(() => window.scrollTo(0, 120));
    const scrollBeforeSelection = await page.evaluate(() => window.scrollY);
    await browserExternalCard.click();
    assert.equal(await page.evaluate(() => window.scrollY), scrollBeforeSelection);
    assert.equal(await browserExternalCard.getAttribute("aria-expanded"), "true");
    assert.equal(await sidePanel.isVisible(), true);
    assert.equal(await sidePanel.evaluate((element) => element.classList.contains("external")), true);
    assert.equal(
      await sidePanel.evaluate((element) => getComputedStyle(element).backgroundColor),
      await browserExternalCard.evaluate((element) => getComputedStyle(element).backgroundColor),
    );
    const dnsSignal = sidePanel.locator(".signal-button").filter({ hasText: "DNS resolution failure" });
    await dnsSignal.click();
    assert.match(await sidePanel.locator("tbody").innerText(), /002/);
    assert.match(await sidePanel.locator("tbody").innerText(), /https:\/\/site-2\.test\//);
    const search = sidePanel.locator("input[type='search']");
    await search.fill("does-not-exist");
    assert.match(await sidePanel.locator(".empty").innerText(), /No attempts match/);
    await page.keyboard.press("Escape");
    assert.equal(await browserExternalCard.getAttribute("aria-expanded"), "false");
    assert.equal(await sidePanel.isVisible(), true);
    assert.equal(await sidePanel.locator(":scope > *").count(), 0);
    assert.equal(await sidePanel.evaluate((element) => element.classList.contains("is-empty")), true);

    const discoveryUnresolvedCard = page.locator("#discovery-automation_not_ruled_out");
    await discoveryUnresolvedCard.focus();
    await page.keyboard.press("Enter");
    assert.equal(await discoveryUnresolvedCard.getAttribute("aria-expanded"), "true");
    assert.equal(await sidePanel.evaluate((element) => element.classList.contains("unresolved")), true);
    assert.equal(
      await sidePanel.evaluate((element) => getComputedStyle(element).backgroundColor),
      await discoveryUnresolvedCard.evaluate((element) => getComputedStyle(element).backgroundColor),
    );
    assert.equal(
      await sidePanel.locator(".signal-button").filter({ hasText: "Route timed out" }).count() > 0,
      true,
    );

    const externalTemplate = forms.sites.find((site) => site.id === "002")!;
    const manyExternal = {
      ...forms,
      sites: Array.from({ length: 55 }, (_, index) => ({
        ...externalTemplate,
        id: `bulk-${String(index + 1).padStart(3, "0")}`,
        websiteUrl: index === 0
          ? "</script><script>window.__dashboardInjected=true</script>"
          : `https://bulk-${index + 1}.test/`,
      })),
    };
    const manyReport = renderBrowserDiscoverySignalsHtml(manyExternal);
    assert.doesNotMatch(manyReport, /<\/script><script>window\.__dashboardInjected/);
    const manyPath = path.join(runPath, "browser-discovery-signals-many.html");
    await writeFile(manyPath, manyReport);
    await page.goto(pathToFileURL(manyPath).href);
    await page.locator("#browser-discovery-explorer[data-ready='true']").waitFor();
    await page.locator("#browser-external_stop").click();
    await page.locator("#outcome-details .signal-button").filter({ hasText: "DNS resolution failure" }).click();
    assert.equal(await page.locator("#outcome-details tbody tr").count(), 50);
    assert.equal(await page.locator("#outcome-details .show-more").isVisible(), true);
    await page.locator("#outcome-details .show-more").click();
    assert.equal(await page.locator("#outcome-details tbody tr").count(), 55);
    assert.equal(await page.evaluate(() => (window as typeof window & { __dashboardInjected?: boolean }).__dashboardInjected), undefined);
  } finally {
    await browser.close();
  }
});

test("structured contradictions become indeterminate and malformed input remains workflow-attributable", async () => {
  const runPath = await makeRun();
  const conflictingDirectory = await writeDiscovery(runPath, 1, { assessment: "strong_form_evidence", coverage: "partial" });
  await writeFile(
    path.join(conflictingDirectory, "discovery.txt"),
    [
      "Workflow mode: discovery",
      "Website: https://site-1.test/",
      "Assessment: possible_form_evidence",
      "Contact form found: no",
      "Search coverage: partial",
    ].join("\n"),
  );
  const malformedDirectory = await writeFull(runPath, 2, {
    status: "FAILED",
    failureKind: "input.invalid",
    reason: "Input JSON is malformed",
    assessment: "",
  });
  await writeFile(path.join(malformedDirectory, "input-id-2.json"), "{not-json");

  const { result } = await analyzeRun(runPath, { writeOutputs: false });
  const conflict = result.channels.forms.sites.find((site) => site.id === "001");
  assert.equal(conflict?.attribution, "indeterminate");
  assert.equal(conflict?.causeFamily, "conflicting_evidence");
  assert.equal(conflict?.ruleId, "DAT-CONFLICTING-STRUCTURED-EVIDENCE");
  const malformed = result.channels.forms.sites.find((site) => site.id === "002");
  assert.equal(malformed?.attribution, "workflow_attributable");
  assert.equal(malformed?.causeFamily, "input_data_issue");
  assert.equal(malformed?.terminalStage, "input");
});

test("UTF-8 BOM-prefixed input JSON is parsed normally", async () => {
  const runPath = await makeRun();
  const directory = await writeFull(runPath, 1, {
    status: "SUCCESS",
    confirmed: true,
    assessment: "confirmed_form_present",
  });
  await writeFile(
    path.join(directory, "input-id-1.json"),
    `\uFEFF${JSON.stringify({
      id: 1,
      websiteUrl: "https://site-1.test/",
      name: "Test",
      email: "test@example.test",
      message: "Hello",
    })}`,
  );

  const { result } = await analyzeRun(runPath, { writeOutputs: false });
  const site = result.channels.forms.sites.find((candidate) => candidate.id === "001");

  assert.equal(site?.runState, "completed");
  assert.equal(site?.terminalStage, "reporting");
  assert.equal(site?.failureKind, "");
  assert.equal(result.errors.some((error) => error.code === "malformed_input_json"), false);
});

test("submission signal analytics are multi-label, strict about negatives, and debug-enriched", async () => {
  const runPath = await makeRun();
  const successTextDirectory = path.join(runPath, "001", "deep-debug", "success-text");
  await writeSignalFull(runPath, 1, {
    status: "SUCCESS",
    confirmed: true,
    disposition: "confirmed",
    confirmation: "success text",
    networkSubmission: "yes (strong)",
    providerRule: "existing-known-form-service",
    bestRequest: "POST 200 https://forms.test/submit",
    networkReason: "a form-like post-click request returned a successful HTTP status",
    debugPath: successTextDirectory,
  });
  await writeConfirmationEvents(successTextDirectory, {
    evidence: "successText",
    rejectionEvidence: [],
    newMessageCandidates: [
      { text: "  Thank you!   Your message was received.  " },
      { text: "Thank you! Your message was received." },
    ],
  }, false, "gzip");

  const contradictoryDirectory = path.join(runPath, "002", "deep-debug", "contradictory");
  await writeSignalFull(runPath, 2, {
    status: "PARTIAL",
    failureKind: "submission.contradictory",
    disposition: "contradictory",
    confirmation: "network",
    rejection: "2 (validation, captcha)",
    networkSubmission: "yes (strong)",
    networkRejection: "yes",
    providerRule: "oscar-campus-form-submit",
    bestRequest: "POST 200 https://provider.test/forms",
    networkReason:
      "one correlated form request succeeded while another correlated form request was explicitly rejected",
    debugPath: contradictoryDirectory,
  });
  await writeConfirmationEvents(
    contradictoryDirectory,
    {
      evidence: "none",
      rejectionEvidence: [
        {
          source: "visibleMessage",
          category: "captcha",
          excerpt: "CAPTCHA verification failed.",
        },
      ],
      newMessageCandidates: [],
    },
    true,
  );
  await writeFile(
    path.join(contradictoryDirectory, "submission-debug.json"),
    JSON.stringify({
      networkSubmissionEvidence: {
        bestRejectionRequest: {
          method: "POST",
          status: 403,
          url: "https://provider.test/forms/rejection",
        },
      },
    }),
  );

  await writeSignalFull(runPath, 3, {
    status: "FAILED",
    failureKind: "submission.rejected",
    disposition: "rejected",
    rejection: "1 (server)",
    networkSubmission: "yes (strong)",
    networkRejection: "yes",
    providerRule: "formstack-rejection-only",
    bestRequest: "POST 500 https://forms.test/reject",
    networkReason: "form-like request returned non-success HTTP status 500",
  });
  await writeSignalFull(runPath, 4, {
    status: "FAILED",
    failureKind: "submission.captcha",
    disposition: "captchaBlocked",
    rejection: "1 (captcha)",
  });
  await writeSignalFull(runPath, 5, {
    status: "PARTIAL",
    failureKind: "submission.unconfirmed",
    disposition: "unconfirmed",
    networkSubmission: "yes (medium)",
    bestRequest: "POST no-status https://site-5.test/contact",
    networkReason: "form-like request did not receive an HTTP response status",
  });
  await writeSignalFull(runPath, 6, {
    status: "PARTIAL",
    failureKind: "submission.unconfirmed",
    disposition: "unconfirmed",
    networkReason: "only tracking or analytics post-click network requests were found",
  });
  await writeSignalFull(runPath, 7, {
    status: "SUCCESS",
    confirmed: true,
    disposition: "confirmed",
    confirmation: "success URL",
    networkSubmission: "yes (strong)",
    bestRequest: "POST 303 https://site-7.test/contact",
    networkReason: "a form-like post-click request returned a successful HTTP status",
  });
  await writeSignalFull(runPath, 8, {
    status: "SUCCESS",
    confirmed: true,
    disposition: "confirmed",
    confirmation: "AI-verified visible text",
  });
  await writeSignalFull(runPath, 9, {
    status: "FAILED",
    failureKind: "submission.rejected",
    disposition: "rejected",
    rejection: "1 (generic)",
  });
  await writeSignalFull(runPath, 10, {
    status: "PARTIAL",
    failureKind: "submission.unconfirmed",
    disposition: "unconfirmed",
    debugPath: path.join(runPath, "outside-debug"),
    networkReason: "submit click timestamp was unavailable",
  });

  const { result } = await analyzeRun(runPath, { writeOutputs: false });
  const signals = result.channels.forms.signalStatistics;
  assert.equal(signals.rulebookVersion, "2.0.0");
  assert.equal(signals.submissionAttemptedSites.count, 10);
  assert.equal(signals.sitesWithAnyPositiveSignal.count, 4);
  assert.deepEqual(signals.sitesWithAnyPositiveSignal.siteIds, ["001", "002", "007", "008"]);
  assert.equal(signals.sitesWithAnyNegativeSignal.count, 4);
  assert.deepEqual(signals.sitesWithAnyNegativeSignal.siteIds, ["002", "003", "004", "009"]);
  assert.deepEqual(signals.sitesWithBothPolarities.siteIds, ["002"]);

  const positive = (family: string, type: string, value: string) =>
    signals.positive.find(
      (item) =>
        item.signalFamily === family &&
        item.signalType === type &&
        item.signalValue === value,
    );
  const negative = (family: string, type: string, value: string) =>
    signals.negative.find(
      (item) =>
        item.signalFamily === family &&
        item.signalType === type &&
        item.signalValue === value,
    );

  assert.equal(positive("confirmation", "visible_success_text", "success_text")?.count, 1);
  assert.equal(positive("confirmation", "success_url", "success_url")?.count, 1);
  assert.equal(positive("confirmation", "ai_verified_visible_text", "ai_visible_text")?.count, 1);
  const network = positive("confirmation", "network_confirmation", "network");
  assert.equal(network?.count, 3);
  assert.deepEqual(network?.statusCounts, { SUCCESS: 2, INCONCLUSIVE: 0, PARTIAL: 1, FAILED: 0, OTHER: 0 });
  assert.equal(positive("network_http_status", "http_status", "200")?.count, 2);
  assert.equal(positive("network_http_status", "http_status", "303")?.count, 1);
  assert.equal(positive("network_response_class", "http_response_class", "2xx")?.count, 2);
  assert.equal(positive("network_response_class", "http_response_class", "3xx")?.count, 1);
  assert.equal(positive("network_correlation", "correlation_basis", "generic_first_party")?.count, 1);
  assert.equal(positive("network_correlation", "correlation_basis", "known_form_service")?.count, 1);
  assert.equal(positive("network_correlation", "correlation_basis", "provider_rule")?.count, 1);
  assert.equal(
    positive(
      "message_variant",
      "visible_success_text",
      "Thank you! Your message was received.",
    )?.count,
    1,
  );

  assert.equal(negative("rejection_category", "explicit_rejection", "validation")?.count, 1);
  assert.equal(negative("rejection_category", "explicit_rejection", "captcha")?.count, 2);
  assert.equal(negative("rejection_category", "explicit_rejection", "server")?.count, 1);
  assert.equal(negative("rejection_category", "explicit_rejection", "generic")?.count, 1);
  assert.equal(negative("rejection_source", "network_rejection", "network")?.count, 2);
  assert.equal(negative("network_http_status", "http_status", "500")?.count, 1);
  assert.equal(negative("network_http_status", "http_status", "403")?.count, 1);
  assert.equal(
    negative("contradiction", "positive_and_negative_evidence", "contradictory")?.count,
    1,
  );
  assert.equal(negative("captcha", "captcha_blocked", "captcha_blocked")?.count, 1);
  assert.equal(
    negative("message_variant", "captcha", "CAPTCHA verification failed.")?.count,
    1,
  );
  assert.equal(
    negative("rejection_source", "visible_message_rejection", "visible_message")?.count,
    1,
  );
  assert.equal(signals.neutralNetworkObservations.ambiguous_form_like_request?.count, 1);
  assert.equal(signals.neutralNetworkObservations.tracking_only?.count, 1);
  assert.equal(signals.neutralNetworkObservations.submit_click_unavailable?.count, 1);
  assert.ok(!signals.negative.some((item) => item.siteIds.includes("005")));
  assert.ok(!signals.negative.some((item) => item.siteIds.includes("006")));

  assert.equal(signals.coverage.debugPathsReported.count, 3);
  assert.equal(signals.coverage.debugArtifactsAvailable.count, 2);
  assert.equal(signals.coverage.confirmationEventsAvailable.count, 2);
  assert.equal(signals.coverage.messageEnrichedSites.count, 2);
  assert.deepEqual(signals.coverage.malformedDebugArtifacts.siteIds, ["002"]);
  assert.deepEqual(signals.coverage.unsafeDebugPaths.siteIds, ["010"]);
  assert.equal(signals.reconciliation.statisticCountsMatchUniqueSites, true);
  assert.equal(signals.reconciliation.statusCountsMatchStatisticCounts, true);
  assert.equal(signals.reconciliation.signalSitesAreProcessed, true);
  assert.equal(signals.reconciliation.polaritySiteCountsMatchUnions, true);
  assert.ok(result.errors.some((error) => error.code === "malformed_signal_debug_artifact"));
  assert.ok(result.errors.some((error) => error.code === "unsafe_signal_debug_path"));

  const dashboard = buildSignalDashboardData(result.channels.forms);
  assert.deepEqual(
    dashboard.intersections.map((intersection) => ({
      signals: intersection.signalKeys,
      count: intersection.count,
    })),
    [
      { signals: ["ai_text"], count: 1 },
      { signals: ["network"], count: 1 },
      { signals: ["network", "success_url"], count: 1 },
      { signals: ["network", "visible_text"], count: 1 },
    ],
  );
  assert.equal(dashboard.http.find((group) => group.key === "positive")?.count, 3);
  assert.deepEqual(
    dashboard.http
      .find((group) => group.key === "positive")
      ?.classes.flatMap((group) => group.codes.map((code) => [code.code, code.count])),
    [
      ["200", 2],
      ["303", 1],
    ],
  );
  assert.equal(dashboard.http.find((group) => group.key === "negative")?.count, 2);
  const dashboardHtml = renderSignalDashboardHtml(result.channels.forms);
  assert.match(dashboardHtml, /HTTP evidence arc/);
  assert.match(dashboardHtml, /Exact positive-signal combinations/);
  assert.match(dashboardHtml, /Thank you! Your message was received\./);
  assert.doesNotMatch(dashboardHtml, /<script[^>]+src=/);
});

test("known signal types remain visible with zero counts", async () => {
  const runPath = await makeRun();
  await writeSignalFull(runPath, 1, {
    status: "PARTIAL",
    failureKind: "submission.unconfirmed",
    disposition: "unconfirmed",
  });

  const { result } = await analyzeRun(runPath, { writeOutputs: false });
  const signals = result.channels.forms.signalStatistics;
  const ai = signals.positive.find(
    (item) =>
      item.signalFamily === "confirmation" &&
      item.signalType === "ai_verified_visible_text",
  );
  const server = signals.negative.find(
    (item) =>
      item.signalFamily === "rejection_category" &&
      item.signalValue === "server",
  );
  assert.equal(ai?.count, 0);
  assert.deepEqual(ai?.siteIds, []);
  assert.deepEqual(ai?.statusCounts, { SUCCESS: 0, INCONCLUSIVE: 0, PARTIAL: 0, FAILED: 0, OTHER: 0 });
  assert.equal(server?.count, 0);
  assert.equal(signals.sitesWithAnyPositiveSignal.count, 0);
  assert.equal(signals.sitesWithAnyNegativeSignal.count, 0);
});

test("arithmetic signal output is authoritative across result and production reports", async () => {
  const runPath = await makeRun();
  await writeSignalFull(runPath, 1, {
    status: "SUCCESS",
    confirmed: true,
    confirmation: "success text",
    arithmeticLines: [
      "Signal evaluation: evaluated",
      "Signal result: Success 2",
      "Signal score: 2",
      "Signal rulebook version: 1.0.0",
      "Signal polarities: positive=yes, negative=no, both=no",
      "Signal: retained | network_confirmation/provider_correlated_2xx | +2 | status=200",
      "Signal: suppressed | ai_verified_visible_success | +2 | duplicate | Suppressed by highest_positive_score in visible_confirmation.",
      "Unknown signal count: 0",
    ],
  });
  await writeSignalFull(runPath, 5, {
    status: "SUCCESS",
    arithmeticLines: [
      "Signal evaluation: evaluated",
      "Signal result: Success 1",
      "Signal score: 1",
      "Signal rulebook version: 1.0.0",
      "Signal polarities: positive=yes, negative=no, both=no",
      "Signal: retained | network_confirmation/generic_correlated_2xx | +1 | status=200",
      "Unknown signal count: 0",
    ],
  });
  await writeSignalFull(runPath, 5, {
    status: "FAILED",
    fileName: "production.txt",
    arithmeticLines: [
      "Signal evaluation: evaluated",
      "Signal result: Failure -2",
      "Signal score: -2",
      "Signal rulebook version: stale",
      "Signal polarities: positive=no, negative=yes, both=no",
      "Signal: retained | captcha_blocked | -2 | stale production evidence",
      "Unknown signal count: 0",
    ],
  });
  await writeSignalFull(runPath, 2, {
    status: "INCONCLUSIVE",
    failureKind: "submission.inconclusive",
    disposition: "contradictory",
    fileName: "production.txt",
    arithmeticLines: [
      "Signal evaluation: evaluated",
      "Signal result: Inconclusive",
      "Signal score: 0",
      "Signal rulebook version: 1.0.0",
      "Signal polarities: positive=yes, negative=yes, both=yes",
      "Signal: retained | visible_success_text | +3 | visible confirmation",
      "Signal: retained | validation_rejection | -3 | visible rejection",
      "Unknown signal count: 1",
      "Unknown signal: message | fingerprint-2 | unfamiliar response | no rule matched",
    ],
  });
  await writeSignalFull(runPath, 3, {
    status: "FAILED",
    confirmation: "success text",
    arithmeticLines: [
      "Signal evaluation: evaluated",
      "Signal result: Failure -2",
      "Signal rulebook version: 1.0.0",
      "Signal polarities: positive=no, negative=yes, both=no",
      "Signal: retained | captcha_blocked | -2 | blocked",
      "Unknown signal count: 0",
    ],
  });
  await writeSignalFull(runPath, 4, {
    status: "FAILED",
    attempted: false,
    arithmeticLines: [
      "Signal evaluation: not evaluated",
      "Signal evaluation reason: submission was not attempted",
      "Unknown signal count: 0",
    ],
  });

  const { result } = await analyzeRun(runPath, { writeOutputs: false });
  const signals = result.channels.forms.signalStatistics;
  assert.equal(result.schemaVersion, 6);
  assert.deepEqual(signals.arithmetic.evaluated.siteIds, ["001", "002", "005"]);
  assert.deepEqual(signals.arithmetic.notEvaluated.siteIds, ["004"]);
  assert.deepEqual(signals.arithmetic.malformed.siteIds, ["003"]);
  assert.deepEqual(signals.arithmetic.classifications.success.siteIds, ["001", "005"]);
  assert.deepEqual(signals.arithmetic.classifications.inconclusive.siteIds, ["002"]);
  assert.deepEqual(signals.arithmetic.observedWorkflowRulebookVersions, ["1.0.0"]);
  assert.equal(signals.arithmetic.sites.find((site) => site.siteId === "005")?.totalScore, 1);
  assert.equal(signals.positive.find((item) => item.signalType === "network_confirmation")?.count, 1);
  assert.equal(signals.positive.some((item) => item.signalType === "ai_verified_visible_success"), false);
  assert.equal(signals.positive.find((item) => item.signalType === "visible_success_text")?.count, 1);
  assert.equal(signals.negative.find((item) => item.signalType === "validation_rejection")?.count, 1);
  assert.equal(signals.undefinedSignals[0]?.fingerprint, "fingerprint-2");
  assert.equal(signals.undefinedSignals[0]?.count, 1);
  assert.equal(signals.reconciliation.arithmeticLedgerSumsMatch, true);
  assert.equal(signals.reconciliation.arithmeticStatusesMatch, true);
  assert.equal(signals.reconciliation.arithmeticPolaritiesMatch, true);
  assert.equal(signals.reconciliation.arithmeticResultLabelsMatch, true);
  assert.equal(signals.reconciliation.reportedUnknownCountsMatch, true);
  assert.ok(result.errors.some((error) => error.code === "malformed_arithmetic_signal_output"));
  assert.ok(signals.dataQualityWarnings.some((warning) => /malformed arithmetic/i.test(warning)));
});

test("all current failure kinds have deterministic terminal mappings", async () => {
  const runPath = await makeRun();
  const fixtures: Array<FullFixture & { attribution: string; stage: string; causeFamily?: string }> = [
    {
      status: "FAILED",
      failureKind: "input.invalid",
      reason: "Invalid website URL",
      assessment: "",
      attribution: "workflow_attributable",
      stage: "input",
    },
    {
      status: "FAILED",
      failureKind: "navigation.failed",
      reason: "net::ERR_CONNECTION_REFUSED",
      assessment: "site_inspection_blocked",
      attribution: "non_workflow_attributable",
      stage: "browser",
    },
    {
      status: "FAILED",
      failureKind: "outreach.resend_prevented",
      reason: "Outreach was not sent because this website already has a successful outreach record.",
      assessment: "",
      attribution: "non_workflow_attributable",
      causeFamily: "policy_scope_boundary",
      stage: "pre_browser",
    },
    {
      status: "FAILED",
      failureKind: "discovery.no_route",
      reason: "No contact route was found",
      assessment: "",
      attribution: "indeterminate",
      stage: "discovery",
    },
    {
      status: "FAILED",
      failureKind: "discovery.email_only",
      reason: "Only an email address was found",
      assessment: "",
      attribution: "non_workflow_attributable",
      stage: "discovery",
    },
    {
      status: "FAILED",
      failureKind: "discovery.booking_only",
      reason: "Only prohibited cross-origin booking was found",
      assessment: "",
      attribution: "non_workflow_attributable",
      stage: "discovery",
    },
    {
      status: "FAILED",
      failureKind: "discovery.rejected_form",
      reason: "Only rejected newsletter forms were found",
      assessment: "",
      attribution: "non_workflow_attributable",
      stage: "discovery",
    },
    {
      status: "FAILED",
      failureKind: "discovery.llm_unresolved",
      reason: "Stagehand fallback remained unresolved",
      assessment: "",
      attribution: "indeterminate",
      stage: "discovery",
    },
    {
      status: "FAILED",
      failureKind: "population.blocked",
      reason: "Message field could not be populated",
      attribution: "workflow_attributable",
      stage: "population",
    },
    {
      status: "FAILED",
      failureKind: "population.message_not_found",
      reason: "The message field could not be found",
      attribution: "workflow_attributable",
      stage: "population",
    },
    {
      status: "FAILED",
      failureKind: "population.message_fill_failed",
      reason: "The message field did not retain the complete supplied message",
      attribution: "workflow_attributable",
      stage: "population",
    },
    {
      status: "FAILED",
      failureKind: "population.contact_method_missing",
      reason: "Neither an email field nor a phone field was found and filled",
      attribution: "workflow_attributable",
      stage: "population",
    },
    {
      status: "FAILED",
      failureKind: "submission.message_lost",
      reason: "The verified message was lost before submission",
      attribution: "workflow_attributable",
      stage: "submission",
    },
    {
      status: "FAILED",
      failureKind: "submission.message_integrity",
      reason: "The exact message failed final integrity verification",
      attribution: "workflow_attributable",
      stage: "submission",
    },
    {
      status: "FAILED",
      failureKind: "submission.contact_method_lost",
      reason: "The only verified contact method was lost before submission",
      attribution: "workflow_attributable",
      stage: "submission",
    },
    {
      status: "FAILED",
      failureKind: "submission.no_control",
      reason: "No safe submit control was found",
      attempted: true,
      attribution: "workflow_attributable",
      stage: "submission",
    },
    {
      status: "FAILED",
      failureKind: "submission.preflight",
      reason: "Submission preflight did not stabilize",
      attempted: true,
      attribution: "workflow_attributable",
      stage: "submission",
    },
    {
      status: "FAILED",
      failureKind: "submission.validation",
      reason: "Browser form validation blocked submission",
      attempted: true,
      attribution: "workflow_attributable",
      stage: "submission",
    },
    {
      status: "FAILED",
      failureKind: "submission.captcha",
      reason: "CAPTCHA physically blocked submission",
      attempted: true,
      attribution: "non_workflow_attributable",
      stage: "submission",
    },
    {
      status: "PARTIAL",
      failureKind: "submission.unconfirmed",
      reason: "No explicit confirmation appeared",
      attempted: true,
      attribution: "indeterminate",
      stage: "submission",
    },
    {
      status: "FAILED",
      failureKind: "submission.rejected",
      reason: "Submission was explicitly rejected by post-submit validation",
      attempted: true,
      attribution: "workflow_attributable",
      causeFamily: "workflow_logic_issue",
      stage: "submission",
    },
    {
      status: "PARTIAL",
      failureKind: "submission.contradictory",
      reason: "Submission produced contradictory confirmation and rejection evidence",
      attempted: true,
      attribution: "indeterminate",
      causeFamily: "insufficient_evidence",
      stage: "submission",
    },
    {
      status: "FAILED",
      failureKind: "runtime.error",
      reason: "Locator click timed out while populating the form",
      attribution: "workflow_attributable",
      stage: "population",
    },
    {
      status: "FAILED",
      failureKind: "submission.validation",
      reason: "The supplied email value produced a pattern mismatch",
      attempted: true,
      attribution: "workflow_attributable",
      causeFamily: "input_data_issue",
      stage: "submission",
    },
    {
      status: "FAILED",
      failureKind: "runtime.error",
      reason: "Process terminated because Windows system restart was explicitly recorded",
      attribution: "workflow_attributable",
      causeFamily: "execution_environment_issue",
      stage: "reporting",
    },
  ];
  for (let index = 0; index < fixtures.length; index += 1) await writeFull(runPath, index + 1, fixtures[index]!);

  const { result } = await analyzeRun(runPath, { writeOutputs: false });
  assert.equal(result.channels.forms.sites.length, fixtures.length);
  fixtures.forEach((fixture, index) => {
    const site = result.channels.forms.sites.find((candidate) => candidate.numericId === index + 1);
    assert.equal(site?.attribution, fixture.attribution, `failure kind ${fixture.failureKind}`);
    assert.equal(site?.terminalStage, fixture.stage, `failure kind ${fixture.failureKind}`);
    if (fixture.causeFamily) assert.equal(site?.causeFamily, fixture.causeFamily, `failure kind ${fixture.failureKind}`);
  });
  assert.equal(
    result.channels.forms.sites.find(
      (site) => site.failureKind === "submission.rejected",
    )?.subcategory,
    "post_submit_validation_rejection",
  );
  assert.equal(
    result.channels.forms.sites.find(
      (site) => site.failureKind === "submission.contradictory",
    )?.subcategory,
    "submission_contradictory_evidence",
  );
});

test("malformed primary results are reporting failures and mixed modes produce a warning", async () => {
  const runPath = await makeRun();
  const malformedDirectory = await siteDirectory(runPath, 1);
  await writeFile(path.join(malformedDirectory, "discovery-result.json"), "{bad-result");
  await writeFull(runPath, 2, { status: "SUCCESS", attempted: true, confirmed: true });

  const { result } = await analyzeRun(runPath, { writeOutputs: false });
  const malformed = result.channels.forms.sites.find((site) => site.id === "001");
  assert.equal(malformed?.terminalStage, "reporting");
  assert.equal(malformed?.attribution, "workflow_attributable");
  assert.equal(malformed?.causeFamily, "reporting_issue");
  assert.equal(result.runMode, "mixed");
  assert.ok(result.dataQualityWarnings.some((warning) => warning.includes("Mixed or conflicting")));
});

test("analysis writes latest and collision-safe history outputs and ignores stale summaries", async () => {
  const runPath = await makeRun();
  await writeDiscovery(runPath, 1, { assessment: "confirmed_form_present" });
  await writeFile(path.join(runPath, "summary.json"), JSON.stringify({ workflowMode: "discovery", selectedCount: 100, completedCount: 0 }));
  await mkdir(path.join(runPath, "analytics", "999"), { recursive: true });
  await writeFile(path.join(runPath, "analytics", "999", "production.txt"), "Status: SUCCESS");
  const generatedAt = new Date("2026-07-22T12:00:00.000Z");

  const first = await analyzeRun(runPath, { generatedAt });
  const second = await analyzeRun(runPath, { generatedAt });
  assert.equal(first.result.channels.forms.counts.processed, 1);
  assert.equal(first.result.channels.forms.counts.notStarted, 99);
  assert.ok(first.latestDirectory);
  assert.ok(first.historyDirectory);
  assert.ok(second.historyDirectory);
  assert.notEqual(first.historyDirectory, second.historyDirectory);
  assert.deepEqual((await readdir(first.latestDirectory!)).sort(), [
    "channels",
    "errors.csv",
    "outreach-statistics.json",
    "outreach-statistics.txt",
    "site-channel-matrix.csv",
    "stages",
  ]);
  assert.deepEqual(
    (await readdir(path.join(first.latestDirectory!, "stages", "browser"))).sort(),
    [
      "browser-stage-access-restriction.csv",
      "browser-stage-destination-website.csv",
      "browser-stage-failures.csv",
      "browser-stage-network-infrastructure.csv",
      "browser-stage-our-automation.csv",
      "browser-stage-summary.json",
      "browser-stage-summary.txt",
      "browser-stage-undetermined.csv",
    ],
  );
  const formsDirectory = path.join(first.latestDirectory!, "channels", "forms");
  assert.deepEqual((await readdir(formsDirectory)).sort(), [
    "browser-discovery-signals.html",
    "discovery-observability-sites.csv",
    "discovery-observability-statistics.csv",
    "discovery-reassessment-sites.csv",
    "qualitative-statistics-compact.txt",
    "qualitative-statistics-mermaid.md",
    "qualitative-statistics-mermaid.svg",
    "qualitative-statistics-proportional.svg",
    "qualitative-statistics.json",
    "qualitative-statistics.txt",
    "rulebook.json",
    "signals",
    "site-classifications.csv",
    "stage-statistics.csv",
  ]);
  const signalsDirectory = path.join(formsDirectory, "signals");
  assert.deepEqual((await readdir(signalsDirectory)).sort(), [
    "negative-signal-statistics.csv",
    "positive-signal-statistics.csv",
    "signal-dashboard.html",
    "signal-dashboard.png",
    "signal-statistics.json",
    "signal-statistics.txt",
    "site-signal-scores.csv",
    "undefined-signal-statistics.csv",
    "undefined-signal-statistics.json",
    "undefined-signal-statistics.txt",
  ]);
  assert.match(
    await readFile(path.join(signalsDirectory, "site-signal-scores.csv"), "utf8"),
    /site_id,status,evaluation,classification,display_result,total_score/,
  );
  for (const channel of ["emails", "meetings"]) {
    assert.deepEqual(
      (await readdir(path.join(first.latestDirectory!, "channels", channel))).sort(),
      [
        "channel-outcomes.svg",
        "channel-statistics.json",
        "channel-statistics.txt",
        "outcome-statistics.csv",
        "rulebook.json",
        "site-classifications.csv",
      ],
    );
  }
  const json = JSON.parse(await readFile(path.join(first.latestDirectory!, "outreach-statistics.json"), "utf8")) as {
    schemaVersion: number;
    channels: { forms: { rulebookVersion: string } };
  };
  assert.equal(json.schemaVersion, 6);
  assert.equal(json.channels.forms.rulebookVersion, "2.1.0");
  const compactReport = await readFile(path.join(formsDirectory, "qualitative-statistics-compact.txt"), "utf8");
  assert.doesNotMatch(compactReport, /\bSites:/);
  assert.doesNotMatch(compactReport, /\[[0-9]+(?:, [0-9]+)*\]/);
  assert.match(compactReport, /FINAL RESPONSIBILITY ATTRIBUTION/);
  const mermaidReport = await readFile(path.join(formsDirectory, "qualitative-statistics-mermaid.md"), "utf8");
  assert.match(mermaidReport, /```mermaid/);
  assert.match(mermaidReport, /BROWSER -->\|"Browser continued:/);
  assert.match(mermaidReport, /BROWSER -->\|"Stopped at browser:/);
  assert.match(mermaidReport, /DISCOVERY -->\|"Discovery continued:/);
  assert.match(mermaidReport, /DISCOVERY -->\|"Stopped at discovery:/);
  assert.match(mermaidReport, /POPULATION -->\|"Population continued:/);
  assert.match(mermaidReport, /POPULATION -->\|"Stopped at population:/);
  assert.match(mermaidReport, /SUBMISSION -->\|"Confirmed success:/);
  assert.match(mermaidReport, /SUBMISSION -->\|"Submission not confirmed:/);
  assert.doesNotMatch(mermaidReport, /Browser (?:success|failure):/);
  assert.doesNotMatch(mermaidReport, /\bSites:/);
  const mermaidSvg = await readFile(
    path.join(formsDirectory, "qualitative-statistics-mermaid.svg"),
    "utf8",
  );
  assert.match(mermaidSvg, /<svg /);
  assert.match(mermaidSvg, /Browser continued/);
  assert.match(mermaidSvg, /Stopped at browser/);
  assert.match(mermaidSvg, /Confirmed success/);
  assert.match(mermaidSvg, /Submission not confirmed/);
  assert.doesNotMatch(mermaidSvg, /<br>/i);
  assert.match(mermaidSvg, /<br\/>/i);
  const browserDiscoveryReport = await readFile(
    path.join(formsDirectory, "browser-discovery-signals.html"),
    "utf8",
  );
  assert.match(browserDiscoveryReport, /Browser &amp; Discovery Outcome Explorer/);
  assert.match(browserDiscoveryReport, /Browser continued/);
  assert.match(browserDiscoveryReport, /Discovery continued/);
  assert.match(browserDiscoveryReport, /Destination-related stop/);
  assert.match(browserDiscoveryReport, /Automation involvement cannot be ruled out/);
  assert.match(browserDiscoveryReport, /data-ready="false"/);
  const proportionalSvg = await readFile(
    path.join(formsDirectory, "qualitative-statistics-proportional.svg"),
    "utf8",
  );
  assert.match(proportionalSvg, /<svg /);
  assert.match(proportionalSvg, /data-category="success"/);
  assert.match(proportionalSvg, /data-category="failure"/);
  assert.match(proportionalSvg, /data-category="unclear"/);
  assert.match(proportionalSvg, /fill="#16a34a"/);
  assert.match(proportionalSvg, /fill="#dc2626"/);
  assert.match(proportionalSvg, /fill="#6b7280"/);
  const emailSvg = await readFile(
    path.join(first.latestDirectory!, "channels", "emails", "channel-outcomes.svg"),
    "utf8",
  );
  assert.match(emailSvg, /data-outcome="artifact_incomplete"/);
  const matrix = await readFile(path.join(first.latestDirectory!, "site-channel-matrix.csv"), "utf8");
  assert.match(matrix, /form_run_state.*email_outcome/);
  const positiveSignalsCsv = await readFile(
    path.join(signalsDirectory, "positive-signal-statistics.csv"),
    "utf8",
  );
  assert.match(
    positiveSignalsCsv,
    /^signal_family,signal_type,signal_value,description,count,percentage_of_submission_attempts,/,
  );
  const negativeSignalsCsv = await readFile(
    path.join(signalsDirectory, "negative-signal-statistics.csv"),
    "utf8",
  );
  assert.match(
    negativeSignalsCsv,
    /^signal_family,signal_type,signal_value,description,count,percentage_of_submission_attempts,/,
  );
  const signalText = await readFile(path.join(signalsDirectory, "signal-statistics.txt"), "utf8");
  assert.match(signalText, /FORM SUBMISSION SIGNAL STATISTICS/);
  assert.match(signalText, /Neutral or missing evidence is not classified as negative/);
  const signalJson = JSON.parse(
    await readFile(path.join(signalsDirectory, "signal-statistics.json"), "utf8"),
  ) as { rulebookVersion: string; reconciliation: { statisticCountsMatchUniqueSites: boolean } };
  assert.equal(signalJson.rulebookVersion, "2.0.0");
  assert.equal(signalJson.reconciliation.statisticCountsMatchUniqueSites, true);
  const dashboardHtml = await readFile(path.join(signalsDirectory, "signal-dashboard.html"), "utf8");
  assert.match(dashboardHtml, /Form submission signal dashboard/);
  assert.match(dashboardHtml, /HTTP evidence arc/);
  assert.match(dashboardHtml, /Exact positive-signal combinations/);
  assert.match(dashboardHtml, /data-ready/);
  const dashboardPng = await readFile(path.join(signalsDirectory, "signal-dashboard.png"));
  assert.deepEqual([...dashboardPng.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.ok(dashboardPng.length > 10_000);
  const firstHistorySignals = path.join(
    first.historyDirectory!,
    "channels",
    "forms",
    "signals",
  );
  assert.equal(
    await readFile(path.join(firstHistorySignals, "signal-dashboard.html"), "utf8"),
    dashboardHtml,
  );
  assert.deepEqual(
    await readFile(path.join(firstHistorySignals, "signal-dashboard.png")),
    dashboardPng,
  );
  const historyNames = await readdir(path.join(runPath, "analytics", "history"));
  assert.equal(historyNames.length, 2);
});
