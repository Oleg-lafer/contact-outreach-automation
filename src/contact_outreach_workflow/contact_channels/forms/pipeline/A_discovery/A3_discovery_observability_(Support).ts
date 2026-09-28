import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import type { Page } from "playwright";
import type { DeepDebugContext } from "../../shared_files_forms/deep_debug_types_(Support).js";
import type {
  FormDiscoveryResult,
  DiscoveryAiActionDebug,
  ContactFormCandidateSource,
  DiscoveryDebugSummary,
  DiscoveryFormCandidateDebug,
  DiscoveryInteractionDebug,
  DiscoveryInteractionState,
  DiscoveryRouteAttemptDebug,
} from "../../shared_files_forms/forms_types_(Support).js";
import type { ContactFormAssessment } from "../../shared_files_forms/contact_form_intent_(Deterministic).js";
import type { DiscoveryReadinessResult } from "../../../../shared_files_orchestrator/discovery_readiness_(Deterministic).js";
import { collect_discovery_page_signals } from "./A4_discovery_evidence_(Deterministic).js";
import { replace_unpaired_surrogates } from "../../../../shared_files_orchestrator/unicode_text_(Support).js";

const MAX_INSPECTIONS = 8;
const MAX_CANDIDATES_PER_INSPECTION = 10;
const MAX_CANDIDATES_TOTAL = 30;
const MAX_CONTROLS_PER_CANDIDATE = 20;
const MAX_EVIDENCE_NETWORK_RECORDS = 10;
const MAX_CONTEXT_LENGTH = 500;
const MAX_DISCOVERY_SCREENSHOTS = 4;

export class DiscoveryDebugCollector {
  readonly startingUrl: string;
  readonly enabled: boolean;
  readonly attemptedRoutes: DiscoveryRouteAttemptDebug[] = [];
  readonly candidates: DiscoveryFormCandidateDebug[] = [];
  readonly aiActions: DiscoveryAiActionDebug[] = [];
  readonly interactions: DiscoveryInteractionDebug[] = [];
  readonly inspectionAttempts: NonNullable<DiscoveryDebugSummary["inspectionAttempts"]> = [];
  readonly limits: NonNullable<DiscoveryDebugSummary["limits"]> = {
    maxInspections: MAX_INSPECTIONS,
    maxCandidatesPerInspection: MAX_CANDIDATES_PER_INSPECTION,
    maxCandidatesTotal: MAX_CANDIDATES_TOTAL,
    maxControlsPerCandidate: MAX_CONTROLS_PER_CANDIDATE,
    maxEvidenceNetworkRecords: MAX_EVIDENCE_NETWORK_RECORDS,
    maxContextLength: MAX_CONTEXT_LENGTH,
    maxScreenshots: MAX_DISCOVERY_SCREENSHOTS,
    omittedInspections: 0,
    omittedCandidates: 0,
    omittedControls: 0,
    omittedEvidenceNetworkRecords: 0,
    omittedScreenshots: 0,
  };
  private activeInspectionId?: string;
  private readonly discoveredRouteUrls = new Set<string>();
  private readonly pendingScreenshots: Array<{ inspectionId: string; fingerprint: string; bytes: Buffer }> = [];

  constructor(starting_url: string, enabled = false) {
    this.startingUrl = starting_url;
    this.enabled = enabled;
  }

  recordRoute(record: DiscoveryRouteAttemptDebug): void {
    this.attemptedRoutes.push(record);
  }

  recordDiscoveredRoutes(routes: Array<{ url: string }>): void {
    for (const route of routes) this.discoveredRouteUrls.add(safe_url(route.url));
  }

  get discoveredRouteCount(): number {
    return this.discoveredRouteUrls.size;
  }

