import { summarize_ai_assistance } from "../../../../shared_files_orchestrator/ai_observability_(Support).js";
import type { ReportSection } from "../../../../shared_files_orchestrator/outreach_types_(Support).js";
import type {
  FormChannelOutcome,
  AutomationStatus,
  FormDiscoveryResult,
  FormDiscoveryOutcome,
  FormPopulationResult,
  NetworkSubmissionRequestSummary,
  SubmissionAssessment,
} from "../../shared_files_forms/forms_types_(Support).js";

/*
 * Forms reporting normalizes FormChannelOutcome and returns form-owned report
 * sections. The macro aggregate reporter adds RUN and writes the final file.
 */

/*
 * ========================================================================
 * TOP_LEVEL_WORKFLOW_FUNCTIONS
 * ========================================================================
 */

/*
 * ========================================================================
 * FORM CHANNEL OUTCOME CREATION - create_form_channel_outcome(...)
 * ========================================================================
 * Input:  Results accumulated by discovery, population, and submission stages.
 * Output: The normalized final status consumed by the CLI reporter.
 *
 * Responsibility: Apply the POC's success semantics in one place so reporting
 * remains stable across all workflow exits.
 * ========================================================================
 */
export function create_form_channel_outcome(
  website_url: string,
  discovery_result: FormDiscoveryResult,
  population_result?: FormPopulationResult,
  submission_assessment?: SubmissionAssessment,
  discovery_outcome?: FormDiscoveryOutcome,
): FormChannelOutcome {
  const reason =
    submission_assessment?.reason ??
    population_result?.blockingReason ??
    discovery_result.reason;
  const failure_kind =
    submission_assessment?.failureKind ??
    population_result?.failureKind ??
    discovery_result.failureKind;

  const signal_evaluation = submission_assessment?.signalEvaluation ?? {
    evaluated: false as const,
    reason: "submission was not attempted",
  };
  let status: AutomationStatus = "FAILED";
  if (signal_evaluation.evaluated) {
    status = signal_evaluation.classification === "success"
      ? "SUCCESS"
      : signal_evaluation.classification === "failure"
        ? "FAILED"
        : "INCONCLUSIVE";
  }
  const authoritative_success = status === "SUCCESS";
  const authoritative_failure_kind = status === "INCONCLUSIVE"
    ? "submission.inconclusive"
    : authoritative_success ? undefined : failure_kind;
  const authoritative_reason = status === "INCONCLUSIVE"
    ? "submission signals balanced to zero"
    : authoritative_success ? undefined : reason;

  const ai_assistance = summarize_ai_assistance(
    discovery_result.aiActions,
    population_result?.aiActions,
    submission_assessment?.aiActions,
  );
  const message_disposition =
    population_result?.messageDisposition ?? discovery_result.messageDisposition;

  return {
    websiteUrl: website_url,
    contactPageFound: discovery_result.contactPageFound,
    formFound: Boolean(discovery_result.candidate),
    ...(discovery_outcome
      ? {
          discovery: {
            assessment: discovery_outcome.assessment,
            presenceEvidenceStrength: discovery_outcome.presenceEvidenceStrength,
            searchCoverage: discovery_outcome.searchCoverage,
            description: discovery_outcome.description,
            assessedAt: discovery_outcome.assessedAt,
          },
        }
      : {}),
    populatedFields: population_result?.populatedFields ?? [],
    ...(message_disposition
      ? { messageDisposition: message_disposition }
      : {}),
    ...(discovery_result.debug
      ? { discoveryDebug: discovery_result.debug }
      : {}),
    ...(population_result?.debug ? { populationDebug: population_result.debug } : {}),
    submissionAttempted: submission_assessment?.attempted ?? false,
    submissionConfirmed: authoritative_success,
    signalEvaluation: signal_evaluation,
    unknownSubmissionSignals: submission_assessment?.unknownSubmissionSignals ?? [],
    status,
    ...(authoritative_failure_kind ? { failureKind: authoritative_failure_kind } : {}),
    ...(authoritative_reason ? { reason: authoritative_reason } : {}),
    ...(submission_assessment?.postClickDisposition
      ? { postClickDisposition: submission_assessment.postClickDisposition }
      : {}),
    ...(submission_assessment?.confirmationEvidence
      ? {
          confirmationEvidence: submission_assessment.confirmationEvidence,
        }
      : {}),
    ...(submission_assessment?.rejectionEvidence
      ? { rejectionEvidence: submission_assessment.rejectionEvidence }
      : {}),
    ...(submission_assessment?.debug
      ? { submissionDebug: submission_assessment.debug }
      : {}),
    ...(ai_assistance ? { aiAssistance: ai_assistance } : {}),
  };
}

