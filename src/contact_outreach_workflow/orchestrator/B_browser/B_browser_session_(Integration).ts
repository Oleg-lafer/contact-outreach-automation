import { lookup } from "node:dns/promises";
import { chromium, type Browser, type BrowserContext, type Page, type Request, type Response } from "playwright";
import {
  ACTION_TIMEOUT_MS,
  AUTOMATION_ENGINE_ENVIRONMENT_VARIABLE,
  BROWSER_PREFLIGHT_TIMEOUT_MS,
  BROWSER_READINESS_TIMEOUT_MS,
  BROWSER_RECOVERY_TOTAL_BUDGET_MS,
  DEBUG_ACTION_SLOW_MO_MS,
  is_contact_form_debug_enabled,
  NAVIGATION_TIMEOUT_MS,
  RECOVERY_NAVIGATION_TIMEOUT_MS,
  resolve_browser_recovery_enabled,
} from "../../shared_files_orchestrator/outreach_constants_(Support).js";
import { describe_error } from "../../shared_files_orchestrator/outreach_errors_(Support).js";
import type {
  AutomationEngine,
  BrowserNavigationAttempt,
  BrowserNavigationCandidateKind,
  BrowserPageQuality,
  BrowserPreflightEvidence,
  ContactFillValues,
  NetworkDebugRecorder,
  OutreachBrowserSession,
} from "../../shared_files_orchestrator/outreach_types_(Support).js";
import { start_network_debug_recorder } from "../../shared_files_orchestrator/network_debug_(Support).js";
import { create_browser_dialog_controller } from "../../shared_files_orchestrator/browser_dialog_controller_(Support).js";
import {
  BrowserStageError,
  classify_browser_stage_failure,
  normalize_browser_stage_error,
  redact_browser_text,
} from "../../shared_files_orchestrator/browser_stage_diagnostics_(Support).js";
import { redact_diagnostic_url } from "../../shared_files_orchestrator/diagnostic_redaction_(Support).js";
import { normalize_outreach_domain } from "../../shared_files_orchestrator/website_identity_(Deterministic).js";
import type {
  BrowserFailurePhase,
  BrowserStageContentEvidence,
  BrowserStageResult,
} from "../../shared_files_orchestrator/outreach_types_(Support).js";
import type { DeepDebugContext } from "../../shared_files_orchestrator/deep_debug_types_(Support).js";
import {
  create_lazy_stagehand_attachment,
  reserve_loopback_cdp_port,
  wait_for_cdp_websocket_url,
} from "./B2_stagehand_browser_session_(Integration).js";

/*
 * TOP LEVEL WORKFLOW:
 *
 * open_target_website(contact_request)
 *        |
 *        v
 * launch Chromium
 *        |
 *        v
 * open a new page
 *        |
 *        v
 * navigate to the target website
 */

/*
 * ========================================================================
 * TOP_LEVEL_WORKFLOW_FUNCTIONS
 * ========================================================================
 */

/*
 * ========================================================================
 * TARGET WEBSITE OPENING - open_target_website(...)
 * ========================================================================
 * Input:  A validated contact request containing the target URL.
 * Output: An active Chromium browser and page positioned at the target site.
 *
 * Responsibility: Create browser resources and perform the bounded initial
 * navigation without leaking Chromium when navigation fails.
 * ========================================================================
 */
