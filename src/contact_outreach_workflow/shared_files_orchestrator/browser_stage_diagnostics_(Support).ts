import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  BrowserFailureCategory,
  BrowserStageErrorEvidence,
  BrowserStageResult,
  BrowserStageRunSummary,
  ContactOutreachOutcome,
} from "./outreach_types_(Support).js";
import { redact_diagnostic_text } from "./diagnostic_redaction_(Support).js";

const CATEGORIES: BrowserFailureCategory[] = [
  "OUR_AUTOMATION",
  "DESTINATION_WEBSITE",
  "ACCESS_RESTRICTION",
  "NETWORK_INFRASTRUCTURE",
  "UNDETERMINED",
];

export class BrowserStageError extends Error {
  public readonly browserStage: BrowserStageResult;

  public constructor(message: string, browserStage: BrowserStageResult, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "BrowserStageError";
    this.browserStage = browserStage;
  }
}

export function normalize_browser_stage_error(
  error: unknown,
  redactionValues: readonly string[],
): BrowserStageErrorEvidence {
  return normalize_error_cause(error, redactionValues, new Set<unknown>(), 0);
}

function normalize_error_cause(
  error: unknown,
  redactionValues: readonly string[],
  seen: Set<unknown>,
  depth: number,
): BrowserStageErrorEvidence {
  const source = error instanceof Error ? error : new Error(String(error));
  const code = error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : "";
  const stack = redact_browser_text(source.stack ?? "", redactionValues, 12_000);
  const cause = source.cause;
  const canCaptureCause = cause !== undefined && depth < 8 && !seen.has(cause);
  seen.add(error);
  return {
    name: source.name || "Error",
    ...(code ? { code } : {}),
    message: redact_browser_text(source.message, redactionValues, 2_000),
    ...(stack ? {
      stack,
      stackFingerprint: createHash("sha256").update(stack).digest("hex").slice(0, 16),
    } : {}),
    ...(canCaptureCause ? { cause: normalize_error_cause(cause, redactionValues, seen, depth + 1) } : {}),
  };
}