/*
 * ========================================================================
 * FAILURE OUTCOME CREATION - create_failure_outcome(...)
 * ========================================================================
 * Input:  The best known website URL and a concise failure reason.
 * Output: A normalized failed automation outcome.
 *
 * Responsibility: Convert expected early failures into the stable result shape
 * used by both the CLI and tests.
 * ========================================================================
 */
export function create_form_failure_outcome(
  website_url: string,
  reason: string,
  failure_kind: FormChannelOutcome["failureKind"] = "runtime.error",
  discovery_outcome?: FormDiscoveryOutcome,
): FormChannelOutcome {
  return {
    websiteUrl: website_url,
    contactPageFound: false,
    formFound: false,
    ...(discovery_outcome
      ? {
          discovery: {
            assessment: discovery_outcome.assessment,
            presenceEvidenceStrength: discovery_outcome.presenceEvidenceStrength,
            searchCoverage: discovery_outcome.searchCoverage,
            description: discovery_outcome.description,
            assessedAt: discovery_outcome.assessedAt,
          },
        }
      : {}),
    populatedFields: [],
    submissionAttempted: false,
    submissionConfirmed: false,
    signalEvaluation: { evaluated: false, reason: "submission was not attempted" },
    unknownSubmissionSignals: [],
    status: "FAILED",
    reason,
    failureKind: failure_kind,
  };
}

/*
 * ========================================================================
 * FORM REPORT SECTIONS - build_form_report_sections(...)
 * ========================================================================
 * Input:  A normalized automation outcome.
 * Output: The stable human-readable report text.
 *
 * Responsibility: Render the exact report contract printed by the CLI and
 * persisted to the selected output file.
 * ========================================================================
 */