export async function open_target_website(
  contact_request: { websiteUrl: string } & Partial<ContactFillValues>,
  options: BrowserSessionOptions = {},
): Promise<OutreachBrowserSession> {
  const engine = resolve_automation_engine(options.engine, options.environment);
  const recovery_enabled = resolve_browser_recovery_enabled(options.environment);
  const debug_enabled = is_contact_form_debug_enabled();
  const redaction_values = options.redactionValues ??
    contact_request_redaction_values(contact_request);
  const started_at = new Date();
  const monotonic_started_at = performance.now();
  const state: BrowserObservationState = create_browser_observation_state(redaction_values, Boolean(options.deepDebug));
  capture_resource_snapshot(state, "LAUNCH");
  let phase: BrowserFailurePhase = "LOOPBACK_PORT_RESERVATION";
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  let network_debug_recorder: NetworkDebugRecorder | undefined;
  let cdp_port: number | undefined;
  const navigation_attempts: BrowserNavigationAttempt[] = [];
  const preflight_evidence: BrowserPreflightEvidence[] = [];
  let recovery_eligible = false;
  let selected_candidate: NavigationCandidate = {
    kind: "ORIGINAL",
    url: contact_request.websiteUrl,
  };
  let final_execution: NavigationExecution | undefined;
  options.deepDebug?.record({
    stage: "browser",
    substage: "lifecycle",
    operation: "open-target-website",
    outcome: "started",
    url: contact_request.websiteUrl,
    data: {
      timeoutMs: NAVIGATION_TIMEOUT_MS,
      readinessTimeoutMs: BROWSER_READINESS_TIMEOUT_MS,
      waitUntil: "commit",
      engine,
      recoveryEnabled: recovery_enabled,
    },
  });
  try {
    if (engine === "stagehand") {
      phase = "LOOPBACK_PORT_RESERVATION";
      cdp_port = await reserve_loopback_cdp_port();
    }
    phase = "BROWSER_LAUNCH";
    browser = await chromium.launch({
      headless: !debug_enabled,
      ...(debug_enabled ? { slowMo: DEBUG_ACTION_SLOW_MO_MS } : {}),
      ...(cdp_port
        ? {
            args: [
              "--remote-debugging-address=127.0.0.1",
              `--remote-debugging-port=${cdp_port}`,
            ],
          }
        : {}),
    });
    browser.on("disconnected", () => {
      state.browserDisconnectedObserved = true;
      push_browser_event(state, "browser-disconnected", { initiator: state.browserCloseInitiator ?? "UNKNOWN" });
    });
    phase = "CONTEXT_CREATION";
    context = await browser.newContext({ ignoreHTTPSErrors: false });
    context.on("close", () => {
      state.contextClosedObserved = true;
      push_browser_event(state, "context-closed", { initiator: state.contextCloseInitiator ?? "UNKNOWN" });
    });
    const dialog_controller = create_browser_dialog_controller({
      ...(options.deepDebug ? { deepDebug: options.deepDebug } : {}),
      redactionValues: redaction_values,
    });
    const navigation_budget_started_at = performance.now();
    const candidates: NavigationCandidate[] = [{ kind: "ORIGINAL", url: contact_request.websiteUrl }];
    for (let index = 0; index < candidates.length && index < 3; index += 1) {
      if (index > 0 && performance.now() - navigation_budget_started_at >= BROWSER_RECOVERY_TOTAL_BUDGET_MS) break;
      selected_candidate = candidates[index]!;
      if (page) {
        state.pageCloseInitiator = "OUR_AUTOMATION";
        network_debug_recorder?.stop();
        await page.close().catch(() => undefined);
      }

      phase = "PAGE_CREATION";
      reset_attempt_observation(state, index + 1);
      page = await context.newPage();
      install_page_health_observers(page, state);
      configure_page_timeouts(page);
      install_initial_navigation_observers(page, state, redaction_values);
      network_debug_recorder = options.networkDebug
        ? start_network_debug_recorder(page, options.networkDebug.redactionValues ?? [])
        : undefined;
      phase = "DIAGNOSTIC_ATTACHMENT";
      await options.deepDebug?.attachPage(page).catch((error: unknown) => {
        options.deepDebug?.record({
          stage: "browser",
          substage: "diagnostics",
          operation: "attach-page-observers",
          outcome: "failed",
          reason: error instanceof Error ? error.message : String(error),
        });
      });
      dialog_controller.attach(page);
      phase = "INITIAL_NAVIGATION";
      const timeout_ms = index === 0 ? NAVIGATION_TIMEOUT_MS : RECOVERY_NAVIGATION_TIMEOUT_MS;
      final_execution = await navigate_candidate({
        page,
        browser,
        state,
        candidate: selected_candidate,
        attempt: index + 1,
        timeoutMs: timeout_ms,
        totalBudgetStartedAt: navigation_budget_started_at,
        redactionValues: redaction_values,
      });
      navigation_attempts.push(to_navigation_attempt(final_execution, redaction_values));
      if (final_execution.outcome !== "FAILED") break;

      const recovery_policy = classify_recovery_policy(final_execution);
      if (index === 0) {
        recovery_eligible = recovery_policy !== "NONE";
        if (!recovery_enabled || recovery_policy === "NONE" || is_terminal_navigation_failure(final_execution)) break;
        const recovered_candidates = await build_recovery_candidates({
          originalUrl: contact_request.websiteUrl,
          policy: recovery_policy,
          budgetStartedAt: navigation_budget_started_at,
          redactionValues: redaction_values,
          preflightEvidence: preflight_evidence,
        });
        candidates.push(...recovered_candidates);
      } else if (is_terminal_navigation_failure(final_execution)) {
        break;
      }
    }

    if (!page || !final_execution) {
      throw new Error("Browser navigation did not produce an attempt result.");
    }
    const content = final_execution.content;
    const health = browser_health(browser, page, state);
    let browser_stage = create_browser_stage_result({
      originalUrl: contact_request.websiteUrl,
      finalUrl: final_execution.finalUrl,
      startedAt: started_at,
      durationMs: performance.now() - monotonic_started_at,
      phase: final_execution.phase,
      state,
      content,
      health,
      redactionValues: redaction_values,
      runContext: options.runContext,
      ...(final_execution.error ? { error: final_execution.error } : {}),
      outcome: final_execution.outcome,
      navigationAttempts: navigation_attempts,
      selectedCandidate: selected_candidate,
      recoveryEnabled: recovery_enabled,
      recoveryEligible: recovery_eligible,
      preflightEvidence: preflight_evidence,
      pageQuality: final_execution.pageQuality,
      pageQualityEvidence: content.pageQualityIndicators,
    });
    if (browser_stage.outcome === "FAILED") {
      capture_resource_snapshot(state, "FAILURE");
      browser_stage.resourceSnapshots = [...state.resourceSnapshots];
      browser_stage = classify_browser_stage_failure(browser_stage);
    } else if (final_execution.outcome === "LOADED_AFTER_TIMEOUT") {
      browser_stage.reason = "The main document produced meaningful usable content before DOMContentLoaded; the stable page was retained without waiting indefinitely.";
      browser_stage.ruleId = "BRW-LOADED-AFTER-TIMEOUT";
      browser_stage.subcategory = "usable_content_before_dom_readiness";
      browser_stage.confidence = "HIGH";
      browser_stage.evidence.push("main document received", "meaningful content present", "browser and page healthy");
    }
    await write_browser_stage_artifact(options.deepDebug, browser_stage);
    record_browser_stage_result(options.deepDebug, browser_stage);
    if (browser_stage.outcome === "FAILED" && !options.allowNavigationFailure) {
      throw new BrowserStageError(
        `Could not open the target website${engine === "stagehand" ? " for Stagehand attachment" : ""}: ${browser_stage.reason ?? browser_stage.error?.message ?? "browser-stage failure"}`,
        browser_stage,
        final_execution.error,
      );
    }
    if (!browser || !context || !page) {
      throw new Error("Browser session resources were unexpectedly unavailable after navigation.");
    }
    const active_browser = browser;
    const active_context = context;
    const active_page = page;
    const active_cdp_port = cdp_port;
    const stagehand_attachment =
      active_cdp_port
        ? create_lazy_stagehand_attachment({
            cdpUrl: () =>
              wait_for_cdp_websocket_url(active_cdp_port, NAVIGATION_TIMEOUT_MS),
            ...(options.environment ? { environment: options.environment } : {}),
          })
        : undefined;
    const session: OutreachBrowserSession = {
      page: active_page,
      context: active_context,
      createChannelPage: async () => {
        const channel_page = await active_context.newPage();
        configure_page_timeouts(channel_page);
        dialog_controller.attach(channel_page);
        await options.deepDebug?.attachPage(channel_page).catch(() => undefined);
        return channel_page;
      },
      ...(final_execution.error
        ? { initialNavigationError: describe_error(final_execution.error) }
        : {}),
      redactionValues: contact_request_redaction_values(contact_request),
      obstructionActions: [],
      close: async () => {
        state.browserCloseInitiator = "OUR_AUTOMATION";
        state.contextCloseInitiator = "OUR_AUTOMATION";
        state.pageCloseInitiator = "OUR_AUTOMATION";
        capture_resource_snapshot(state, "CLEANUP");
        dialog_controller.detachAll();
        await stagehand_attachment?.close();
        await active_browser.close();
      },
      dialogController: dialog_controller,
      ...(network_debug_recorder
        ? { networkDebugRecorder: network_debug_recorder }
        : {}),
      browserStage: browser_stage,
      ...(options.deepDebug ? { deepDebug: options.deepDebug } : {}),
    };
    if (stagehand_attachment) {
      Object.defineProperty(session, "pageIntelligence", {
        enumerable: true,
        configurable: false,
        get: () => stagehand_attachment.current(),
      });
      session.ensurePageIntelligence = stagehand_attachment.ensure;
    }
    return session;
  } catch (error) {
    if (error instanceof BrowserStageError) {
      state.browserCloseInitiator = "OUR_AUTOMATION";
      state.contextCloseInitiator = "OUR_AUTOMATION";
      state.pageCloseInitiator = "OUR_AUTOMATION";
      capture_resource_snapshot(state, "CLEANUP");
      await browser?.close().catch(() => undefined);
      throw error;
    }
    const content = page
      ? await inspect_loaded_page(page, redaction_values)
      : empty_content_evidence();
    capture_resource_snapshot(state, "FAILURE");
    let browser_stage = create_browser_stage_result({
      originalUrl: contact_request.websiteUrl,
      finalUrl: page ? safe_page_url(page, contact_request.websiteUrl) : contact_request.websiteUrl,
      startedAt: started_at,
      durationMs: performance.now() - monotonic_started_at,
      phase,
      state,
      content,
      health: browser_health(browser, page, state),
      redactionValues: redaction_values,
      runContext: options.runContext,
      error,
      outcome: "FAILED",
      navigationAttempts: navigation_attempts,
      selectedCandidate: selected_candidate,
      recoveryEnabled: recovery_enabled,
      recoveryEligible: recovery_eligible,
      preflightEvidence: preflight_evidence,
      pageQuality: evaluate_page_quality(state.mainDocumentStatus, content, page ? safe_page_url(page, contact_request.websiteUrl) : contact_request.websiteUrl),
      pageQualityEvidence: content.pageQualityIndicators,
    });
    browser_stage = classify_browser_stage_failure(browser_stage);
    await write_browser_stage_artifact(options.deepDebug, browser_stage);
    record_browser_stage_result(options.deepDebug, browser_stage);
    state.browserCloseInitiator = "OUR_AUTOMATION";
    state.contextCloseInitiator = "OUR_AUTOMATION";
    state.pageCloseInitiator = "OUR_AUTOMATION";
    capture_resource_snapshot(state, "CLEANUP");
    await browser?.close().catch(() => undefined);
    throw new BrowserStageError(
      `Could not open the target website${engine === "stagehand" ? " for Stagehand attachment" : ""}: ${describe_error(error)}`,
      browser_stage,
      error,
    );
  }
}