export function classify_browser_stage_failure(
  result: BrowserStageResult,
): BrowserStageResult {
  if (result.outcome !== "FAILED") return result;
  const text = [
    result.error?.message,
    result.error?.code,
    result.mainDocumentFailure,
    ...result.content.accessRestrictionIndicators,
  ].filter(Boolean).join(" ").toLowerCase();
  const failed = (
    category: BrowserFailureCategory,
    responsibleParty: NonNullable<BrowserStageResult["responsibleParty"]>,
    subcategory: string,
    confidence: NonNullable<BrowserStageResult["confidence"]>,
    ruleId: string,
    reason: string,
    evidence: string[],
    basis: NonNullable<BrowserStageResult["classificationBasis"]>,
    evidenceAgainst = "No contradictory evidence was recorded.",
    missingEvidence: string[] = [],
  ): BrowserStageResult => ({
    ...result,
    category,
    responsibleParty,
    subcategory,
    confidence,
    ruleId,
    reason,
    evidence: [...new Set([...result.evidence, ...evidence])],
    strongestSupportingEvidence: evidence[0] ?? reason,
    strongestEvidenceAgainst: evidenceAgainst,
    classificationBasis: basis,
    missingEvidence: [...new Set([...result.missingEvidence, ...missingEvidence])],
  });

  if (result.phase !== "INITIAL_NAVIGATION" && result.phase !== "POST_TIMEOUT_INSPECTION") {
    return failed(
      "OUR_AUTOMATION",
      "OUR_AUTOMATION",
      phase_subcategory(result.phase),
      "HIGH",
      "BRW-OUR-RUNTIME-PHASE",
      `Our browser runtime failed during ${result.phase.toLowerCase().replaceAll("_", " ")}.`,
      [`phase=${result.phase}`],
      "DIRECT",
    );
  }
  if (
    !result.health.browserConnected ||
    result.health.browserDisconnectedObserved ||
    result.health.contextClosedObserved ||
    result.health.pageCrashObserved ||
    result.health.pageCloseObserved
  ) {
    const initiatedByOurAutomation = [
      result.health.browserDisconnectInitiator,
      result.health.contextCloseInitiator,
      result.health.pageCloseInitiator,
    ].includes("OUR_AUTOMATION");
    return failed(
      "OUR_AUTOMATION",
      "OUR_AUTOMATION",
      result.health.pageCrashObserved ? "page_crash" : "browser_context_or_page_unhealthy",
      "HIGH",
      "BRW-OUR-BROWSER-HEALTH",
      "The browser, context, or page became unhealthy while opening the destination.",
      [
        `browserConnected=${result.health.browserConnected}`,
        `pageCrashObserved=${result.health.pageCrashObserved}`,
        `pageCloseObserved=${result.health.pageCloseObserved}`,
        `closureInitiator=${initiatedByOurAutomation ? "OUR_AUTOMATION" : "unknown"}`,
      ],
      initiatedByOurAutomation ? "DIRECT" : "INFERRED",
      "The retained evidence does not establish why the browser runtime became unhealthy.",
      initiatedByOurAutomation
        ? ["whether the locally initiated closure was expected at this workflow point"]
        : ["browser process exit reason", "lifecycle event initiator", "host resource pressure at event time"],
    );
  }
  if (/err_network_access_denied|proxy authentication|required proxy|eproxy/.test(text)) {
    return failed(
      "OUR_AUTOMATION",
      "OUR_AUTOMATION",
      /proxy/.test(text) ? "proxy_configuration_or_connection" : "local_network_access_denied",
      "HIGH",
      "BRW-OUR-NETWORK-POLICY",
      "A local network or proxy policy prevented the browser from reaching the destination.",
      [result.mainDocumentFailure ?? result.error?.message ?? "local network policy error"],
      "DIRECT",
    );
  }
  if (/err_insufficient_resources|\benomem\b|out of memory|too many open files|\bemfile\b|\benfile\b|insufficient system resources/.test(text)) {
    return failed(
      "OUR_AUTOMATION",
      "OUR_AUTOMATION",
      "local_resource_exhaustion",
      "HIGH",
      "BRW-OUR-RESOURCE-EXHAUSTION",
      "The local browser runtime reported explicit resource exhaustion.",
      [result.mainDocumentFailure ?? result.error?.message ?? "local resource exhaustion"],
      "DIRECT",
    );
  }

  const status = result.mainDocumentStatus;
  if (status === 401 || status === 403 || status === 429) {
    return failed(
      "ACCESS_RESTRICTION",
      "ACCESS_RESTRICTION",
      `http_${status}`,
      "HIGH",
      "BRW-DESTINATION-ACCESS-RESTRICTION",
      `The destination responded to the main document with HTTP ${status}.`,
      [
        `mainDocumentStatus=${status}`,
        ...result.content.accessRestrictionIndicators,
      ],
      "DIRECT",
    );
  }
  if (status !== undefined && status >= 500) {
    return failed(
      "DESTINATION_WEBSITE",
      "DESTINATION_WEBSITE",
      "http_5xx",
      "HIGH",
      "BRW-DESTINATION-HTTP-5XX",
      `The destination returned HTTP ${status} for the main document.`,
      [`mainDocumentStatus=${status}`],
      "DIRECT",
    );
  }
  if (/err_cert_|err_ssl_|certificate|tls/.test(text)) {
    return failed(
      "DESTINATION_WEBSITE",
      "DESTINATION_WEBSITE",
      "tls_or_certificate_failure",
      "HIGH",
      "BRW-DESTINATION-TLS",
      "The destination-specific TLS or certificate negotiation failed while the browser remained healthy.",
      [result.mainDocumentFailure ?? result.error?.message ?? "TLS failure"],
      "INFERRED",
      "A client-side TLS configuration incompatibility cannot be excluded from passive evidence.",
      ["independent TLS probe", "peer certificate chain details"],
    );
  }
  if (/err_connection_refused|connection refused/.test(text)) {
    return failed(
      "DESTINATION_WEBSITE",
      "DESTINATION_WEBSITE",
      "connection_refused",
      "HIGH",
      "BRW-DESTINATION-CONNECTION-REFUSED",
      "The destination refused the main-document connection while the browser remained healthy.",
      [result.mainDocumentFailure ?? result.error?.message ?? "connection refused"],
      "INFERRED",
      "Passive browser evidence cannot exclude an intermediary rejecting the connection.",
    );
  }
  if (/err_too_many_redirects|redirect loop|too many redirects/.test(text)) {
    return failed(
      "DESTINATION_WEBSITE",
      "DESTINATION_WEBSITE",
      "redirect_loop",
      "HIGH",
      "BRW-DESTINATION-REDIRECT-LOOP",
      "The destination produced a redirect loop.",
      [`redirectCount=${result.redirectChain.length}`],
      "DIRECT",
    );
  }
  if (/err_name_not_resolved|dns/.test(text)) {
    return failed(
      "NETWORK_INFRASTRUCTURE",
      "NETWORK_INFRASTRUCTURE",
      "dns_resolution_failure",
      "MEDIUM",
      "BRW-NETWORK-DNS",
      "Chromium reported DNS resolution failure; the failing DNS authority or resolver path remains unknown.",
      [result.mainDocumentFailure ?? result.error?.message ?? "DNS failure"],
      "INFERRED",
      "The evidence does not distinguish destination DNS configuration from the local resolver path.",
      ["resolver query result", "authoritative DNS response"],
    );
  }
  if (/timeout|timed out|etimedout/.test(text)) {
    const progressBeforeTimeout = result.mainDocumentReceived || result.redirectChain.length > 1;
    if (result.timeoutSource === "PLAYWRIGHT_NAVIGATION" && progressBeforeTimeout) {
      return failed(
        "OUR_AUTOMATION",
        "OUR_AUTOMATION",
        "navigation_timeout_policy_ended_progressing_load",
        "MEDIUM",
        "BRW-OUR-TIMEOUT-WITH-PROGRESS",
        "Our configured navigation deadline ended a navigation after destination progress had been observed.",
        [
          `timeoutSource=${result.timeoutSource}`,
          `mainDocumentReceived=${result.mainDocumentReceived}`,
          `redirectCount=${result.redirectChain.length}`,
        ],
        "DIRECT",
        "The page had not produced meaningful usable content before the deadline.",
        ["whether waiting longer would have completed navigation"],
      );
    }
    return failed(
      "UNDETERMINED",
      "UNKNOWN",
      result.mainDocumentReceived
        ? "navigation_timeout_without_usable_content"
        : "navigation_timeout_before_main_document",
      "LOW",
      "BRW-UNDETERMINED-NAVIGATION-TIMEOUT",
      "The navigation timed out without enough evidence to assign responsibility honestly.",
      [
        `mainDocumentReceived=${result.mainDocumentReceived}`,
        `meaningfulContent=${result.content.meaningfulContent}`,
      ],
      "INFERRED",
      "The configured timeout may have contributed, but no continuing destination progress was retained.",
      ["DNS/TCP/TLS phase timing", "independent destination reachability", "progress after the deadline"],
    );
  }
  if (/err_connection_(reset|closed|aborted)|err_http2_|err_empty_response/.test(text)) {
    return failed(
      "NETWORK_INFRASTRUCTURE",
      "NETWORK_INFRASTRUCTURE",
      "connection_reset",
      "MEDIUM",
      "BRW-UNDETERMINED-CONNECTION-RESET",
      "The connection was reset, but the retained evidence cannot prove which side initiated it.",
      [result.mainDocumentFailure ?? result.error?.message ?? "connection reset"],
      "INFERRED",
      "The evidence cannot identify whether the destination, an intermediary, or the client network reset the connection.",
      ["packet-level reset origin"],
    );
  }
  if ((status === undefined || (status >= 200 && status < 300)) && result.content.accessRestrictionIndicators.length > 0) {
    return failed(
      "ACCESS_RESTRICTION",
      "ACCESS_RESTRICTION",
      "antibot_or_captcha_challenge",
      "HIGH",
      "BRW-DESTINATION-CONTENT-ACCESS-RESTRICTION",
      "The destination was reached but presented an access-control challenge.",
      [...result.content.accessRestrictionIndicators],
      "DIRECT",
    );
  }
  if (status !== undefined && status >= 400 && status < 500) {
    return failed(
      "DESTINATION_WEBSITE",
      "DESTINATION_WEBSITE",
      `http_${status}`,
      "HIGH",
      "BRW-DESTINATION-HTTP-4XX",
      `The destination returned HTTP ${status} for the main document.`,
      [`mainDocumentStatus=${status}`],
      "DIRECT",
    );
  }
  if (result.pageQuality !== "USABLE") {
    const subcategory = page_quality_subcategory(result.pageQuality, status);
    return failed(
      result.pageQuality === "INSPECTION_FAILED" ? "OUR_AUTOMATION" : "DESTINATION_WEBSITE",
      result.pageQuality === "INSPECTION_FAILED" ? "OUR_AUTOMATION" : "DESTINATION_WEBSITE",
      subcategory,
      result.pageQuality === "UNUSABLE" ? "MEDIUM" : "HIGH",
      `BRW-PAGE-QUALITY-${result.pageQuality}`,
      page_quality_reason(result.pageQuality, status),
      [
        `pageQuality=${result.pageQuality}`,
        ...(status !== undefined ? [`mainDocumentStatus=${status}`] : []),
        ...result.pageQualityEvidence,
      ],
      "DIRECT",
    );
  }
  if (result.content.meaningfulContent && result.content.accessRestrictionIndicators.length === 0) {
    return failed(
      "OUR_AUTOMATION",
      "OUR_AUTOMATION",
      "usable_navigation_misclassified_as_failure",
      "HIGH",
      "BRW-OUR-MISCLASSIFIED-USABLE-CONTENT",
      "Our browser-stage decision marked a healthy page with meaningful usable content as failed.",
      ["meaningfulContent=true", `mainDocumentStatus=${status ?? "none"}`],
      "DIRECT",
    );
  }
  return failed(
    "UNDETERMINED",
    "UNKNOWN",
    "unknown_browser_failure",
    "LOW",
    "BRW-UNDETERMINED-UNKNOWN",
    "The browser-stage evidence is insufficient to assign responsibility.",
    [result.error?.message ?? "unknown browser-stage failure"],
    "INFERRED",
    "No evidence supports a more specific competing classification.",
    [
      "network phase details",
      "browser lifecycle initiator",
      "complete causal exception chain",
      "independent reachability evidence",
    ],
  );
}

