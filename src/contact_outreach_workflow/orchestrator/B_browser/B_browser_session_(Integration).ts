import { chromium, type Browser, type BrowserContext, type Page, type Request, type Response } from "playwright";
import {
  ACTION_TIMEOUT_MS,
  AUTOMATION_ENGINE_ENVIRONMENT_VARIABLE,
  DEBUG_ACTION_SLOW_MO_MS,
  is_contact_form_debug_enabled,
  NAVIGATION_TIMEOUT_MS,
} from "../../shared_files_orchestrator/outreach_constants_(Support).js";
import { describe_error } from "../../shared_files_orchestrator/outreach_errors_(Support).js";
import type {
  AutomationEngine,
  ContactFillValues,
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
  let cdp_port: number | undefined;
  options.deepDebug?.record({
    stage: "browser",
    substage: "lifecycle",
    operation: "open-target-website",
    outcome: "started",
    url: contact_request.websiteUrl,
    data: { timeoutMs: NAVIGATION_TIMEOUT_MS, waitUntil: "domcontentloaded", engine },
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
    context = await browser.newContext();
    context.on("close", () => {
      state.contextClosedObserved = true;
      push_browser_event(state, "context-closed", { initiator: state.contextCloseInitiator ?? "UNKNOWN" });
    });
    phase = "PAGE_CREATION";
    page = await context.newPage();
    page.on("crash", () => {
      state.pageCrashObserved = true;
      push_browser_event(state, "page-crashed", { initiator: "BROWSER" });
    });
    page.on("close", () => {
      state.pageCloseObserved = true;
      push_browser_event(state, "page-closed", { initiator: state.pageCloseInitiator ?? "UNKNOWN" });
    });
    configure_page_timeouts(page);
    install_initial_navigation_observers(page, state, redaction_values);
    const network_debug_recorder = options.networkDebug
      ? start_network_debug_recorder(
          page,
          options.networkDebug.redactionValues ?? [],
        )
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
    const dialog_controller = create_browser_dialog_controller({
      ...(options.deepDebug ? { deepDebug: options.deepDebug } : {}),
      redactionValues: redaction_values,
    });
    dialog_controller.attach(page);
    phase = "INITIAL_NAVIGATION";
    state.navigationStartedAt = new Date().toISOString();
    capture_resource_snapshot(state, "NAVIGATION_START");
    push_browser_event(state, "navigation-started", {
      url: redact_browser_text(contact_request.websiteUrl, redaction_values, 2_000),
      initiator: "OUR_AUTOMATION",
    });
    let navigation_response: Response | null = null;
    let navigation_error: unknown;
    try {
      navigation_response = await page.goto(contact_request.websiteUrl, {
        waitUntil: "domcontentloaded",
        timeout: NAVIGATION_TIMEOUT_MS,
      });
    } catch (error) {
      navigation_error = error;
    }
    state.navigationFinishedAt = new Date().toISOString();
    push_browser_event(state, navigation_error ? "navigation-failed" : "navigation-finished", {
      ...(navigation_error
        ? { detail: redact_browser_text(describe_error(navigation_error), redaction_values, 2_000) }
        : {}),
      initiator: navigation_error ? "PLAYWRIGHT" : "DESTINATION",
    });
    if (navigation_response) capture_main_document_response(navigation_response, state);
    const content = await inspect_loaded_page(page, redaction_values);
    const health = browser_health(browser, page, state);
    const is_timeout = Boolean(navigation_error) && /timeout|timed out/i.test(describe_error(navigation_error));
    const salvage_timeout = is_timeout && state.mainDocumentReceived && content.meaningfulContent &&
      content.accessRestrictionIndicators.length === 0 && health.browserConnected && !health.pageClosed;
    let browser_stage = create_browser_stage_result({
      originalUrl: contact_request.websiteUrl,
      finalUrl: safe_page_url(page, contact_request.websiteUrl),
      startedAt: started_at,
      durationMs: performance.now() - monotonic_started_at,
      phase: navigation_error ? "INITIAL_NAVIGATION" : phase,
      state,
      content,
      health,
      redactionValues: redaction_values,
      runContext: options.runContext,
      ...(navigation_error ? { error: navigation_error } : {}),
      outcome: salvage_timeout
        ? "LOADED_AFTER_TIMEOUT"
        : navigation_error || browser_response_is_failure(state, content)
          ? "FAILED"
          : "LOADED",
    });
    if (browser_stage.outcome === "FAILED") {
      capture_resource_snapshot(state, "FAILURE");
      browser_stage.resourceSnapshots = [...state.resourceSnapshots];
      browser_stage = classify_browser_stage_failure(browser_stage);
    } else if (salvage_timeout) {
      browser_stage.reason = "Navigation timed out after the main document produced meaningful usable content; the existing page was retained without retrying navigation.";
      browser_stage.ruleId = "BRW-LOADED-AFTER-TIMEOUT";
      browser_stage.subcategory = "navigation_timeout_with_meaningful_content";
      browser_stage.confidence = "HIGH";
      browser_stage.evidence.push("main document received", "meaningful content present", "browser and page healthy");
    }
    await write_browser_stage_artifact(options.deepDebug, browser_stage);
    record_browser_stage_result(options.deepDebug, browser_stage);
    if (browser_stage.outcome === "FAILED" && !options.allowNavigationFailure) {
      throw new BrowserStageError(
        `Could not open the target website${engine === "stagehand" ? " for Stagehand attachment" : ""}: ${browser_stage.reason ?? browser_stage.error?.message ?? "browser-stage failure"}`,
        browser_stage,
        navigation_error,
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
      ...(navigation_error
        ? { initialNavigationError: describe_error(navigation_error) }
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
  };
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
      url: redact_browser_text(request.url(), redaction_values, 2_000),
      initiator: "OUR_AUTOMATION",
    });
    const url = redact_browser_text(request.url(), redaction_values, 2_000);
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
      url: redact_browser_text(request.url(), redaction_values, 2_000),
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
  state.committedUrl = redact_browser_text(response.url(), state.redactionValues, 2_000);
  state.connectionEstablished = true;
  push_browser_event(state, "main-document-response", {
    url: redact_browser_text(response.url(), state.redactionValues, 2_000),
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
          controlCount: document.querySelectorAll("a[href], button, form, input:not([type=hidden]), select, textarea").length,
          restrictionText: `${title} ${text.slice(0, 2_000)}`,
        };
      }),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("post-navigation page inspection timed out")), 2_000),
      ),
    ]);
    const restriction_indicators = detect_access_restrictions(data.restrictionText);
    const meaningful = restriction_indicators.length === 0 && (
      data.bodyTextLength >= 80 ||
      (data.bodyTextLength >= 20 && data.controlCount > 0) ||
      (data.title.length >= 5 && data.elementCount >= 8)
    );
    return {
      inspected: true,
      readyState: data.readyState,
      titleLength: data.title.length,
      titlePreview: redact_browser_text(data.title, redaction_values, 200),
      bodyTextLength: data.bodyTextLength,
      elementCount: data.elementCount,
      controlCount: data.controlCount,
      meaningfulContent: meaningful,
      accessRestrictionIndicators: restriction_indicators,
    };
  } catch (error) {
    return {
      ...empty_content_evidence(),
      inspectionError: redact_browser_text(describe_error(error), redaction_values, 2_000),
    };
  }
}