interface BrowserObservationState {
  redirectChain: string[];
  mainDocumentRequested: boolean;
  mainDocumentReceived: boolean;
  mainDocumentStatus?: number;
  mainDocumentStatusText?: string;
  mainDocumentFailure?: string;
  browserDisconnectedObserved: boolean;
  contextClosedObserved: boolean;
  pageCrashObserved: boolean;
  pageCloseObserved: boolean;
  browserCloseInitiator?: BrowserStageResult["timeline"][number]["initiator"];
  contextCloseInitiator?: BrowserStageResult["timeline"][number]["initiator"];
  pageCloseInitiator?: BrowserStageResult["timeline"][number]["initiator"];
  navigationStartedAt?: string;
  navigationFinishedAt?: string;
  lastProgressAt?: string;
  lastProgressType?: string;
  committedUrl?: string;
  responseHeadersReceived: boolean;
  connectionEstablished?: boolean;
  tlsEstablished?: boolean;
  timeline: BrowserStageResult["timeline"];
  resourceSnapshots: BrowserStageResult["resourceSnapshots"];
  observationStartedAt: number;
  redactionValues: readonly string[];
  detailedDiagnosticsEnabled: boolean;
  currentAttempt: number;
}

function create_browser_observation_state(
  redactionValues: readonly string[],
  detailedDiagnosticsEnabled: boolean,
): BrowserObservationState {
  return {
    redirectChain: [],
    mainDocumentRequested: false,
    mainDocumentReceived: false,
    browserDisconnectedObserved: false,
    contextClosedObserved: false,
    pageCrashObserved: false,
    pageCloseObserved: false,
    responseHeadersReceived: false,
    timeline: [],
    resourceSnapshots: [],
    observationStartedAt: performance.now(),
    redactionValues,
    detailedDiagnosticsEnabled,
    currentAttempt: 1,
  };
}

function reset_attempt_observation(state: BrowserObservationState, attempt: number): void {
  state.redirectChain = [];
  state.mainDocumentRequested = false;
  state.mainDocumentReceived = false;
  delete state.mainDocumentStatus;
  delete state.mainDocumentStatusText;
  delete state.mainDocumentFailure;
  state.pageCrashObserved = false;
  state.pageCloseObserved = false;
  delete state.pageCloseInitiator;
  delete state.navigationStartedAt;
  delete state.navigationFinishedAt;
  delete state.lastProgressAt;
  delete state.lastProgressType;
  delete state.committedUrl;
  state.responseHeadersReceived = false;
  delete state.connectionEstablished;
  delete state.tlsEstablished;
  state.currentAttempt = attempt;
}

function install_page_health_observers(page: Page, state: BrowserObservationState): void {
  page.on("crash", () => {
    state.pageCrashObserved = true;
    push_browser_event(state, "page-crashed", { initiator: "BROWSER" });
  });
  page.on("close", () => {
    if (state.pageCloseInitiator !== "OUR_AUTOMATION") state.pageCloseObserved = true;
    push_browser_event(state, "page-closed", { initiator: state.pageCloseInitiator ?? "UNKNOWN" });
  });
}

function install_initial_navigation_observers(
  page: Page,
  state: BrowserObservationState,
  redaction_values: readonly string[],
): void {
  const main_document_request = (request: Request): boolean =>
    request.isNavigationRequest() && request.frame() === page.mainFrame();
  page.on("request", (request) => {
    if (!main_document_request(request)) return;
    state.mainDocumentRequested = true;
    push_browser_event(state, "main-document-request", {
      url: redact_diagnostic_url(request.url(), redaction_values),
      initiator: "OUR_AUTOMATION",
    });
    const url = redact_diagnostic_url(request.url(), redaction_values);
    if (state.redirectChain.at(-1) !== url && state.redirectChain.length < 20) {
      state.redirectChain.push(url);
    }
  });
  page.on("response", (response) => {
    if (!main_document_request(response.request())) return;
    capture_main_document_response(response, state);
    void capture_transport_evidence(response, state);
  });
  page.on("requestfailed", (request) => {
    if (!main_document_request(request)) return;
    state.mainDocumentFailure = redact_browser_text(
      request.failure()?.errorText ?? "unknown main-document request failure",
      redaction_values,
      2_000,
    );
    push_browser_event(state, "main-document-failed", {
      url: redact_diagnostic_url(request.url(), redaction_values),
      detail: state.mainDocumentFailure,
      initiator: "UNKNOWN",
    });
  });
}

function capture_main_document_response(
  response: Response,
  state: BrowserObservationState,
): void {
  state.mainDocumentReceived = true;
  state.responseHeadersReceived = true;
  state.mainDocumentStatus = response.status();
  state.mainDocumentStatusText = response.statusText().slice(0, 200);
  state.committedUrl = redact_diagnostic_url(response.url(), state.redactionValues);
  state.connectionEstablished = true;
  push_browser_event(state, "main-document-response", {
    url: redact_diagnostic_url(response.url(), state.redactionValues),
    status: response.status(),
    initiator: "DESTINATION",
  });
}

async function capture_transport_evidence(response: Response, state: BrowserObservationState): Promise<void> {
  try {
    const [server, security] = await Promise.all([response.serverAddr(), response.securityDetails()]);
    if (server) state.connectionEstablished = true;
    if (security) state.tlsEstablished = true;
  } catch {
    // Transport details are optional evidence and must never alter navigation.
  }
}