export function create_browser_stage_run_summary(
  outcomes: readonly ContactOutreachOutcome[],
  generatedAt = new Date(),
  additionalExclusions: ReadonlyArray<{ websiteUrl: string; reason: string }> = [],
): BrowserStageRunSummary {
  const stages = outcomes.flatMap((outcome) =>
    outcome.browserStage ? [{
      siteId: String(
        outcome.browserStage.runContext?.websiteId ??
        outcome.browserStage.runContext?.siteOrdinal ??
        outcome.websiteUrl,
      ),
      websiteUrl: outcome.websiteUrl,
      browserStage: outcome.browserStage,
    }] : [],
  );
  const ledger = stages.filter((entry) => entry.browserStage.outcome === "FAILED");
  const preBrowserExclusions = [
    ...outcomes.flatMap((outcome) =>
    outcome.browserStage
      ? []
      : [{ websiteUrl: outcome.websiteUrl, reason: outcome.reason ?? "Browser stage was not entered." }],
    ),
    ...additionalExclusions,
  ];
  const categoryCounts = Object.fromEntries(
    CATEGORIES.map((category) => [
      category,
      ledger.filter((entry) => entry.browserStage.category === category).length,
    ]),
  ) as Record<BrowserFailureCategory, number>;
  const failures = ledger.length;
  const categoryPercentagesOfFailures = Object.fromEntries(
    CATEGORIES.map((category) => [
      category,
      failures === 0 ? 0 : Number(((categoryCounts[category] / failures) * 100).toFixed(2)),
    ]),
  ) as Record<BrowserFailureCategory, number>;
  const entered = stages.filter((entry) => entry.browserStage.entered).length;
  const categoryPercentagesOfEntrants = Object.fromEntries(
    CATEGORIES.map((category) => [
      category,
      entered === 0 ? 0 : Number(((categoryCounts[category] / entered) * 100).toFixed(2)),
    ]),
  ) as Record<BrowserFailureCategory, number>;
  const subcategoryCounts = Object.fromEntries(
    [...new Set(ledger.map((entry) => entry.browserStage.subcategory ?? "unknown_browser_failure"))]
      .sort()
      .map((subcategory) => [
        subcategory,
        ledger.filter((entry) => (entry.browserStage.subcategory ?? "unknown_browser_failure") === subcategory).length,
      ]),
  );
  const ourAutomationSubcategoryCounts = Object.fromEntries(
    [...new Set(
      ledger
        .filter((entry) => entry.browserStage.category === "OUR_AUTOMATION")
        .map((entry) => entry.browserStage.subcategory ?? "unknown_automation_failure"),
    )].sort().map((subcategory) => [
      subcategory,
      ledger.filter((entry) =>
        entry.browserStage.category === "OUR_AUTOMATION" &&
        (entry.browserStage.subcategory ?? "unknown_automation_failure") === subcategory
      ).length,
    ]),
  );
  const loaded = stages.filter((entry) => entry.browserStage.outcome === "LOADED").length;
  const loadedAfterTimeout = stages.filter(
    (entry) => entry.browserStage.outcome === "LOADED_AFTER_TIMEOUT",
  ).length;
  const usablePages = stages.filter((entry) =>
    (entry.browserStage.outcome === "LOADED" || entry.browserStage.outcome === "LOADED_AFTER_TIMEOUT") &&
    entry.browserStage.mainDocumentStatus !== undefined &&
    entry.browserStage.mainDocumentStatus >= 200 && entry.browserStage.mainDocumentStatus < 300 &&
    entry.browserStage.pageQuality === "USABLE"
  ).length;
  const transportLoaded = stages.filter((entry) => entry.browserStage.mainDocumentReceived).length;
  const recoveryEligible = stages.filter((entry) => entry.browserStage.recoveryEligible).length;
  const recoveredUsable = stages.filter((entry) =>
    entry.browserStage.recovered && entry.browserStage.pageQuality === "USABLE"
  ).length;
  const falseLoaded = stages.filter((entry) =>
    (entry.browserStage.outcome === "LOADED" || entry.browserStage.outcome === "LOADED_AFTER_TIMEOUT") &&
    entry.browserStage.pageQuality !== "USABLE"
  ).length;
  const totalWebsites = outcomes.length + additionalExclusions.length;
  const categorySum = Object.values(categoryCounts).reduce((sum, count) => sum + count, 0);
  return {
    schemaVersion: 3,
    generatedAt: generatedAt.toISOString(),
    totalWebsites,
    entered,
    loaded,
    loadedAfterTimeout,
    failures,
    notEntered: outcomes.length + additionalExclusions.length - entered,
    categoryCounts,
    categoryPercentagesOfFailures,
    categoryPercentagesOfEntrants,
    subcategoryCounts,
    ourAutomationSubcategoryCounts,
    kpis: {
      usablePages,
      usableBrowserStageSuccessRate: percentage(usablePages, totalWebsites),
      transportLoaded,
      transportLoadRate: percentage(transportLoaded, totalWebsites),
      recoveryEligible,
      recoveredUsable,
      recoveryYield: percentage(recoveredUsable, recoveryEligible),
      falseLoaded,
      preBrowser: preBrowserExclusions.length,
    },
    ledger,
    preBrowserExclusions,
    reconciliation: {
      entrantsEqualLoadedPlusFailures: entered === loaded + loadedAfterTimeout + failures,
      failuresEqualCategorySum: failures === categorySum,
      failuresEqualLedgerRows: failures === ledger.length,
      ledgerSiteIdsUnique: new Set(ledger.map((entry) => entry.siteId)).size === ledger.length,
    },
  };
}