  recordCandidate(options: {
    url: string;
    frameUrl: string;
    source: ContactFormCandidateSource | "deterministic";
    assessment: ContactFormAssessment;
    structure?: "nativeForm" | "formLikeContainer" | "unknown";
  }): void {
    const inspection_candidate_count = this.candidates.filter(
      (candidate) => candidate.inspectionId === this.activeInspectionId,
    ).length;
    if (this.candidates.length >= MAX_CANDIDATES_TOTAL || inspection_candidate_count >= MAX_CANDIDATES_PER_INSPECTION) {
      this.limits.omittedCandidates += 1;
      return;
    }
    const diagnostics = options.assessment.diagnostics;
    const candidate_id = `candidate-${this.candidates.length + 1}`;
    this.limits.omittedControls += diagnostics?.omittedControls ?? 0;
    this.candidates.push({
      candidateId: candidate_id,
      ...(this.activeInspectionId ? { inspectionId: this.activeInspectionId } : {}),
      url: options.url,
      frameUrl: options.frameUrl,
      source: options.source,
      structure: options.structure ?? "unknown",
      ...(diagnostics?.domPath ? { domPathHash: createHash("sha256").update(diagnostics.domPath).digest("hex").slice(0, 16) } : {}),
      ...(diagnostics?.tagName ? { tagName: diagnostics.tagName } : {}),
      ...(diagnostics?.action ? { action: safe_url(diagnostics.action) } : {}),
      ...(diagnostics?.method ? { method: diagnostics.method.toUpperCase() } : {}),
      ...(diagnostics?.contextExcerpt ? { contextExcerpt: replace_unpaired_surrogates(diagnostics.contextExcerpt.slice(0, MAX_CONTEXT_LENGTH)) } : {}),
      ...(diagnostics?.controls ? { controls: diagnostics.controls.slice(0, MAX_CONTROLS_PER_CANDIDATE) } : {}),
      ...(diagnostics?.ruleId ? { ruleId: diagnostics.ruleId } : {}),
      ...(diagnostics?.scoreContributions ? { scoreContributions: diagnostics.scoreContributions } : {}),
      score: options.assessment.score,
      classification: options.assessment.classification,
      accepted: options.assessment.accepted,
      reason: options.assessment.reason,
      signals: options.assessment.signals,
    });
    const inspection = this.inspectionAttempts.find((item) => item.inspectionId === this.activeInspectionId);
    if (inspection) inspection.candidateIds.push(candidate_id);
  }

  recordAiAction(record: DiscoveryAiActionDebug): void {
    this.aiActions.push(record);
  }

  recordInteraction(record: DiscoveryInteractionDebug): void {
    this.interactions.push(record);
  }