export type RecoveryPolicy = "NONE" | "WWW_THEN_CANONICAL" | "WWW_THEN_ORIGINAL";

interface NavigationCandidate {
  kind: BrowserNavigationCandidateKind;
  url: string;
  retryReason?: string;
}

interface NavigationExecution {
  candidate: NavigationCandidate;
  attempt: number;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  timeoutMs: number;
  committed: boolean;
  finalUrl: string;
  outcome: BrowserStageResult["outcome"];
  phase: BrowserFailurePhase;
  content: BrowserStageContentEvidence;
  pageQuality: BrowserPageQuality;
  mainDocumentReceived: boolean;
  mainDocumentStatus?: number;
  error?: unknown;
}

async function navigate_candidate(input: {
  page: Page;
  browser: Browser;
  state: BrowserObservationState;
  candidate: NavigationCandidate;
  attempt: number;
  timeoutMs: number;
  totalBudgetStartedAt: number;
  redactionValues: readonly string[];
}): Promise<NavigationExecution> {
  const started_at = new Date();
  const monotonic_started_at = performance.now();
  input.state.navigationStartedAt = started_at.toISOString();
  capture_resource_snapshot(input.state, "NAVIGATION_START");
  push_browser_event(input.state, "navigation-started", {
    url: redact_diagnostic_url(input.candidate.url, input.redactionValues),
    initiator: "OUR_AUTOMATION",
  });

  let navigation_response: Response | null = null;
  let navigation_error: unknown;
  const remaining_budget = remaining_recovery_budget(input.totalBudgetStartedAt);
  const navigation_timeout = Math.max(1, Math.min(input.timeoutMs, remaining_budget));
  try {
    navigation_response = await input.page.goto(input.candidate.url, {
      waitUntil: "commit",
      timeout: navigation_timeout,
    });
  } catch (error) {
    navigation_error = error;
  }
  if (navigation_response) {
    capture_main_document_response(navigation_response, input.state);
    await capture_transport_evidence(navigation_response, input.state);
  }

  const committed = Boolean(
    navigation_response || input.state.mainDocumentReceived ||
    safe_page_url(input.page, "about:blank") !== "about:blank"
  );
  const readiness = committed
    ? await wait_for_page_readiness(
        input.page,
        input.state,
        input.redactionValues,
        input.totalBudgetStartedAt,
      )
    : { content: await inspect_loaded_page(input.page, input.redactionValues), usableBeforeDomReady: false, timedOut: false };

  input.state.navigationFinishedAt = new Date().toISOString();
  push_browser_event(input.state, navigation_error ? "navigation-failed" : "navigation-finished", {
    ...(navigation_error
      ? { detail: redact_browser_text(describe_error(navigation_error), input.redactionValues, 2_000) }
      : {}),
    initiator: navigation_error ? "PLAYWRIGHT" : "DESTINATION",
  });
  const observed_url = safe_page_url(input.page, input.candidate.url);
  const final_url = observed_url === "about:blank" ? input.candidate.url : observed_url;
  const page_quality = evaluate_page_quality(input.state.mainDocumentStatus, readiness.content, final_url);
  const health = browser_health(input.browser, input.page, input.state);
  const usable = page_quality === "USABLE" && health.browserConnected && !health.pageClosed;
  return {
    candidate: input.candidate,
    attempt: input.attempt,
    startedAt: started_at.toISOString(),
    finishedAt: input.state.navigationFinishedAt,
    durationMs: Number((performance.now() - monotonic_started_at).toFixed(3)),
    timeoutMs: navigation_timeout,
    committed,
    finalUrl: final_url,
    outcome: usable
      ? readiness.usableBeforeDomReady || Boolean(navigation_error)
        ? "LOADED_AFTER_TIMEOUT"
        : "LOADED"
      : "FAILED",
    phase: readiness.timedOut ? "POST_TIMEOUT_INSPECTION" : "INITIAL_NAVIGATION",
    content: readiness.content,
    pageQuality: page_quality,
    mainDocumentReceived: input.state.mainDocumentReceived,
    ...(input.state.mainDocumentStatus !== undefined ? { mainDocumentStatus: input.state.mainDocumentStatus } : {}),
    ...(navigation_error ? { error: navigation_error } : {}),
  };
}

async function wait_for_page_readiness(
  page: Page,
  state: BrowserObservationState,
  redaction_values: readonly string[],
  total_budget_started_at: number,
): Promise<{
  content: BrowserStageContentEvidence;
  usableBeforeDomReady: boolean;
  timedOut: boolean;
}> {
  const allowed = Math.max(0, Math.min(
    BROWSER_READINESS_TIMEOUT_MS,
    remaining_recovery_budget(total_budget_started_at),
  ));
  const deadline = performance.now() + allowed;
  let content = await inspect_loaded_page(page, redaction_values);
  while (!page.isClosed()) {
    const quality = evaluate_page_quality(state.mainDocumentStatus, content, safe_page_url(page, "about:blank"));
    const dom_ready = content.readyState === "interactive" || content.readyState === "complete";
    if (quality === "USABLE" && dom_ready) {
      const load_state_timeout = Math.max(1, Math.min(250, deadline - performance.now()));
      const domcontentloaded = await page.waitForLoadState("domcontentloaded", {
        timeout: load_state_timeout,
      }).then(() => true).catch(() => false);
      if (domcontentloaded) {
        content = await inspect_loaded_page(page, redaction_values);
        if (evaluate_page_quality(state.mainDocumentStatus, content, safe_page_url(page, "about:blank")) === "USABLE") {
          return { content, usableBeforeDomReady: false, timedOut: false };
        }
      }
    }
    if (quality_is_terminal(quality) || performance.now() >= deadline) break;
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(250, Math.max(1, deadline - performance.now()))));
    content = await inspect_loaded_page(page, redaction_values);
  }
  const timed_out = performance.now() >= deadline &&
    content.readyState !== "interactive" && content.readyState !== "complete";
  if (timed_out) {
    await stop_stalled_navigation(page, state);
    content = await inspect_loaded_page(page, redaction_values);
  }
  return {
    content,
    usableBeforeDomReady: timed_out &&
      evaluate_page_quality(state.mainDocumentStatus, content, safe_page_url(page, "about:blank")) === "USABLE",
    timedOut: timed_out,
  };
}

async function stop_stalled_navigation(page: Page, state: BrowserObservationState): Promise<void> {
  push_browser_event(state, "stalled-navigation-stop-requested", { initiator: "OUR_AUTOMATION" });
  await Promise.race([
    page.evaluate(() => window.stop()).catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
  ]);
}