export async function write_browser_stage_run_summary_files(
  directory: string,
  summary: BrowserStageRunSummary,
): Promise<void> {
  const target = resolve(directory);
  await mkdir(target, { recursive: true });
  const categoryFiles = CATEGORIES.map((category) =>
    writeFile(
      resolve(target, `browser-stage-${category.toLowerCase().replaceAll("_", "-")}.csv`),
      format_browser_stage_failure_csv({
        ...summary,
        ledger: summary.ledger.filter((entry) => entry.browserStage.category === category),
      }),
      "utf8",
    )
  );
  await Promise.all([
    writeFile(
      resolve(target, "browser-stage-summary.json"),
      `${JSON.stringify(summary, null, 2)}\n`,
      "utf8",
    ),
    ...categoryFiles,
    writeFile(
      resolve(target, "browser-stage-summary.txt"),
      format_browser_stage_summary(summary),
      "utf8",
    ),
    writeFile(
      resolve(target, "browser-stage-failures.csv"),
      format_browser_stage_failure_csv(summary),
      "utf8",
    ),
  ]);
}

export function format_browser_stage_summary(summary: BrowserStageRunSummary): string {
  const lines = [
    "BROWSER-STAGE DEEP-DEBUG SUMMARY",
    "================================",
    `Generated: ${summary.generatedAt}`,
    `Total websites: ${summary.totalWebsites}`,
    `Entered browser stage: ${summary.entered}`,
    `Loaded: ${summary.loaded}`,
    `Loaded after navigation timeout: ${summary.loadedAfterTimeout}`,
    `Browser-stage failures: ${summary.failures}`,
    `Did not enter browser stage: ${summary.notEntered}`,
    "",
    "BROWSER KPI",
    `Usable pages: ${summary.kpis.usablePages} (${summary.kpis.usableBrowserStageSuccessRate.toFixed(2)}% of all selected websites)`,
    `Transport loaded: ${summary.kpis.transportLoaded} (${summary.kpis.transportLoadRate.toFixed(2)}% of all selected websites)`,
    `Recovery eligible: ${summary.kpis.recoveryEligible}`,
    `Recovered usable: ${summary.kpis.recoveredUsable} (${summary.kpis.recoveryYield.toFixed(2)}% recovery yield)`,
    `False loaded: ${summary.kpis.falseLoaded}`,
    `Pre-browser: ${summary.kpis.preBrowser}`,
    "",
    "FAILURE CATEGORIES",
    ...CATEGORIES.map((category) =>
      `${category}: ${summary.categoryCounts[category]} (${summary.categoryPercentagesOfFailures[category].toFixed(2)}% of browser failures; ${summary.categoryPercentagesOfEntrants[category].toFixed(2)}% of entrants)`
    ),
    "",
    "FAILURE SUBCATEGORIES",
    ...(Object.keys(summary.subcategoryCounts).length === 0
      ? ["none"]
      : Object.entries(summary.subcategoryCounts).map(([subcategory, count]) => `${subcategory}: ${count}`)),
    "",
    "OUR AUTOMATION BREAKDOWN",
    ...(Object.keys(summary.ourAutomationSubcategoryCounts).length === 0
      ? ["none"]
      : Object.entries(summary.ourAutomationSubcategoryCounts).map(([subcategory, count]) => `${subcategory}: ${count}`)),
    "",
    "RECONCILIATION",
    `Entrants equal loaded plus failures: ${summary.reconciliation.entrantsEqualLoadedPlusFailures ? "yes" : "NO"}`,
    `Failures equal category sum: ${summary.reconciliation.failuresEqualCategorySum ? "yes" : "NO"}`,
    `Failures equal ledger rows: ${summary.reconciliation.failuresEqualLedgerRows ? "yes" : "NO"}`,
    `Ledger site IDs unique: ${summary.reconciliation.ledgerSiteIdsUnique ? "yes" : "NO"}`,
    "",
    "FAILURE LEDGER",
    ...(summary.ledger.length === 0
      ? ["none"]
      : summary.ledger.map((entry) =>
          `${entry.siteId} | ${entry.websiteUrl} | ${entry.browserStage.category} | ${entry.browserStage.subcategory} | ` +
          `${entry.browserStage.responsibleParty} | ${entry.browserStage.reason ?? "no reason"}`
        )),
    "",
    "PRE-BROWSER EXCLUSIONS",
    ...(summary.preBrowserExclusions.length === 0
      ? ["none"]
      : summary.preBrowserExclusions.map((entry) => `${entry.websiteUrl} | ${entry.reason}`)),
  ];
  return `${lines.join("\n")}\n`;
}