function detect_access_restrictions(value: string): string[] {
  const checks: Array<[string, RegExp]> = [
    ["captcha", /\bcaptcha\b|verify you are human/i],
    ["antibot_challenge", /checking your browser|attention required|security challenge|cloudflare ray id/i],
    ["access_denied", /access denied|request blocked|you have been blocked|forbidden/i],
    ["authentication_required", /authentication required|sign in to continue|login required/i],
    ["rate_limited", /too many requests|rate limit exceeded/i],
  ];
  return checks.filter(([, pattern]) => pattern.test(value)).map(([name]) => name);
}

function empty_content_evidence(): BrowserStageContentEvidence {
  return {
    inspected: false,
    meaningfulContent: false,
    accessRestrictionIndicators: [],
  };
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
}): BrowserStageResult {
  const memory = process.memoryUsage();
  const resource = process.resourceUsage();
  return {
    schemaVersion: 2,
    entered: input.phase !== "PRE_BROWSER",
    outcome: input.outcome,
    originalUrl: redact_browser_text(input.originalUrl, input.redactionValues, 2_000),
    normalizedUrl: redact_browser_text(normalize_diagnostic_url(input.originalUrl), input.redactionValues, 2_000),
    finalUrl: redact_browser_text(input.finalUrl, input.redactionValues, 2_000),
    startedAt: input.startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: Number(input.durationMs.toFixed(3)),
    phase: input.phase,
    operation: operation_for_phase(input.phase),
    attempt: 1,
    timeoutMs: NAVIGATION_TIMEOUT_MS,
    waitUntil: "domcontentloaded",
    redirectChain: input.state.redirectChain,
    ...(input.state.committedUrl
      ? { committedUrl: redact_browser_text(input.state.committedUrl, input.redactionValues, 2_000) }
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

function browser_response_is_failure(
  state: BrowserObservationState,
  content: BrowserStageContentEvidence,
): boolean {
  const status = state.mainDocumentStatus;
  return Boolean(
    status === 401 || status === 403 || status === 429 ||
    (status !== undefined && status >= 500) ||
    content.accessRestrictionIndicators.length > 0,
  );
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