  async captureInspection(
    page: Page,
    phase: NonNullable<DiscoveryDebugSummary["inspectionAttempts"]>[number]["phase"],
    options: {
      requestedUrl?: string;
      routeLabel?: string;
      routeScore?: number;
      responseStatus?: number;
      navigationOutcome?: NonNullable<DiscoveryDebugSummary["inspectionAttempts"]>[number]["navigationOutcome"];
      navigationError?: string;
      readiness?: DiscoveryReadinessResult;
    } = {},
  ): Promise<string | undefined> {
    if (!this.enabled) return undefined;
    if (this.inspectionAttempts.length >= MAX_INSPECTIONS) {
      this.limits.omittedInspections += 1;
      return undefined;
    }
    const inspection_id = `inspection-${this.inspectionAttempts.length + 1}`;
    this.activeInspectionId = inspection_id;
    const state = await capture_discovery_page_state(page);
    const page_signals = await collect_discovery_page_signals(page).catch(() => ({
      contactContext: false,
      contactChannels: [],
      recognizedFormEmbeds: [],
      contactRevealControls: [],
    }));
    const fingerprint = createHash("sha256")
      .update(`${state.url}|${state.title}|${state.visibleFormCount}|${state.formLikeContainerCount}|${state.contextExcerpt}`)
      .digest("hex").slice(0, 16);
    const requested_url = options.requestedUrl ?? state.url;
    const status = options.responseStatus;
    const default_readiness = {
      startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), elapsedMs: 0,
      domContentLoaded: ["interactive", "complete"].includes(state.readyState),
      visibleContentReady: state.contextExcerpt.length > 0 || state.visibleFormCount > 0,
      networkIdle: "not_checked" as const, readyState: state.readyState, stateChangedDuringSettle: false,
    };
    const readiness = options.readiness ? {
      ...options.readiness,
      domContentLoaded: ["interactive", "complete"].includes(options.readiness.readyState),
    } : default_readiness;
    this.inspectionAttempts.push({
      inspectionId: inspection_id,
      phase,
      capturedAt: new Date().toISOString(),
      requestedUrl: safe_url(requested_url),
      committedUrl: safe_url(state.url),
      finalUrl: safe_url(state.url),
      redirectChain: requested_url === state.url ? [safe_url(state.url)] : [safe_url(requested_url), safe_url(state.url)],
      sameOrigin: safe_origin(state.url) === safe_origin(this.startingUrl),
      navigationOutcome: options.navigationOutcome ?? "not_navigated",
      ...(status !== undefined ? { mainDocumentStatus: status } : {}),
      pageQuality: state.errorPageIndicators.length > 0 ? "error_page" : state.contextExcerpt ? "usable" : "empty",
      ...(options.routeLabel ? { routeLabel: options.routeLabel } : {}),
      ...(options.routeScore !== undefined ? { routeScore: options.routeScore } : {}),
      ...(options.navigationError ? { navigationError: options.navigationError.slice(0, MAX_CONTEXT_LENGTH) } : {}),
      readiness,
      title: state.title,
      language: state.language,
      headingExcerpt: state.headingExcerpt,
      contextExcerpt: state.contextExcerpt,
      errorPageIndicators: state.errorPageIndicators,
      visibleFormCount: state.visibleFormCount,
      formLikeContainerCount: state.formLikeContainerCount,
      visibleDialogCount: state.visibleDialogCount,
      frameCount: page.frames().length,
      pageSignals: page_signals,
      candidateIds: [],
      evidenceIds: [],
      stateFingerprint: fingerprint,
    });
    if (!this.pendingScreenshots.some((item) => item.fingerprint === fingerprint)) {
      if (this.pendingScreenshots.length < MAX_DISCOVERY_SCREENSHOTS || phase === "final") {
        const bytes = await page.screenshot({ type: "jpeg", quality: 70, fullPage: true, animations: "disabled" }).catch(() => undefined);
        if (bytes) {
          if (this.pendingScreenshots.length >= MAX_DISCOVERY_SCREENSHOTS) {
            this.pendingScreenshots.pop();
            this.limits.omittedScreenshots += 1;
          }
          this.pendingScreenshots.push({ inspectionId: inspection_id, fingerprint, bytes });
        }
      } else {
        this.limits.omittedScreenshots += 1;
      }
    }
    return inspection_id;
  }

  async writeFailureScreenshots(absolute_directory: string): Promise<string[]> {
    const paths: string[] = [];
    for (const [index, screenshot] of this.pendingScreenshots.entries()) {
      const filename = index === this.pendingScreenshots.length - 1
        ? "discovery-failure.jpeg"
        : `discovery-${index + 1}-${screenshot.inspectionId}.jpeg`;
      const path = join(absolute_directory, "orchestrator", "screenshots", filename);
      await mkdir(join(absolute_directory, "orchestrator", "screenshots"), { recursive: true });
      await writeFile(path, screenshot.bytes);
      const inspection = this.inspectionAttempts.find((item) => item.inspectionId === screenshot.inspectionId);
      if (inspection) inspection.screenshotPath = path;
      paths.push(path);
    }
    return paths;
  }
}

