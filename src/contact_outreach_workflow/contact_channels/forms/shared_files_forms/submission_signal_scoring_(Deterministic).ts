import type {
  NetworkSubmissionEvidenceSummary,
  SubmissionConfirmationEvidence,
  SubmissionRejectionEvidence,
} from "./forms_types_(Support).js";
import {
  submission_signal_rulebook,
  type SubmissionSignalDefinition,
} from "./submission_signal_rulebook_(Support).js";

export interface SubmissionSignalScoringInput {
  visibleEvidence: {
    confirmationEvidence: "successText" | "successUrl" | "none";
    rejectionEvidence: SubmissionRejectionEvidence[];
  };
  networkEvidence: NetworkSubmissionEvidenceSummary;
  captchaBlocked: boolean;
  stagehandEvidence?: SubmissionConfirmationEvidence;
}

export interface SubmissionSignalLedgerEntry {
  signalId: string;
  variantId?: string;
  polarity: "positive" | "negative";
  family: string;
  dedupeGroup: string;
  score: number;
  retained: boolean;
  evidenceSummary: string;
  suppressionReason?: string;
}

export interface SubmissionSignalScoreResult {
  rulebookVersion: string;
  totalScore: number;
  classification: "success" | "failure" | "inconclusive";
  displayResult: string;
  hasPositiveSignals: boolean;
  hasNegativeSignals: boolean;
  hasBothPolarities: boolean;
  ledger: SubmissionSignalLedgerEntry[];
}

export type SubmissionSignalEvaluation =
  | ({ evaluated: true } & SubmissionSignalScoreResult)
  | { evaluated: false; reason: string };

export type UnknownSubmissionSignalKind = "message" | "url" | "network";

export interface UnknownSubmissionSignalCandidate {
  kind: UnknownSubmissionSignalKind;
  fingerprint: string;
  summary: string;
  reason: string;
  details?: Record<string, string | number | boolean | null>;
}

type FixedSignal = Extract<SubmissionSignalDefinition, { scoring: "fixed" }>;
type NetworkSignal = Extract<SubmissionSignalDefinition, { scoring: "variants" }>;

interface MatchedScore {
  score: number;
  evidenceSummary: string;
  variantId?: string;
}

const fixed_signal_match = (
  signal: FixedSignal,
  input: SubmissionSignalScoringInput,
): MatchedScore | undefined => {
  const evidence = signal.evidence;
  if (evidence.kind === "confirmation") {
    const actual =
      evidence.source === "visibleEvidence.confirmationEvidence"
        ? input.visibleEvidence.confirmationEvidence
        : input.stagehandEvidence ?? "none";
    return actual === evidence.equals
      ? { score: signal.score, evidenceSummary: `${evidence.source}=${actual}` }
      : undefined;
  }
  if (evidence.kind === "boolean") {
    return input.captchaBlocked === evidence.equals
      ? {
          score: signal.score,
          evidenceSummary: `${evidence.source}=${String(input.captchaBlocked)}`,
        }
      : undefined;
  }
  const matching = input.visibleEvidence.rejectionEvidence.filter(
    (item) =>
      item.category === evidence.category &&
      evidence.allowedEvidenceSources.includes(item.source as "visibleMessage"),
  );
  if (matching.length === 0) return undefined;
  return {
    score: signal.score,
    evidenceSummary: matching
      .map((item) => `${item.source}:${item.category}:${item.patternId}`)
      .join(" | "),
  };
};

