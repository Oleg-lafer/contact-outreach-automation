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

const CATEGORIES: BrowserFailureCategory[] = [
  "OUR_SYSTEM_FAILURE",
  "DESTINATION_FAILURE",
  "ACCESS_RESTRICTION",
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
  const source = error instanceof Error ? error : new Error(String(error));
  const code = error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : "";
  const stack = redact_browser_text(source.stack ?? "", redactionValues, 4_000);
  return {
    name: source.name || "Error",
    ...(code ? { code } : {}),
    message: redact_browser_text(source.message, redactionValues, 2_000),
    ...(stack
      ? { stackFingerprint: createHash("sha256").update(stack).digest("hex").slice(0, 16) }
      : {}),
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
  ): BrowserStageResult => ({
    ...result,
    category,
    responsibleParty,
    subcategory,
    confidence,
    ruleId,
    reason,
    evidence: [...new Set([...result.evidence, ...evidence])],
  });

  if (result.phase !== "INITIAL_NAVIGATION" && result.phase !== "POST_TIMEOUT_INSPECTION") {
    return failed(
      "OUR_SYSTEM_FAILURE",
      "OUR_SYSTEM",
      phase_subcategory(result.phase),
      "HIGH",
      "BRW-OUR-RUNTIME-PHASE",
      `Our browser runtime failed during ${result.phase.toLowerCase().replaceAll("_", " ")}.`,
      [`phase=${result.phase}`],
    );
  }
  if (
    !result.health.browserConnected ||
    result.health.browserDisconnectedObserved ||
    result.health.contextClosedObserved ||
    result.health.pageCrashObserved ||
    result.health.pageCloseObserved
  ) {
    return failed(
      "OUR_SYSTEM_FAILURE",
      "OUR_SYSTEM",
      result.health.pageCrashObserved ? "page_crash" : "browser_context_or_page_unhealthy",
      "HIGH",
      "BRW-OUR-BROWSER-HEALTH",
      "The browser, context, or page became unhealthy while opening the destination.",
      [
        `browserConnected=${result.health.browserConnected}`,
        `pageCrashObserved=${result.health.pageCrashObserved}`,
        `pageCloseObserved=${result.health.pageCloseObserved}`,
      ],
    );
  }
  if (/err_network_access_denied|proxy authentication|required proxy|eproxy/.test(text)) {
    return failed(
      "OUR_SYSTEM_FAILURE",
      "OUR_SYSTEM",
      /proxy/.test(text) ? "proxy_configuration_or_connection" : "local_network_access_denied",
      "HIGH",
      "BRW-OUR-NETWORK-POLICY",
      "A local network or proxy policy prevented the browser from reaching the destination.",
      [result.mainDocumentFailure ?? result.error?.message ?? "local network policy error"],
    );
  }
  if (/err_insufficient_resources|\benomem\b|out of memory|too many open files|\bemfile\b|\benfile\b|insufficient system resources/.test(text)) {
    return failed(
      "OUR_SYSTEM_FAILURE",
      "OUR_SYSTEM",
      "local_resource_exhaustion",
      "HIGH",
      "BRW-OUR-RESOURCE-EXHAUSTION",
      "The local browser runtime reported explicit resource exhaustion.",
      [result.mainDocumentFailure ?? result.error?.message ?? "local resource exhaustion"],
    );
  }

  const status = result.mainDocumentStatus;
  if (status === 401 || status === 403 || status === 429 || result.content.accessRestrictionIndicators.length > 0) {
    return failed(
      "ACCESS_RESTRICTION",
      status === 429 ? "UNKNOWN" : "DESTINATION",
      status ? `http_${status}` : "antibot_or_captcha_challenge",
      "HIGH",
      "BRW-DESTINATION-ACCESS-RESTRICTION",
      status
        ? `The destination responded to the main document with HTTP ${status}.`
        : "The destination was reached but presented an access-control challenge.",
      [
        ...(status ? [`mainDocumentStatus=${status}`] : []),
        ...result.content.accessRestrictionIndicators,
      ],
    );
  }
  if (/err_cert_|err_ssl_|certificate|tls/.test(text)) {
    return failed(
      "DESTINATION_FAILURE",
      "DESTINATION",
      "tls_or_certificate_failure",
      "HIGH",
      "BRW-DESTINATION-TLS",
      "The destination-specific TLS or certificate negotiation failed while the browser remained healthy.",
      [result.mainDocumentFailure ?? result.error?.message ?? "TLS failure"],
    );
  }
  if (/err_connection_refused|connection refused/.test(text)) {
    return failed(
      "DESTINATION_FAILURE",
      "DESTINATION",
      "connection_refused",
      "HIGH",
      "BRW-DESTINATION-CONNECTION-REFUSED",
      "The destination refused the main-document connection while the browser remained healthy.",
      [result.mainDocumentFailure ?? result.error?.message ?? "connection refused"],
    );
  }
  if (/err_too_many_redirects|redirect loop|too many redirects/.test(text)) {
    return failed(
      "DESTINATION_FAILURE",
      "DESTINATION",
      "redirect_loop",
      "HIGH",
      "BRW-DESTINATION-REDIRECT-LOOP",
      "The destination produced a redirect loop.",
      [`redirectCount=${result.redirectChain.length}`],
    );
  }
  if (status !== undefined && status >= 500) {
    return failed(
      "DESTINATION_FAILURE",
      "DESTINATION",
      "http_5xx",
      "HIGH",
      "BRW-DESTINATION-HTTP-5XX",
      `The destination returned HTTP ${status} for the main document.`,
      [`mainDocumentStatus=${status}`],
    );
  }
  if (/err_name_not_resolved|dns/.test(text)) {
    return failed(
      "UNDETERMINED",
      "THIRD_PARTY_PATH",
      "dns_failure_origin_unknown",
      "LOW",
      "BRW-UNDETERMINED-DNS",
      "DNS resolution failed, but passive browser evidence cannot prove whether the destination DNS or our resolver path was responsible.",
      [result.mainDocumentFailure ?? result.error?.message ?? "DNS failure"],
    );
  }
  if (/timeout|timed out|etimedout/.test(text)) {
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
    );
  }
  if (/err_connection_(reset|closed|aborted)/.test(text)) {
    return failed(
      "UNDETERMINED",
      "UNKNOWN",
      "connection_reset_origin_unknown",
      "MEDIUM",
      "BRW-UNDETERMINED-CONNECTION-RESET",
      "The connection was reset, but the retained evidence cannot prove which side initiated it.",
      [result.mainDocumentFailure ?? result.error?.message ?? "connection reset"],
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
  const loaded = stages.filter((entry) => entry.browserStage.outcome === "LOADED").length;
  const loadedAfterTimeout = stages.filter(
    (entry) => entry.browserStage.outcome === "LOADED_AFTER_TIMEOUT",
  ).length;
  const categorySum = Object.values(categoryCounts).reduce((sum, count) => sum + count, 0);
  return {
    schemaVersion: 1,
    generatedAt: generatedAt.toISOString(),
    totalWebsites: outcomes.length + additionalExclusions.length,
    entered,
    loaded,
    loadedAfterTimeout,
    failures,
    notEntered: outcomes.length + additionalExclusions.length - entered,
    categoryCounts,
    categoryPercentagesOfFailures,
    categoryPercentagesOfEntrants,
    subcategoryCounts,
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
  await Promise.all([
    writeFile(
      resolve(target, "browser-stage-summary.json"),
      `${JSON.stringify(summary, null, 2)}\n`,
      "utf8",
    ),
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
  let output = value;
  for (const secret of [...redactionValues].filter((item) => item.trim().length > 1).sort((a, b) => b.length - a.length)) {
    output = output.replace(new RegExp(escape_regexp(secret), "gi"), "[redacted-contact-value]");
  }
  output = output
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .replace(/(?:\+\d[\d\s().-]{6,}\d|\(\d{2,4}\)[\d\s.-]{4,}\d|\d{2,4}[ -]\d{3,4}[ -]\d{3,4})/g, "[redacted-phone]");
  return output.length > maxLength ? `${output.slice(0, maxLength)}...[truncated]` : output;
}

function phase_subcategory(phase: BrowserStageResult["phase"]): string {
  return phase.toLowerCase();
}

function escape_regexp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