function format_browser_stage_failure_csv(summary: BrowserStageRunSummary): string {
  const rows = [
    [
      "site_id", "website_url", "category", "responsible_party", "subcategory", "confidence", "rule_id",
      "phase", "operation", "duration_ms", "main_document_received", "main_document_status",
      "meaningful_content", "reason", "diagnostic_artifact_path",
      "classification_basis", "strongest_supporting_evidence", "strongest_evidence_against",
      "missing_evidence", "timeout_source", "last_progress_at", "last_progress_type",
      "attempt_count", "selected_candidate_kind", "page_quality", "recovery_eligible", "recovered",
    ],
    ...summary.ledger.map(({ siteId, websiteUrl, browserStage }) => [
      siteId,
      websiteUrl,
      browserStage.category ?? "",
      browserStage.responsibleParty ?? "",
      browserStage.subcategory ?? "",
      browserStage.confidence ?? "",
      browserStage.ruleId ?? "",
      browserStage.phase,
      browserStage.operation,
      browserStage.durationMs,
      browserStage.mainDocumentReceived,
      browserStage.mainDocumentStatus ?? "",
      browserStage.content.meaningfulContent,
      browserStage.reason ?? "",
      browserStage.diagnosticArtifactPath ?? "",
      browserStage.classificationBasis ?? "",
      browserStage.strongestSupportingEvidence ?? "",
      browserStage.strongestEvidenceAgainst ?? "",
      browserStage.missingEvidence.join(" | "),
      browserStage.timeoutSource ?? "",
      browserStage.lastProgressAt ?? "",
      browserStage.lastProgressType ?? "",
      browserStage.navigationAttempts.length,
      browserStage.selectedCandidateKind,
      browserStage.pageQuality,
      browserStage.recoveryEligible,
      browserStage.recovered,
    ]),
  ];
  return `${rows.map((row) => row.map(csv_value).join(",")).join("\n")}\n`;
}