function to_navigation_attempt(
  execution: NavigationExecution,
  redaction_values: readonly string[],
): BrowserNavigationAttempt {
  return {
    attempt: execution.attempt,
    candidateKind: execution.candidate.kind,
    url: redact_diagnostic_url(execution.candidate.url, redaction_values),
    ...(execution.candidate.retryReason ? { retryReason: execution.candidate.retryReason } : {}),
    startedAt: execution.startedAt,
    finishedAt: execution.finishedAt,
    durationMs: execution.durationMs,
    timeoutMs: execution.timeoutMs,
    committed: execution.committed,
    ...(execution.committed ? { committedUrl: redact_diagnostic_url(execution.finalUrl, redaction_values) } : {}),
    finalUrl: redact_diagnostic_url(execution.finalUrl, redaction_values),
    outcome: execution.outcome,
    mainDocumentReceived: execution.mainDocumentReceived,
    ...(execution.mainDocumentStatus !== undefined ? { mainDocumentStatus: execution.mainDocumentStatus } : {}),
    pageQuality: execution.pageQuality,
    ...(execution.error ? { error: normalize_browser_stage_error(execution.error, redaction_values) } : {}),
  };
}

function classify_recovery_policy(execution: NavigationExecution): RecoveryPolicy {
  if (is_terminal_navigation_failure(execution)) return "NONE";
  const text = describe_error(execution.error).toLowerCase();
  if (
    /err_cert_common_name_invalid|err_cert_name_constraint_violation|err_ssl_unrecognized_name_alert|err_ssl_version_or_cipher_mismatch|err_connection_refused|connection refused|err_address_unreachable/.test(text)
  ) {
    return "WWW_THEN_CANONICAL";
  }
  if (
    /err_name_not_resolved|err_connection_(reset|closed|aborted)|err_http2_|err_empty_response|err_timed_out|timeout|timed out/.test(text) &&
    !execution.committed
  ) {
    return "WWW_THEN_ORIGINAL";
  }
  return "NONE";
}

function is_terminal_navigation_failure(execution: NavigationExecution): boolean {
  return [
    "ACCESS_RESTRICTED",
    "HTTP_ERROR",
    "PARKED",
    "EXPIRED",
    "SITE_ERROR",
    "INSECURE_TRANSPORT",
  ].includes(execution.pageQuality) || /err_too_many_redirects|redirect loop/i.test(describe_error(execution.error));
}

function create_security_evidence(
  value: string,
  tls_established: boolean | undefined,
): BrowserStageResult["securityEvidence"] {
  try {
    const parsed = new URL(value);
    const scheme = parsed.protocol === "https:" ? "https" : parsed.protocol === "http:" ? "http" : "other";
    const form_submission_allowed = is_browser_submission_transport_allowed(value) &&
      (scheme !== "https" || tls_established !== false);
    return {
      scheme,
      cleartext: scheme === "http",
      tlsRequired: scheme === "https",
      ...(tls_established !== undefined ? { tlsEstablished: tls_established } : {}),
      formSubmissionAllowed: form_submission_allowed,
      ...(!form_submission_allowed
        ? { reason: "Form population and submission require valid HTTPS outside loopback test fixtures." }
        : {}),
    };
  } catch {
    return {
      scheme: "other",
      cleartext: false,
      tlsRequired: true,
      formSubmissionAllowed: false,
      reason: "The final page URL could not be validated for safe form submission.",
    };
  }
}

async function build_recovery_candidates(input: {
  originalUrl: string;
  policy: Exclude<RecoveryPolicy, "NONE">;
  budgetStartedAt: number;
  redactionValues: readonly string[];
  preflightEvidence: BrowserPreflightEvidence[];
}): Promise<NavigationCandidate[]> {
  await collect_dns_preflight(input.originalUrl, input.budgetStartedAt, input.redactionValues, input.preflightEvidence);
  let canonical: string | undefined;
  if (input.policy === "WWW_THEN_CANONICAL") {
    canonical = await discover_https_canonical_url(
      input.originalUrl,
      input.budgetStartedAt,
      input.redactionValues,
      input.preflightEvidence,
    );
  }
  return plan_browser_recovery_candidates(input.originalUrl, input.policy, canonical).map((candidate) => ({
    ...candidate,
    retryReason: candidate.kind === "WWW_HTTPS"
      ? input.policy === "WWW_THEN_CANONICAL"
        ? "hostname, SNI, or deterministic host failure"
        : "transient transport failure"
      : candidate.kind === "CANONICAL_HTTPS"
        ? "same-domain HTTPS canonical URL from bounded HTTP redirect probe"
        : "one bounded retry of the original URL after a transient transport failure",
  }));
}

export function plan_browser_recovery_candidates(
  originalUrl: string,
  policy: RecoveryPolicy,
  canonicalUrl?: string,
): Array<{ kind: BrowserNavigationCandidateKind; url: string }> {
  if (policy === "NONE") return [];
  const candidates: Array<{ kind: BrowserNavigationCandidateKind; url: string }> = [];
  const www = create_www_https_candidate(originalUrl);
  if (www) candidates.push({ kind: "WWW_HTTPS", url: www });
  if (policy === "WWW_THEN_CANONICAL") {
    if (canonicalUrl && !same_url(canonicalUrl, originalUrl) &&
      !candidates.some((candidate) => same_url(candidate.url, canonicalUrl))) {
      candidates.push({ kind: "CANONICAL_HTTPS", url: canonicalUrl });
    }
  } else {
    candidates.push({ kind: "ORIGINAL_RETRY", url: originalUrl });
  }
  return candidates.slice(0, 2);
}

async function collect_dns_preflight(
  value: string,
  budget_started_at: number,
  redaction_values: readonly string[],
  evidence: BrowserPreflightEvidence[],
): Promise<void> {
  const started = new Date();
  let outcome: BrowserPreflightEvidence["outcome"] = "FAILED";
  let detail = "DNS lookup did not complete.";
  try {
    const parsed = new URL(value);
    const timeout = Math.max(1, Math.min(1_000, remaining_recovery_budget(budget_started_at)));
    const result = await Promise.race([
      lookup(parsed.hostname),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("DNS advisory lookup timed out")), timeout)),
    ]);
    outcome = "SUCCEEDED";
    detail = `resolvedAddressFamily=${result.family}`;
  } catch (error) {
    detail = redact_browser_text(describe_error(error), redaction_values, 500);
  }
  evidence.push({
    kind: "DNS",
    candidateUrl: redact_diagnostic_url(value, redaction_values),
    outcome,
    startedAt: started.toISOString(),
    finishedAt: new Date().toISOString(),
    detail,
  });
}