export async function finalize_discovery_debug(
  page: Page,
  result: FormDiscoveryResult,
  collector: DiscoveryDebugCollector,
  artifact_directory?: string,
  deep_debug?: DeepDebugContext,
): Promise<FormDiscoveryResult> {
  if (!artifact_directory) {
    return result;
  }

  const absolute_directory = resolve(artifact_directory);
  await mkdir(absolute_directory, { recursive: true });
  const report_path = join(absolute_directory, "discovery-debug.json");
  let screenshot_path: string | undefined;
  if (!result.candidate) {
    const inspection_screenshots = await collector.writeFailureScreenshots(absolute_directory);
    for (const path of inspection_screenshots) {
      deep_debug?.record({
        stage: "orchestrator",
        substage: "screenshot",
        operation: "discovery-inspection",
        outcome: "succeeded",
        data: { path, contactValuesMasked: false, format: "jpeg", quality: 70, scope: "full-page" },
      });
    }
    screenshot_path = inspection_screenshots.at(-1);
    if (!screenshot_path && deep_debug) {
      screenshot_path = await deep_debug.captureScreenshot(page, "orchestrator", "discovery-failure", { fullPage: true });
    } else if (!screenshot_path) {
      screenshot_path = join(absolute_directory, "discovery-failure.jpeg");
      await page
        .screenshot({
          path: screenshot_path,
          type: "jpeg",
          quality: 70,
          fullPage: true,
          animations: "disabled",
        })
        .catch(() => {
          screenshot_path = undefined;
        });
    }
  }

  const starting_origin = safe_origin(collector.startingUrl);
  const summary: DiscoveryDebugSummary = {
    reportPath: report_path,
    artifactDirectory: absolute_directory,
    ...(screenshot_path ? { screenshotPath: screenshot_path } : {}),
    screenshotPaths: collector.inspectionAttempts.map((inspection) => inspection.screenshotPath).filter((path): path is string => Boolean(path)),
    startingUrl: collector.startingUrl,
    finalUrl: page.url(),
    finalClassification:
      result.reason ??
      (result.candidate ? "contact form candidate accepted" : "discovery failed"),
    attemptedRoutes: collector.attemptedRoutes,
    candidates: collector.candidates,
    aiActions: collector.aiActions,
    frames: page.frames().map((frame) => ({
      url: frame.url(),
      sameOrigin: safe_origin(frame.url()) === starting_origin,
    })),
    interactions: collector.interactions,
    inspectionAttempts: collector.inspectionAttempts,
    coverageAssessment: coverage_assessment(collector, result),
    diagnosticDisposition: result.candidate
      ? "confirmed_usable_form"
      : collector.inspectionAttempts.some((inspection) => inspection.pageSignals.recognizedFormEmbeds.length > 0)
        ? "probable_missed_form"
        : collector.candidates.some((candidate) => candidate.signals.hasContactContext || candidate.signals.hasMessage)
          ? "possible_missed_form"
          : collector.inspectionAttempts.some((inspection) =>
              inspection.navigationOutcome === "navigation_failed" || inspection.navigationOutcome === "timed_out")
            ? "inspection_incomplete"
            : "complete_no_usable_form_observed",
    limits: collector.limits,
  };
  await writeFile(
    report_path,
    `${JSON.stringify({ version: 2, generatedAt: new Date().toISOString(), summary }, null, 2)}\n`,
    "utf8",
  );
  return { ...result, debug: summary };
}

export async function capture_discovery_interaction_state(
  page: Page,
): Promise<DiscoveryInteractionState> {
  const counts = await page
    .evaluate(() => ({
      visibleFormCount: Array.from(document.querySelectorAll("form")).filter(
        (element) => {
          const style = window.getComputedStyle(element as HTMLElement);
          const bounds = (element as HTMLElement).getBoundingClientRect();
          return style.display !== "none" && style.visibility !== "hidden" && bounds.width > 0 && bounds.height > 0;
        },
      ).length,
      visibleDialogCount: Array.from(
        document.querySelectorAll("dialog[open], [role='dialog'], [aria-modal='true']"),
      ).filter((element) => {
        const style = window.getComputedStyle(element as HTMLElement);
        const bounds = (element as HTMLElement).getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && bounds.width > 0 && bounds.height > 0;
      }).length,
    }))
    .catch(() => ({ visibleFormCount: 0, visibleDialogCount: 0 }));
  return {
    url: page.url(),
    visibleFormCount: counts.visibleFormCount,
    visibleDialogCount: counts.visibleDialogCount,
    frameCount: page.frames().length,
  };
}