function csv_value(value: unknown): string {
  return `"${String(value).replaceAll('"', '""')}"`;
}

export function redact_browser_text(
  value: string,
  redactionValues: readonly string[],
  maxLength: number,
): string {
  return redact_diagnostic_text(value, redactionValues, maxLength);
}

function percentage(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Number(((numerator / denominator) * 100).toFixed(2));
}

function page_quality_subcategory(
  quality: BrowserStageResult["pageQuality"],
  status: number | undefined,
): string {
  if (status === 204) return "http_204_no_content";
  switch (quality) {
    case "EMPTY": return "empty_page";
    case "PARKED": return "parked_domain";
    case "EXPIRED": return "expired_site";
    case "SITE_ERROR": return "destination_error_page";
    case "INSECURE_TRANSPORT": return "insecure_transport";
    case "INSPECTION_FAILED": return "page_inspection_failed";
    case "HTTP_ERROR": return "http_error_page";
    case "ACCESS_RESTRICTED": return "antibot_or_captcha_challenge";
    case "UNUSABLE": return "unusable_page";
    case "USABLE": return "usable_page";
  }
}

function page_quality_reason(
  quality: BrowserStageResult["pageQuality"],
  status: number | undefined,
): string {
  if (status === 204) return "The destination returned HTTP 204 with no page content.";
  const reasons: Record<BrowserStageResult["pageQuality"], string> = {
    USABLE: "The page is usable.",
    ACCESS_RESTRICTED: "The page presented an access restriction.",
    HTTP_ERROR: "The page returned or rendered an HTTP error.",
    EMPTY: "The destination rendered an empty page.",
    PARKED: "The destination appears to be a parked domain.",
    EXPIRED: "The destination indicates that the site or domain expired.",
    SITE_ERROR: "The destination rendered a deterministic site error page.",
    INSECURE_TRANSPORT: "The page is not safe for form population or submission.",
    INSPECTION_FAILED: "Our browser could not inspect the committed page.",
    UNUSABLE: "The committed page did not contain meaningful usable content.",
  };
  return reasons[quality];
}
function phase_subcategory(phase: BrowserStageResult["phase"]): string {
  return phase.toLowerCase();
}