async function discover_https_canonical_url(
  original_url: string,
  budget_started_at: number,
  redaction_values: readonly string[],
  evidence: BrowserPreflightEvidence[],
): Promise<string | undefined> {
  const started = new Date();
  let current: URL;
  try {
    const original = new URL(original_url);
    current = new URL(`http://${original.host}/`);
  } catch (error) {
    evidence.push({
      kind: "HTTP_REDIRECT_PROBE",
      candidateUrl: redact_diagnostic_url(original_url, redaction_values),
      outcome: "FAILED",
      startedAt: started.toISOString(),
      finishedAt: new Date().toISOString(),
      detail: redact_browser_text(describe_error(error), redaction_values, 500),
    });
    return undefined;
  }
  const controller = new AbortController();
  const timeout_ms = Math.max(1, Math.min(BROWSER_PREFLIGHT_TIMEOUT_MS, remaining_recovery_budget(budget_started_at)));
  const timer = setTimeout(() => controller.abort(), timeout_ms);
  let last_status: number | undefined;
  let discovered: string | undefined;
  let detail = "No valid same-domain HTTPS redirect was found.";
  try {
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      const response = await fetch(current, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: { "user-agent": "contact-outreach-browser-preflight/1.0" },
      });
      last_status = response.status;
      await response.body?.cancel().catch(() => undefined);
      const location = response.headers.get("location");
      if (!location || response.status < 300 || response.status >= 400 || redirects === 3) break;
      const next = new URL(location, current);
      if (!same_registrable_domain(original_url, next.toString())) {
        detail = "Redirect left the original registrable domain.";
        break;
      }
      if (next.protocol === "https:") {
        next.username = "";
        next.password = "";
        discovered = next.toString();
        detail = "Found a same-domain HTTPS redirect target.";
        break;
      }
      if (next.protocol !== "http:") break;
      current = next;
    }
  } catch (error) {
    detail = redact_browser_text(describe_error(error), redaction_values, 500);
  } finally {
    clearTimeout(timer);
  }
  evidence.push({
    kind: "HTTP_REDIRECT_PROBE",
    candidateUrl: redact_diagnostic_url(current.toString(), redaction_values),
    outcome: discovered ? "SUCCEEDED" : "FAILED",
    startedAt: started.toISOString(),
    finishedAt: new Date().toISOString(),
    ...(last_status !== undefined ? { status: last_status } : {}),
    ...(discovered ? { discoveredUrl: redact_diagnostic_url(discovered, redaction_values) } : {}),
    detail,
  });
  return discovered;
}

function create_www_https_candidate(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    if (parsed.hostname === "localhost" || parsed.hostname.startsWith("www.") ||
      parsed.hostname.includes(":") || /^\d+(?:\.\d+){3}$/.test(parsed.hostname)) return undefined;
    parsed.protocol = "https:";
    parsed.hostname = `www.${parsed.hostname}`;
    parsed.username = "";
    parsed.password = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function same_registrable_domain(left: string, right: string): boolean {
  try {
    return normalize_outreach_domain(left) === normalize_outreach_domain(right);
  } catch {
    return false;
  }
}

function same_url(left: string, right: string): boolean {
  try {
    return new URL(left).toString() === new URL(right).toString();
  } catch {
    return left === right;
  }
}

function remaining_recovery_budget(started_at: number): number {
  return Math.max(0, BROWSER_RECOVERY_TOTAL_BUDGET_MS - (performance.now() - started_at));
}

async function inspect_loaded_page(
  page: Page,
  redaction_values: readonly string[],
): Promise<BrowserStageContentEvidence> {
  if (page.isClosed()) return empty_content_evidence();
  try {
    const data = await Promise.race([
      page.evaluate(() => {
        const text = (document.body?.innerText ?? "").trim().replace(/\s+/g, " ");
        const title = document.title.trim().replace(/\s+/g, " ");
        return {
          readyState: document.readyState,
          title,
          bodyTextLength: text.length,
          elementCount: document.querySelectorAll("*").length,
          semanticElementCount: document.querySelectorAll("main, article, section, h1, h2, h3, p, address").length,
          controlCount: document.querySelectorAll("a[href], button, form, input:not([type=hidden]), select, textarea").length,
          formCount: document.querySelectorAll("form").length,
          embeddedContentCount: document.querySelectorAll("iframe[src], embed[src], object[data]").length,
          contactRouteCount: [...document.querySelectorAll("a[href], button")].filter((element) => {
            const candidate = `${element.textContent ?? ""} ${element.getAttribute("href") ?? ""}`;
            return /contact|get[\s-]*in[\s-]*touch|request[\s-]*(?:a[\s-]*)?quote|consult|book[\s-]*(?:a[\s-]*)?(?:call|meeting)|schedule[\s-]*(?:a[\s-]*)?(?:call|demo|meeting)|talk[\s-]*to|צור\s*קשר|דברו\s*איתנו/i.test(candidate);
          }).length,
          classificationText: `${title} ${text.slice(0, 4_000)}`,
        };
      }),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("post-navigation page inspection timed out")), 2_000),
      ),
    ]);
    const restriction_indicators = detect_access_restrictions(data.classificationText, safe_page_url(page, "about:blank"));
    const page_quality_indicators = detect_page_quality_indicators(data.classificationText);
    const meaningful = restriction_indicators.length === 0 && page_quality_indicators.length === 0 && (
      data.bodyTextLength >= 80 ||
      (data.bodyTextLength >= 10 && data.semanticElementCount > 0) ||
      (data.bodyTextLength >= 20 && data.controlCount > 0) ||
      (data.bodyTextLength >= 40 && data.semanticElementCount >= 2) ||
      data.controlCount >= 3 ||
      data.formCount > 0 ||
      data.embeddedContentCount > 0 ||
      data.contactRouteCount > 0
    );
    return {
      inspected: true,
      readyState: data.readyState,
      titleLength: data.title.length,
      titlePreview: redact_browser_text(data.title, redaction_values, 200),
      bodyTextLength: data.bodyTextLength,
      elementCount: data.elementCount,
      semanticElementCount: data.semanticElementCount,
      controlCount: data.controlCount,
      formCount: data.formCount,
      embeddedContentCount: data.embeddedContentCount,
      contactRouteCount: data.contactRouteCount,
      meaningfulContent: meaningful,
      accessRestrictionIndicators: restriction_indicators,
      pageQualityIndicators: page_quality_indicators,
    };
  } catch (error) {
    return {
      ...empty_content_evidence(),
      inspectionError: redact_browser_text(describe_error(error), redaction_values, 2_000),
    };
  }
}

function detect_access_restrictions(value: string, page_url: string): string[] {
  const checks: Array<[string, RegExp]> = [
    ["captcha", /\bcaptcha\b|verify you are human/i],
    ["antibot_challenge", /just a moment|checking (?:your )?browser|attention required|security challenge|cloudflare ray id|performing security verification/i],
    ["access_denied", /access denied|request (?:was )?blocked|you have been blocked|forbidden|גישה נדחתה|הגישה נדחתה|הבקשה נחסמה|נחסמת|אין לך הרשאה|הגישה לאתר (?:זה )?נחסמה/i],
    ["authentication_required", /authentication required|sign in to continue|login required/i],
    ["rate_limited", /too many requests|rate limit exceeded/i],
    ["challenge_url", /\/cdn-cgi\/challenge-platform|(?:[?&]__cf_chl_)|\/(?:security-)?challenge(?:\/|\?|$)/i],
  ];
  return checks
    .filter(([name, pattern]) => pattern.test(name === "challenge_url" ? page_url : value))
    .map(([name]) => name);
}

