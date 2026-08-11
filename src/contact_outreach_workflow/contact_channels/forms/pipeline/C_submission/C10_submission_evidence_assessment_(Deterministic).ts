import type {
  AutomationFailureKind,
  NetworkSubmissionEvidenceSummary,
  SubmissionConfirmationEvidence,
  SubmissionPostClickDisposition,
  SubmissionRejectionEvidence,
} from "../../shared_files_forms/forms_types_(Support).js";
import type { SubmissionVisibleEvidence } from "./C2_submission_types_(Support).js";
import {
  score_submission_signals,
  type SubmissionSignalScoreResult,
  type UnknownSubmissionSignalCandidate,
} from "../../shared_files_forms/submission_signal_scoring_(Deterministic).js";
import { createHash } from "node:crypto";

export interface AuthoritativeSubmissionEvidenceInput {
  visibleEvidence: SubmissionVisibleEvidence;
  networkEvidence: NetworkSubmissionEvidenceSummary;
  captchaBlocked: boolean;
  stagehandEvidence?: SubmissionConfirmationEvidence;
  urlBeforeSubmission?: string;
  urlAfterSubmission?: string;
  redactionValues?: string[];
}

export interface AuthoritativeSubmissionEvidenceAssessment {
  disposition: SubmissionPostClickDisposition;
  confirmed: boolean;
  confirmationEvidence: SubmissionConfirmationEvidence;
  rejectionEvidence: SubmissionRejectionEvidence[];
  failureKind?: AutomationFailureKind;
  reason?: string;
  signalScore: SubmissionSignalScoreResult;
  unknownSignals: UnknownSubmissionSignalCandidate[];
}

/**
 * Produces the only terminal interpretation of post-click evidence. Strong
 * positive and negative evidence are both retained so contradictions never
 * get silently collapsed into success or rejection.
 */
export function assess_authoritative_submission_evidence({
  visibleEvidence,
  networkEvidence,
  captchaBlocked,
  stagehandEvidence = "none",
  urlBeforeSubmission,
  urlAfterSubmission,
  redactionValues = [],
}: AuthoritativeSubmissionEvidenceInput): AuthoritativeSubmissionEvidenceAssessment {
  const signal_score = score_submission_signals({
    visibleEvidence,
    networkEvidence,
    captchaBlocked,
    stagehandEvidence,
  });
  const unknown_signals = collect_unknown_signals({
    visibleEvidence,
    networkEvidence,
    ...(urlBeforeSubmission ? { urlBeforeSubmission } : {}),
    ...(urlAfterSubmission ? { urlAfterSubmission } : {}),
    redactionValues,
  });
  const rejection_evidence = dedupe_rejection_evidence([
    ...visibleEvidence.rejectionEvidence,
    ...network_rejection_evidence(networkEvidence),
  ]);
  const confirmation_evidence = choose_confirmation_evidence(
    visibleEvidence.confirmationEvidence,
    networkEvidence,
    stagehandEvidence,
  );
  const has_positive = confirmation_evidence !== "none";
  const has_negative = rejection_evidence.length > 0;
  const has_captcha_rejection = rejection_evidence.some(
    (evidence) => evidence.category === "captcha",
  );

  if (has_positive && has_negative) {
    return {
      disposition: "contradictory",
      confirmed: false,
      confirmationEvidence: confirmation_evidence,
      rejectionEvidence: rejection_evidence,
      failureKind: "submission.contradictory",
      reason:
        "submission produced contradictory confirmation and rejection evidence",
      signalScore: signal_score,
      unknownSignals: unknown_signals,
    };
  }

  if (has_positive) {
    return {
      disposition: "confirmed",
      confirmed: true,
      confirmationEvidence: confirmation_evidence,
      rejectionEvidence: [],
      signalScore: signal_score,
      unknownSignals: unknown_signals,
    };
  }

  if (captchaBlocked || has_captcha_rejection) {
    return {
      disposition: "captchaBlocked",
      confirmed: false,
      confirmationEvidence: "none",
      rejectionEvidence: rejection_evidence,
      failureKind: "submission.captcha",
      reason: "CAPTCHA physically blocked submission",
      signalScore: signal_score,
      unknownSignals: unknown_signals,
    };
  }

  if (has_negative) {
    return {
      disposition: "rejected",
      confirmed: false,
      confirmationEvidence: "none",
      rejectionEvidence: rejection_evidence,
      failureKind: "submission.rejected",
      reason: rejection_reason(rejection_evidence),
      signalScore: signal_score,
      unknownSignals: unknown_signals,
    };
  }

  return {
    disposition: "unconfirmed",
    confirmed: false,
    confirmationEvidence: "none",
    rejectionEvidence: [],
    failureKind: "submission.unconfirmed",
    reason: "submission was attempted, but no explicit confirmation appeared",
    signalScore: signal_score,
    unknownSignals: unknown_signals,
  };
}