export function build_form_report_sections(
  outcome: FormChannelOutcome,
  output_path?: string,
): ReportSection[] {
  const sections: ReportSection[] = [];
  const signal_evaluation = outcome.signalEvaluation ?? {
    evaluated: false as const,
    reason: "submission signal evaluation is unavailable",
  };
  const unknown_submission_signals = outcome.unknownSubmissionSignals ?? [];

  add_section(sections, "RESULT", [
    `Status: ${outcome.status}`,
    ...(outcome.reason ? [`Reason: ${outcome.reason}`] : []),
    ...(outcome.failureKind ? [`Failure kind: ${outcome.failureKind}`] : []),
  ]);

  add_section(sections, "DISCOVERY", [
    `Contact page found: ${yes_or_no(outcome.contactPageFound)}`,
    `Form found: ${yes_or_no(outcome.formFound)}`,
    ...(outcome.discovery
      ? [
          `Assessment: ${outcome.discovery.assessment}`,
          `Presence evidence strength: ${outcome.discovery.presenceEvidenceStrength}`,
          `Search coverage: ${outcome.discovery.searchCoverage}`,
          `Discovery description: ${outcome.discovery.description}`,
          `Assessed at: ${outcome.discovery.assessedAt}`,
        ]
      : []),
  ]);

  add_section(sections, "POPULATION", [
    `Fields populated: ${outcome.populatedFields.join(", ") || "none"}`,
    ...(outcome.messageDisposition
      ? [`Message disposition: ${outcome.messageDisposition}`]
      : []),
  ]);

  add_section(sections, "SUBMISSION", [
    `Attempted: ${yes_or_no(outcome.submissionAttempted)}`,
    `Confirmed: ${yes_or_no(outcome.submissionConfirmed)}`,
    `Signal evaluation: ${signal_evaluation.evaluated ? "evaluated" : "not evaluated"}`,
    ...(signal_evaluation.evaluated
      ? [
          `Signal result: ${signal_evaluation.displayResult}`,
          `Signal score: ${signal_evaluation.totalScore}`,
          `Signal rulebook version: ${signal_evaluation.rulebookVersion}`,
          `Signal polarities: positive=${yes_or_no(signal_evaluation.hasPositiveSignals)}, negative=${yes_or_no(signal_evaluation.hasNegativeSignals)}, both=${yes_or_no(signal_evaluation.hasBothPolarities)}`,
          ...signal_evaluation.ledger.map((entry) =>
            `Signal: ${entry.retained ? "retained" : "suppressed"} | ${entry.signalId}${entry.variantId ? `/${entry.variantId}` : ""} | ${entry.score > 0 ? "+" : ""}${entry.score} | ${entry.evidenceSummary}${entry.suppressionReason ? ` | ${entry.suppressionReason}` : ""}`,
          ),
        ]
      : [`Signal evaluation reason: ${signal_evaluation.reason}`]),
    `Unknown signal count: ${unknown_submission_signals.length}`,
    ...unknown_submission_signals.map((candidate) =>
      `Unknown signal: ${candidate.kind} | ${candidate.fingerprint} | ${candidate.summary} | ${candidate.reason}`,
    ),
    ...(outcome.postClickDisposition ??
    outcome.submissionDebug?.postClickDisposition
      ? [
          `Post-click disposition: ${outcome.postClickDisposition ?? outcome.submissionDebug?.postClickDisposition}`,
        ]
      : []),
    ...((outcome.rejectionEvidence?.length ?? 0) > 0 ||
    (outcome.submissionDebug?.rejectionEvidenceCount ?? 0) > 0
      ? [
          `Rejection evidence: ${outcome.rejectionEvidence?.length ?? outcome.submissionDebug?.rejectionEvidenceCount ?? 0} (${
            outcome.rejectionEvidence
              ? [
                  ...new Set(
                    outcome.rejectionEvidence.map(
                      (evidence) => evidence.category,
                    ),
                  ),
                ].join(", ")
              : outcome.submissionDebug?.rejectionCategories?.join(", ") ||
                "unclassified"
          })`,
        ]
      : []),
    `Confirmation evidence: ${format_confirmation_evidence(outcome.confirmationEvidence ?? outcome.submissionDebug?.confirmationEvidence ?? "none")}`,
  ]);

  if (outcome.submissionDebug) {
    add_section(sections, "NETWORK", [
      `Network submission evidence: ${yes_or_no(outcome.submissionDebug.networkSubmissionEvidenceFound)} (${outcome.submissionDebug.networkSubmissionEvidenceConfidence})`,
      `Network rejection evidence: ${yes_or_no(outcome.submissionDebug.networkSubmissionRejectsSubmission ?? false)}`,
      ...(outcome.submissionDebug.networkSubmissionProviderRuleId
        ? [
            `Network provider rule: ${outcome.submissionDebug.networkSubmissionProviderRuleId}`,
          ]
        : []),
      `Best submission request: ${format_network_submission_request(outcome.submissionDebug.bestNetworkSubmissionRequest)}`,
      `Network evidence reason: ${outcome.submissionDebug.networkSubmissionEvidenceReason}`,
    ]);
  }

  const ai_assistance = outcome.aiAssistance;
  const usage = ai_assistance?.usage;
  const llm_operations_attempted = ai_assistance?.actionCount ?? 0;
  const llm_workflow_invoked =
    llm_operations_attempted > 0 || (usage?.requestCount ?? 0) > 0;
  const model = usage?.model ?? ai_assistance?.actions[0]?.model;
  add_section(sections, "AI ASSISTANCE", [
    `LLM workflow invoked: ${yes_or_no(llm_workflow_invoked)}`,
    `LLM operations attempted: ${llm_operations_attempted}`,
    `LLM requests attempted: ${usage?.requestCount ?? 0}`,
    `LLM requests completed: ${usage?.completedRequestCount ?? 0}`,
    `LLM requests failed: ${usage?.failedRequestCount ?? 0}`,
    `Actions recorded: ${llm_operations_attempted}`,
    `Actions accepted: ${ai_assistance?.acceptedActionCount ?? 0}`,
    `Actions rejected: ${ai_assistance?.rejectedActionCount ?? 0}`,
    ...(model ? [`Model: ${model}`] : []),
    ...(usage
      ? [
          `LLM requests: ${usage.requestCount}`,
          `Input tokens: ${usage.promptTokens}`,
          `Output tokens: ${usage.completionTokens}`,
          `Reasoning tokens: ${usage.reasoningTokens}`,
          `Cached input tokens: ${usage.cachedInputTokens}`,
          `Total tokens: ${usage.totalTokens}`,
          `Cost (USD): ${format_ai_cost(usage.costUsd, usage.costUnavailableRequestCount)}`,
        ]
      : []),
  ]);

  const artifact_lines = [
    ...(output_path ? [`Report: ${output_path}`] : []),
    ...(outcome.submissionDebug
      ? [`Debug artifacts: ${outcome.submissionDebug.artifactDirectory}`]
      : []),
    ...(outcome.populationDebug
      ? [`Missing-fields report: ${outcome.populationDebug.reportPath}`]
      : []),
    ...(outcome.discoveryDebug
      ? [`Discovery diagnostics: ${outcome.discoveryDebug.reportPath}`]
      : []),
    ...(outcome.discoveryDebug?.screenshotPath
      ? [`Discovery screenshot: ${outcome.discoveryDebug.screenshotPath}`]
      : []),
    ...(outcome.aiAssistance?.artifactPath
      ? [`AI actions: ${outcome.aiAssistance.artifactPath}`]
      : []),
    ...(outcome.deepDebug
      ? [
          `Deep-debug directory: ${outcome.deepDebug.artifactDirectory}`,
          `Deep-debug manifest: ${outcome.deepDebug.manifestPath}`,
          `Deep-debug timeline: ${outcome.deepDebug.timelinePath}`,
          `Deep-debug summary: ${outcome.deepDebug.summaryPath}`,
          `Deep-debug events: ${outcome.deepDebug.eventCount}`,
          `Deep-debug artifact errors: ${outcome.deepDebug.artifactErrorCount}`,
          `Deep-debug dropped/truncated: ${outcome.deepDebug.truncatedEventCount}`,
        ]
      : []),
  ];
  if (artifact_lines.length > 0) {
    add_section(sections, "ARTIFACTS", artifact_lines);
  }

  return sections;
}