export async function write_blocked_discovery_debug(
  page: Page,
  starting_url: string,
  reason: string,
  artifact_directory: string,
): Promise<DiscoveryDebugSummary> {
  const absolute_directory = resolve(artifact_directory);
  await mkdir(absolute_directory, { recursive: true });
  const report_path = join(absolute_directory, "discovery-debug.json");
  const attempted_screenshot_path = join(
    absolute_directory,
    "discovery-failure.jpeg",
  );
  const screenshot_written = await page
    .screenshot({
      path: attempted_screenshot_path,
      type: "jpeg",
      quality: 70,
      fullPage: true,
      animations: "disabled",
    })
    .then(() => true)
    .catch(() => false);
  const summary: DiscoveryDebugSummary = {
    reportPath: report_path,
    artifactDirectory: absolute_directory,
    ...(screenshot_written ? { screenshotPath: attempted_screenshot_path } : {}),
    startingUrl: starting_url,
    finalUrl: page.url(),
    finalClassification: reason,
    attemptedRoutes: [],
    candidates: [],
    aiActions: [],
    frames: page.frames().map((frame) => ({
      url: frame.url(),
      sameOrigin: safe_origin(frame.url()) === safe_origin(starting_url),
    })),
    inspectionAttempts: [],
    coverageAssessment: {
      routesDiscovered: 0, routesAttempted: 0, routesSuccessfullyInspected: 0, routesSkipped: 0,
      accessibleFrames: page.frames().length, inaccessibleFrames: 0,
      revealControlsObserved: 0, revealControlsExercised: 0,
      incompleteReasons: [reason], completeEnoughForNoFormConclusion: false,
    },
    diagnosticDisposition: "inspection_incomplete",
    limits: {
      maxInspections: MAX_INSPECTIONS, maxCandidatesPerInspection: MAX_CANDIDATES_PER_INSPECTION,
      maxCandidatesTotal: MAX_CANDIDATES_TOTAL, maxControlsPerCandidate: MAX_CONTROLS_PER_CANDIDATE,
      maxEvidenceNetworkRecords: MAX_EVIDENCE_NETWORK_RECORDS, maxContextLength: MAX_CONTEXT_LENGTH,
      maxScreenshots: MAX_DISCOVERY_SCREENSHOTS, omittedInspections: 0, omittedCandidates: 0,
      omittedControls: 0, omittedEvidenceNetworkRecords: 0, omittedScreenshots: 0,
    },
  };
  await writeFile(
    report_path,
    `${JSON.stringify({ version: 2, generatedAt: new Date().toISOString(), summary }, null, 2)}\n`,
    "utf8",
  );
  return summary;
}

function safe_origin(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return "";
  }
}

export async function persist_discovery_evidence_debug(
  summary: DiscoveryDebugSummary | undefined,
): Promise<void> {
  if (!summary?.reportPath) return;
  await writeFile(
    summary.reportPath,
    `${JSON.stringify({ version: 2, generatedAt: new Date().toISOString(), summary }, null, 2)}\n`,
    "utf8",
  );
}

function safe_url(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    return url.toString();
  } catch {
    return value.slice(0, MAX_CONTEXT_LENGTH);
  }
}