function collect_unknown_signals(input: Pick<AuthoritativeSubmissionEvidenceInput,
  "visibleEvidence" | "networkEvidence" | "urlBeforeSubmission" | "urlAfterSubmission" | "redactionValues"
>): UnknownSubmissionSignalCandidate[] {
  const candidates: UnknownSubmissionSignalCandidate[] = [];
  const known_visible = input.visibleEvidence.confirmationEvidence !== "none" ||
    input.visibleEvidence.rejectionEvidence.length > 0;
  if (!known_visible) {
    for (const message of input.visibleEvidence.newMessages.slice(0, 10)) {
      const normalized = redact(message.text, input.redactionValues ?? []).replace(/\s+/g, " ").trim().toLowerCase();
      if (normalized.length < 3) continue;
      candidates.push({
        kind: "message",
        fingerprint: fingerprint(`message:${normalized}`),
        summary: normalized.slice(0, 160),
        reason: "new post-click message was not classified as confirmation or rejection",
        details: { frameUrl: safe_url(message.frameUrl), selector: message.selector.slice(0, 160) },
      });
    }
  }
  if (
    input.urlBeforeSubmission && input.urlAfterSubmission &&
    input.urlBeforeSubmission !== input.urlAfterSubmission &&
    input.visibleEvidence.confirmationEvidence !== "successUrl"
  ) {
    candidates.push({
      kind: "url",
      fingerprint: fingerprint(`url:${safe_url(input.urlAfterSubmission)}`),
      summary: safe_url(input.urlAfterSubmission),
      reason: "post-click URL changed but was not classified as a success URL",
      details: { before: safe_url(input.urlBeforeSubmission), after: safe_url(input.urlAfterSubmission) },
    });
  }
  const network = input.networkEvidence;
  if (network.found && !network.confirmsSubmission && !network.rejectsSubmission && network.confidence === "strong") {
    const request = network.bestRequest;
    candidates.push({
      kind: "network",
      fingerprint: fingerprint(`network:${request?.method ?? "unknown"}:${request?.status ?? "missing"}:${safe_url(request?.url ?? "")}`),
      summary: `${request?.method ?? "unknown"} ${request?.status ?? "no-status"} ${safe_url(request?.url ?? "")}`.slice(0, 240),
      reason: "correlated network evidence was not classifiable as confirmation or rejection",
      details: { confidence: network.confidence, providerRuleId: network.providerRuleId ?? null },
    });
  }
  return [...new Map(candidates.map((candidate) => [candidate.fingerprint, candidate])).values()];
}

function redact(value: string, redaction_values: string[]): string {
  return [...new Set(redaction_values.filter((item) => item.length >= 2))]
    .sort((left, right) => right.length - left.length)
    .reduce((text, sensitive) => text.split(sensitive).join("[REDACTED]"), value);
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function safe_url(value: string): string {
  try {
    const parsed = new URL(value);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().slice(0, 500);
  } catch {
    return value.split(/[?#]/, 1)[0]!.slice(0, 500);
  }
}

function choose_confirmation_evidence(
  visible: SubmissionVisibleEvidence["confirmationEvidence"],
  network: NetworkSubmissionEvidenceSummary,
  stagehand: SubmissionConfirmationEvidence,
): SubmissionConfirmationEvidence {
  if (visible === "successText" || visible === "successUrl") {
    return visible;
  }
  if (network.confirmsSubmission) {
    return "network";
  }
  return stagehand;
}

function network_rejection_evidence(
  network: NetworkSubmissionEvidenceSummary,
): SubmissionRejectionEvidence[] {
  if (!network.rejectsSubmission) {
    return [];
  }
  const request = network.bestRejectionRequest ?? network.bestRequest;
  return [
    {
      source: "network",
      category: network.rejectionCategory ?? "server",
      patternId: network.providerRuleId
        ? `network-${network.providerRuleId}`
        : "network-form-request-rejected",
      confidence: "strong",
      ...(request ? { request } : {}),
    },
  ];
}

function rejection_reason(
  evidence: SubmissionRejectionEvidence[],
): string {
  const categories = [...new Set(evidence.map((item) => item.category))];
  if (categories.length === 1 && categories[0] === "validation") {
    return "submission was explicitly rejected by post-submit validation";
  }
  if (categories.length === 1 && categories[0] === "server") {
    return "submission was explicitly rejected by the form service";
  }
  return "submission was explicitly rejected after activation";
}

function dedupe_rejection_evidence(
  evidence: SubmissionRejectionEvidence[],
): SubmissionRejectionEvidence[] {
  const seen = new Set<string>();
  return evidence.filter((item) => {
    const key = [
      item.source,
      item.category,
      item.patternId,
      item.frameUrl ?? "",
      item.selector ?? "",
      item.excerpt ?? "",
      item.request?.url ?? "",
      item.request?.status ?? "",
    ].join("\n");
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