function format_ai_cost(
  cost_usd: number | undefined,
  unavailable_request_count: number,
): string {
  if (cost_usd === undefined) {
    return "unavailable (provider did not return generation cost)";
  }

  const suffix =
    unavailable_request_count > 0
      ? `; ${unavailable_request_count} request(s) unavailable`
      : "";
  return `$${cost_usd.toFixed(8)}${suffix}`;
}

/*
 * ========================================================================
 * STEP_LEVEL_HELPER_FUNCTIONS
 * ========================================================================
 *
 * yes_or_no(...) - Convert booleans to stable report words.
 * ========================================================================
 */

function yes_or_no(value: boolean): "yes" | "no" {
  return value ? "yes" : "no";
}

function add_section(
  sections: ReportSection[],
  title: string,
  lines: string[],
): void {
  sections.push({ title, lines });
}

function format_confirmation_evidence(value: string): string {
  switch (value) {
    case "successText":
      return "success text";
    case "successUrl":
      return "success URL";
    case "network":
      return "network";
    case "aiVisibleText":
      return "AI-verified visible text";
    default:
      return "none";
  }
}

function format_network_submission_request(
  request: NetworkSubmissionRequestSummary | undefined,
): string {
  if (!request) {
    return "none";
  }

  return `${request.method} ${request.status ?? "no-status"} ${request.url}`;
}