function coverage_assessment(
  collector: DiscoveryDebugCollector,
  result: FormDiscoveryResult,
): NonNullable<DiscoveryDebugSummary["coverageAssessment"]> {
  const attempted = collector.attemptedRoutes.filter((route) => !["duplicate", "blocked"].includes(route.result));
  const successful = attempted.filter((route) => route.diagnosticResult === "loaded" || route.diagnosticResult === "redirected");
  const incomplete = [
    ...attempted.filter((route) => ["timed_out", "navigation_failed", "http_error"].includes(route.diagnosticResult ?? ""))
      .map((route) => `${route.diagnosticResult}: ${safe_url(route.url)}`),
    ...(collector.limits.omittedInspections > 0 ? ["inspection limit reached"] : []),
    ...(collector.limits.omittedCandidates > 0 ? ["candidate limit reached"] : []),
  ];
  const frames = collector.inspectionAttempts.flatMap((inspection) => inspection.frameCount);
  const reveal_observed = collector.inspectionAttempts.reduce(
    (count, inspection) => count + inspection.pageSignals.contactRevealControls.length, 0,
  );
  return {
    routesDiscovered: collector.discoveredRouteCount,
    routesAttempted: attempted.length,
    routesSuccessfullyInspected: successful.length,
    routesSkipped: Math.max(0, collector.discoveredRouteCount - attempted.length),
    accessibleFrames: frames.reduce((sum, count) => sum + count, 0),
    inaccessibleFrames: 0,
    revealControlsObserved: reveal_observed,
    revealControlsExercised: collector.interactions.length,
    incompleteReasons: incomplete,
    completeEnoughForNoFormConclusion: !result.candidate && incomplete.length === 0,
  };
}

async function capture_discovery_page_state(page: Page): Promise<{
  url: string; title: string; language: string; headingExcerpt: string; contextExcerpt: string;
  errorPageIndicators: string[]; visibleFormCount: number; formLikeContainerCount: number;
  visibleDialogCount: number; readyState: string;
}> {
  return page.evaluate(() => {
    const visible = (element: Element): boolean => {
      const style = getComputedStyle(element as HTMLElement);
      const bounds = (element as HTMLElement).getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && bounds.width > 0 && bounds.height > 0;
    };
    const text = (document.body?.innerText ?? "").trim().replace(/\s+/g, " ");
    const heading = Array.from(document.querySelectorAll("h1,h2,h3"))
      .filter(visible).map((item) => item.textContent ?? "").join(" ").trim().replace(/\s+/g, " ");
    const searchable = `${document.title} ${heading} ${text.slice(0, 1000)}`.toLowerCase();
    const errorPageIndicators = [
      [/(?:404|not found|page introuvable|seite nicht gefunden)/, "not_found"],
      [/(?:403|forbidden|access denied)/, "access_denied"],
      [/(?:500|internal server error|service unavailable)/, "server_error"],
    ].filter(([pattern]) => (pattern as RegExp).test(searchable)).map(([, label]) => label as string);
    return {
      url: location.href,
      title: document.title.slice(0, 500).replace(/[\uD800-\uDBFF]$/, ""),
      language: document.documentElement.lang.slice(0, 50).replace(/[\uD800-\uDBFF]$/, ""),
      headingExcerpt: heading.slice(0, 500).replace(/[\uD800-\uDBFF]$/, ""),
      contextExcerpt: text.slice(0, 500).replace(/[\uD800-\uDBFF]$/, ""),
      errorPageIndicators,
      visibleFormCount: Array.from(document.querySelectorAll("form")).filter(visible).length,
      formLikeContainerCount: Array.from(document.querySelectorAll("main,section,article,div"))
        .filter((item) => visible(item) && Boolean(item.querySelector("input,textarea,select"))).slice(0, 100).length,
      visibleDialogCount: Array.from(document.querySelectorAll("dialog[open],[role='dialog'],[aria-modal='true']")).filter(visible).length,
      readyState: document.readyState,
    };
  }).catch(() => ({
    url: page.url(), title: "", language: "", headingExcerpt: "", contextExcerpt: "",
    errorPageIndicators: [], visibleFormCount: 0, formLikeContainerCount: 0,
    visibleDialogCount: 0, readyState: "unknown",
  }));
}