const network_signal_match = (
  signal: NetworkSignal,
  input: SubmissionSignalScoringInput,
): MatchedScore | undefined => {
  const network = input.networkEvidence;
  if (network[signal.evidence.outcomeField] !== true) return undefined;
  const request =
    signal.evidence.requestSelection === "bestRequest"
      ? network.bestRequest
      : network.bestRejectionRequest ?? network.bestRequest;
  const status = request?.status;
  const has_provider_rule = Boolean(network.providerRuleId);
  const variant = [...signal.variants]
    .sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id))
    .find((candidate) => {
      if (candidate.providerRule === "present" && !has_provider_rule) return false;
      if (candidate.status === "missing") return status === undefined;
      return (
        status !== undefined &&
        candidate.statusMinimum !== undefined &&
        candidate.statusMaximum !== undefined &&
        status >= candidate.statusMinimum &&
        status <= candidate.statusMaximum
      );
    });
  if (!variant) return undefined;
  return {
    score: variant.score,
    variantId: variant.id,
    evidenceSummary: [
      `status=${status ?? "missing"}`,
      `providerRuleId=${network.providerRuleId ?? "none"}`,
      `confidence=${network.confidence}`,
      request?.method ? `method=${request.method}` : "",
    ]
      .filter(Boolean)
      .join(", "),
  };
};

const matched_entry = (
  signal: SubmissionSignalDefinition,
  input: SubmissionSignalScoringInput,
): SubmissionSignalLedgerEntry | undefined => {
  const matched =
    signal.scoring === "fixed"
      ? fixed_signal_match(signal, input)
      : network_signal_match(signal, input);
  if (!matched) return undefined;
  return {
    signalId: signal.id,
    ...(matched.variantId ? { variantId: matched.variantId } : {}),
    polarity: signal.polarity,
    family: signal.family,
    dedupeGroup: signal.dedupeGroup,
    score: matched.score,
    retained: true,
    evidenceSummary: matched.evidenceSummary,
  };
};

const apply_deduplication = (
  entries: SubmissionSignalLedgerEntry[],
): SubmissionSignalLedgerEntry[] => {
  const strategies = new Map(
    submission_signal_rulebook.deduplication.groupResolution.map((definition) => [
      definition.group,
      definition.strategy,
    ]),
  );
  const groups = new Map<string, SubmissionSignalLedgerEntry[]>();
  for (const entry of entries) {
    const group = groups.get(entry.dedupeGroup) ?? [];
    group.push(entry);
    groups.set(entry.dedupeGroup, group);
  }
  for (const [group_id, group] of groups) {
    if (group.length < 2) continue;
    const strategy = strategies.get(group_id);
    if (!strategy) continue;
    const winner = [...group].sort((left, right) => {
      if (strategy === "highest_positive_score") return right.score - left.score;
      if (strategy === "lowest_negative_score") return left.score - right.score;
      return Math.abs(right.score) - Math.abs(left.score);
    })[0];
    for (const entry of group) {
      if (entry === winner) continue;
      entry.retained = false;
      entry.suppressionReason = `Suppressed by ${strategy} in ${group_id}.`;
    }
  }
  return entries;
};

export const score_submission_signals = (
  input: SubmissionSignalScoringInput,
): SubmissionSignalScoreResult => {
  const ledger = apply_deduplication(
    submission_signal_rulebook.signals
      .map((signal) => matched_entry(signal, input))
      .filter((entry): entry is SubmissionSignalLedgerEntry => entry !== undefined),
  );
  const retained = ledger.filter((entry) => entry.retained);
  const total_score = retained.reduce((sum, entry) => sum + entry.score, 0);
  const has_positive = retained.some((entry) => entry.score > 0);
  const has_negative = retained.some((entry) => entry.score < 0);
  const classification =
    total_score > 0 ? "success" : total_score < 0 ? "failure" : "inconclusive";
  return {
    rulebookVersion: submission_signal_rulebook.rulebookVersion,
    totalScore: total_score,
    classification,
    displayResult:
      classification === "success"
        ? `Success ${total_score}`
        : classification === "failure"
          ? `Failure ${total_score}`
          : "Inconclusive",
    hasPositiveSignals: has_positive,
    hasNegativeSignals: has_negative,
    hasBothPolarities: has_positive && has_negative,
    ledger,
  };
};