function detect_page_quality_indicators(value: string): string[] {
  const checks: Array<[string, RegExp]> = [
    ["parked_domain", /buy this domain|domain (?:is )?for sale|this domain may be for sale|parked (?:free|domain)|afternic|hugedomains|sedo domain parking/i],
    ["expired_site", /domain (?:name )?has expired|website (?:has )?expired|this (?:website|domain) is expired|תוקף הדומיין פג|האתר פג תוקף/i],
    ["wix_domain_error", /this domain isn['’]t connected to a website yet|domain is not connected to (?:a )?website|looks like this domain isn['’]t connected|wix domain/i],
    ["wordpress_error", /there has been a critical error on this website|error establishing a database connection/i],
    ["site_error", /account (?:has been )?suspended|website is unavailable|site (?:is )?temporarily unavailable|this site can['’]t be reached/i],
    ["not_found_content", /\b404\b[^.]{0,50}(?:not found|page)|page not found|the requested (?:page|url) (?:was not|could not be) found/i],
  ];
  return checks.filter(([, pattern]) => pattern.test(value)).map(([name]) => name);
}

function empty_content_evidence(): BrowserStageContentEvidence {
  return {
    inspected: false,
    meaningfulContent: false,
    accessRestrictionIndicators: [],
    pageQualityIndicators: [],
  };
}

function evaluate_page_quality(
  status: number | undefined,
  content: BrowserStageContentEvidence,
  final_url: string,
): BrowserPageQuality {
  if (!is_browser_submission_transport_allowed(final_url)) return "INSECURE_TRANSPORT";
  if (status !== undefined && (status < 200 || status >= 300)) return "HTTP_ERROR";
  if (content.accessRestrictionIndicators.length > 0) return "ACCESS_RESTRICTED";
  if (content.pageQualityIndicators.includes("parked_domain")) return "PARKED";
  if (content.pageQualityIndicators.includes("expired_site")) return "EXPIRED";
  if (content.pageQualityIndicators.length > 0) return "SITE_ERROR";
  if (status === undefined) return "UNUSABLE";
  if (!content.inspected) return content.inspectionError ? "INSPECTION_FAILED" : "EMPTY";
  if (
    (content.bodyTextLength ?? 0) === 0 &&
    (content.controlCount ?? 0) === 0 &&
    (content.formCount ?? 0) === 0 &&
    (content.embeddedContentCount ?? 0) === 0 &&
    (content.contactRouteCount ?? 0) === 0
  ) return "EMPTY";
  return content.meaningfulContent ? "USABLE" : "UNUSABLE";
}

function quality_is_terminal(quality: BrowserPageQuality): boolean {
  return [
    "ACCESS_RESTRICTED",
    "HTTP_ERROR",
    "PARKED",
    "EXPIRED",
    "SITE_ERROR",
    "INSECURE_TRANSPORT",
  ].includes(quality);
}

export function is_browser_submission_transport_allowed(value: string): boolean {
  try {
    const parsed = new URL(value);
    if (parsed.protocol === "https:") return true;
    return parsed.protocol === "http:" && (
      parsed.hostname === "localhost" || parsed.hostname === "::1" ||
      parsed.hostname === "127.0.0.1" || parsed.hostname.endsWith(".localhost")
    );
  } catch {
    return false;
  }
}

function browser_health(
  browser: Browser | undefined,
  page: Page | undefined,
  state: BrowserObservationState,
): BrowserStageResult["health"] {
  return {
    browserConnected: browser?.isConnected() ?? false,
    pageClosed: page?.isClosed() ?? true,
    browserDisconnectedObserved: state.browserDisconnectedObserved,
    contextClosedObserved: state.contextClosedObserved,
    pageCrashObserved: state.pageCrashObserved,
    pageCloseObserved: state.pageCloseObserved,
    ...(state.browserCloseInitiator ? { browserDisconnectInitiator: state.browserCloseInitiator } : {}),
    ...(state.contextCloseInitiator ? { contextCloseInitiator: state.contextCloseInitiator } : {}),
    ...(state.pageCloseInitiator ? { pageCloseInitiator: state.pageCloseInitiator } : {}),
  };
}

function create_browser_stage_result(input: {
  originalUrl: string;
  finalUrl: string;
  startedAt: Date;
  durationMs: number;
  phase: BrowserFailurePhase;
  state: BrowserObservationState;
  content: BrowserStageContentEvidence;
  health: BrowserStageResult["health"];
  redactionValues: readonly string[];
  runContext?: BrowserSessionOptions["runContext"];
  outcome: BrowserStageResult["outcome"];
  error?: unknown;
  navigationAttempts: BrowserNavigationAttempt[];
  selectedCandidate: NavigationCandidate;
  recoveryEnabled: boolean;
  recoveryEligible: boolean;
  preflightEvidence: BrowserPreflightEvidence[];
  pageQuality: BrowserPageQuality;
  pageQualityEvidence: string[];
}): BrowserStageResult {
  const memory = process.memoryUsage();
  const resource = process.resourceUsage();
  return {
    schemaVersion: 3,
    entered: input.phase !== "PRE_BROWSER",
    outcome: input.outcome,
    originalUrl: redact_diagnostic_url(input.originalUrl, input.redactionValues),
    normalizedUrl: redact_diagnostic_url(normalize_diagnostic_url(input.originalUrl), input.redactionValues),
    finalUrl: redact_diagnostic_url(input.finalUrl, input.redactionValues),
    startedAt: input.startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: Number(input.durationMs.toFixed(3)),
    phase: input.phase,
    operation: operation_for_phase(input.phase),
    attempt: input.navigationAttempts.at(-1)?.attempt ?? 1,
    timeoutMs: input.navigationAttempts.at(-1)?.timeoutMs ?? NAVIGATION_TIMEOUT_MS,
    waitUntil: "commit",
    navigationAttempts: input.navigationAttempts,
    selectedCandidateKind: input.selectedCandidate.kind,
    selectedCandidate: {
      attempt: input.navigationAttempts.at(-1)?.attempt ?? 1,
      kind: input.selectedCandidate.kind,
      url: redact_diagnostic_url(input.selectedCandidate.url, input.redactionValues),
    },
    recoveryEnabled: input.recoveryEnabled,
    recoveryEligible: input.recoveryEligible,
    recovered: input.navigationAttempts.length > 1 && input.outcome !== "FAILED",
    preflightEvidence: input.preflightEvidence,
    pageQuality: input.pageQuality,
    pageQualityEvidence: input.pageQualityEvidence,
    securityEvidence: create_security_evidence(input.finalUrl, input.state.tlsEstablished),
    redirectChain: input.state.redirectChain,
    ...(input.state.committedUrl
      ? { committedUrl: redact_diagnostic_url(input.state.committedUrl, input.redactionValues) }
      : {}),
    navigationStartedAt: input.state.navigationStartedAt ?? input.startedAt.toISOString(),
    navigationFinishedAt: input.state.navigationFinishedAt ?? new Date().toISOString(),
    ...(input.state.lastProgressAt ? { lastProgressAt: input.state.lastProgressAt } : {}),
    ...(input.state.lastProgressType ? { lastProgressType: input.state.lastProgressType } : {}),
    ...(input.error && /timeout|timed out/i.test(describe_error(input.error))
      ? { timeoutSource: "PLAYWRIGHT_NAVIGATION" as const }
      : {}),
    timeline: input.state.timeline,
    mainDocumentRequested: input.state.mainDocumentRequested,
    mainDocumentReceived: input.state.mainDocumentReceived,
    ...(input.state.mainDocumentStatus !== undefined ? { mainDocumentStatus: input.state.mainDocumentStatus } : {}),
    ...(input.state.mainDocumentStatusText ? { mainDocumentStatusText: input.state.mainDocumentStatusText } : {}),
    ...(input.state.mainDocumentFailure ? { mainDocumentFailure: input.state.mainDocumentFailure } : {}),
    responseHeadersReceived: input.state.responseHeadersReceived,
    ...(input.state.connectionEstablished !== undefined ? { connectionEstablished: input.state.connectionEstablished } : {}),
    ...(input.state.tlsEstablished !== undefined ? { tlsEstablished: input.state.tlsEstablished } : {}),
    transportEvidenceBasis: input.state.mainDocumentReceived ? "DIRECT" : "UNAVAILABLE",
    content: input.content,
    health: input.health,
    proxyConfigured: ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"].some((name) => Boolean(process.env[name])),
    runtime: {
      pid: process.pid,
      node: process.version,
      platform: process.platform,
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      userCpuMicros: resource.userCPUTime,
      systemCpuMicros: resource.systemCPUTime,
    },
    resourceSnapshots: input.state.resourceSnapshots,
    ...(input.runContext ? { runContext: input.runContext } : {}),
    evidence: [],
    contradictions: [],
    missingEvidence: [],
    ...(input.error ? { error: normalize_browser_stage_error(input.error, input.redactionValues) } : {}),
  };
}

function normalize_diagnostic_url(value: string): string {
  try {
    return new URL(value).toString();
  } catch {
    return value;
  }
}

function push_browser_event(
  state: BrowserObservationState,
  type: string,
  detail: Partial<Omit<BrowserStageResult["timeline"][number], "sequence" | "at" | "elapsedMs" | "type">> = {},
): void {
  if (state.timeline.length >= 200) return;
  const at = new Date().toISOString();
  state.lastProgressAt = at;
  state.lastProgressType = type;
  if (!state.detailedDiagnosticsEnabled) return;
  state.timeline.push({
    sequence: state.timeline.length + 1,
    at,
    elapsedMs: Number((performance.now() - state.observationStartedAt).toFixed(3)),
    type,
    attempt: state.currentAttempt,
    ...detail,
  });
}

function capture_resource_snapshot(
  state: BrowserObservationState,
  milestone: BrowserStageResult["resourceSnapshots"][number]["milestone"],
): void {
  if (!state.detailedDiagnosticsEnabled) return;
  const memory = process.memoryUsage();
  const resource = process.resourceUsage();
  state.resourceSnapshots.push({
    at: new Date().toISOString(),
    milestone,
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    userCpuMicros: resource.userCPUTime,
    systemCpuMicros: resource.systemCPUTime,
  });
}

async function write_browser_stage_artifact(
  deep_debug: DeepDebugContext | undefined,
  result: BrowserStageResult,
): Promise<void> {
  if (!deep_debug) return;
  const path = await deep_debug.writeJson("browser/browser-stage.json", result);
  if (path) result.diagnosticArtifactPath = path;
}

function record_browser_stage_result(
  deep_debug: DeepDebugContext | undefined,
  result: BrowserStageResult,
): void {
  deep_debug?.record({
    stage: "browser",
    substage: "result",
    operation: "browser-stage-completed",
    outcome: result.outcome === "FAILED" ? "failed" : "succeeded",
    ...(result.reason ? { reason: result.reason } : {}),
    url: result.finalUrl,
    durationMs: result.durationMs,
    data: result,
  });
}

function safe_page_url(page: Page, fallback: string): string {
  try {
    return page.url() || fallback;
  } catch {
    return fallback;
  }
}

function operation_for_phase(phase: BrowserFailurePhase): string {
  switch (phase) {
    case "LOOPBACK_PORT_RESERVATION": return "reserve-loopback-cdp-port";
    case "CDP_CONNECTION": return "connect-stagehand-cdp";
    case "BROWSER_LAUNCH": return "chromium.launch";
    case "CONTEXT_CREATION": return "browser.newContext";
    case "PAGE_CREATION": return "context.newPage";
    case "DIAGNOSTIC_ATTACHMENT": return "attach-page-diagnostics";
    case "INITIAL_NAVIGATION": return "page.goto";
    case "POST_TIMEOUT_INSPECTION": return "inspect-loaded-page";
    case "PRE_BROWSER": return "pre-browser";
  }
}

function contact_request_redaction_values(
  contact_request: { websiteUrl: string } & Partial<ContactFillValues>,
): string[] {
  return [
    contact_request.name,
    contact_request.email,
    contact_request.phone,
    contact_request.message,
    contact_request.company,
    contact_request.role,
    contact_request.website,
    contact_request.country,
  ].filter((value): value is string => Boolean(value));
}

function configure_page_timeouts(
  page: OutreachBrowserSession["page"],
): void {
  page.setDefaultTimeout(ACTION_TIMEOUT_MS);
  page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
}

export function resolve_automation_engine(
  explicit_engine: string | undefined,
  environment: NodeJS.ProcessEnv = process.env,
): AutomationEngine {
  const engine =
    explicit_engine ?? environment[AUTOMATION_ENGINE_ENVIRONMENT_VARIABLE];
  if (engine === undefined || engine === "" || engine === "playwright") {
    return "playwright";
  }
  if (engine === "stagehand") {
    return "stagehand";
  }

  throw new Error(
    `Invalid ${AUTOMATION_ENGINE_ENVIRONMENT_VARIABLE} value. ` +
      'Expected "playwright" or "stagehand".',
  );
}

export interface BrowserSessionOptions {
  engine?: AutomationEngine;
  environment?: NodeJS.ProcessEnv;
  allowNavigationFailure?: boolean;
  networkDebug?: {
    redactionValues?: string[];
  };
  deepDebug?: DeepDebugContext;
  redactionValues?: string[];
  runContext?: {
    campaignId?: number;
    campaignName?: string;
    siteOrdinal?: number;
    websiteId?: number;
  };
}
