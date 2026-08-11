import type {
  CountAndSites,
  FormSignalDispositionStatistics,
  FormSignalPolarity,
  FormSignalStatistic,
  FormSignalStatistics,
  FormSignalStatusCounts,
  FormStatusBucket,
  SiteEvidence,
} from "./analytics_types.js";
import { FORM_SIGNAL_RULEBOOK_VERSION } from "./analytics_types.js";

interface SignalDefinition {
  polarity: FormSignalPolarity;
  family: string;
  type: string;
  value: string;
  description: string;
}

interface SignalGroup {
  definition: SignalDefinition;
  sites: SiteEvidence[];
}

const percentage = (numerator: number, denominator: number): number =>
  denominator === 0 ? 0 : Number(((numerator / denominator) * 100).toFixed(2));

const countAndSites = (sites: SiteEvidence[]): CountAndSites => ({
  count: sites.length,
  siteIds: sites.map((site) => site.id),
});

const statusBucket = (status: string): FormStatusBucket => {
  const normalized = status.trim().toUpperCase();
  return normalized === "SUCCESS" || normalized === "INCONCLUSIVE" || normalized === "PARTIAL" || normalized === "FAILED"
    ? normalized
    : "OTHER";
};

const emptyStatusCounts = (): FormSignalStatusCounts => ({
  SUCCESS: 0,
  INCONCLUSIVE: 0,
  PARTIAL: 0,
  FAILED: 0,
  OTHER: 0,
});

const signalKey = (definition: SignalDefinition): string =>
  [
    definition.polarity,
    definition.family,
    definition.type,
    definition.family === "message_variant"
      ? definition.value.normalize("NFKC").toLowerCase()
      : definition.value,
  ].join("\u0000");

const addSignal = (
  groups: Map<string, SignalGroup>,
  site: SiteEvidence,
  definition: SignalDefinition,
): void => {
  const key = signalKey(definition);
  const existing = groups.get(key);
  if (existing) {
    if (!existing.sites.some((candidate) => candidate.id === site.id)) existing.sites.push(site);
    return;
  }
  groups.set(key, { definition, sites: [site] });
};

const seedSignal = (
  groups: Map<string, SignalGroup>,
  definition: SignalDefinition,
): void => {
  const key = signalKey(definition);
  if (!groups.has(key)) groups.set(key, { definition, sites: [] });
};

const positiveDefinition = (
  family: string,
  type: string,
  value: string,
  description: string,
): SignalDefinition => ({ polarity: "positive", family, type, value, description });

const negativeDefinition = (
  family: string,
  type: string,
  value: string,
  description: string,
): SignalDefinition => ({ polarity: "negative", family, type, value, description });

const seedKnownSignalTypes = (groups: Map<string, SignalGroup>): void => {
  for (const definition of [
    positiveDefinition(
      "confirmation",
      "visible_success_text",
      "success_text",
      "A newly visible message explicitly confirmed that the form was submitted, sent, or received.",
    ),
    positiveDefinition(
      "confirmation",
      "success_url",
      "success_url",
      "The browser navigated to a URL whose path explicitly indicated successful submission.",
    ),
    positiveDefinition(
      "confirmation",
      "ai_verified_visible_text",
      "ai_visible_text",
      "The bounded AI fallback verified a newly visible explicit submission confirmation.",
    ),
    positiveDefinition(
      "confirmation",
      "network_confirmation",
      "network",
      "A correlated form-like state-changing request returned a successful HTTP status.",
    ),
    positiveDefinition(
      "network_response_class",
      "http_response_class",
      "2xx",
      "The confirming form-like request returned a 2xx response.",
    ),
    positiveDefinition(
      "network_response_class",
      "http_response_class",
      "3xx",
      "The confirming form-like request returned a 3xx response.",
    ),
    ...["generic_first_party", "known_form_service", "provider_rule"].map((basis) =>
      positiveDefinition(
        "network_correlation",
        "correlation_basis",
        basis,
        basis === "generic_first_party"
          ? "A form-like request was correlated by first-party host and request content."
          : basis === "known_form_service"
            ? "A form-like request matched a known form-service heuristic."
            : "A form-like request matched a bounded provider-specific rule.",
      ),
    ),
    ...(["validation", "captcha", "server", "generic"] as const).map((category) =>
      negativeDefinition(
        "rejection_category",
        "explicit_rejection",
        category,
        `Explicit post-click ${category} rejection evidence was recorded.`,
      ),
    ),
    negativeDefinition(
      "rejection_source",
      "network_rejection",
      "network",
      "A correlated form-like request was explicitly rejected by the server or transport.",
    ),
    negativeDefinition(
      "rejection_source",
      "visible_message_rejection",
      "visible_message",
      "A newly visible message explicitly rejected the submission.",
    ),
    negativeDefinition(
      "captcha",
      "captcha_blocked",
      "captcha_blocked",
      "CAPTCHA physically blocked or explicitly rejected the submission.",
    ),
    negativeDefinition(
      "contradiction",
      "positive_and_negative_evidence",
      "contradictory",
      "Strong positive and negative evidence were both recorded for the same attempt.",
    ),
    negativeDefinition(
      "network_transport",
      "transport_failure",
      "request_failed",
      "The correlated form-like request failed at the network transport layer.",
    ),
    negativeDefinition(
      "network_response_class",
      "http_response_class",
      "4xx",
      "The rejected form-like request returned a 4xx response.",
    ),
    negativeDefinition(
      "network_response_class",
      "http_response_class",
      "5xx",
      "The rejected form-like request returned a 5xx response.",
    ),
  ]) {
    seedSignal(groups, definition);
  }
};

const networkConfirmsSubmission = (site: SiteEvidence): boolean => {
  const evidence = site.submissionSignals;
  if (evidence.confirmationEvidence === "network") return true;
  const status = evidence.networkBestRequest?.status;
  return (
    evidence.networkEvidenceFound === true &&
    evidence.networkConfidence === "strong" &&
    status !== null &&
    status !== undefined &&
    status >= 200 &&
    status < 400
  );
};

const networkCorrelationBasis = (providerRuleId: string): string => {
  if (!providerRuleId) return "generic_first_party";
  if (providerRuleId === "existing-known-form-service") return "known_form_service";
  return "provider_rule";
};

const addPositiveSignals = (groups: Map<string, SignalGroup>, site: SiteEvidence): void => {
  const evidence = site.submissionSignals;
  if (evidence.confirmationEvidence === "success_text") {
    addSignal(
      groups,
      site,
      positiveDefinition(
        "confirmation",
        "visible_success_text",
        "success_text",
        "A newly visible message explicitly confirmed that the form was submitted, sent, or received.",
      ),
    );
  }
  if (evidence.confirmationEvidence === "success_url") {
    addSignal(
      groups,
      site,
      positiveDefinition(
        "confirmation",
        "success_url",
        "success_url",
        "The browser navigated to a URL whose path explicitly indicated successful submission.",
      ),
    );
  }
  if (evidence.confirmationEvidence === "ai_visible_text") {
    addSignal(
      groups,
      site,
      positiveDefinition(
        "confirmation",
        "ai_verified_visible_text",
        "ai_visible_text",
        "The bounded AI fallback verified a newly visible explicit submission confirmation.",
      ),
    );
  }

  if (networkConfirmsSubmission(site)) {
    addSignal(
      groups,
      site,
      positiveDefinition(
        "confirmation",
        "network_confirmation",
        "network",
        "A correlated form-like state-changing request returned a successful HTTP status.",
      ),
    );
    const request = evidence.networkBestRequest;
    if (request?.status !== null && request?.status !== undefined) {
      addSignal(
        groups,
        site,
        positiveDefinition(
          "network_http_status",
          "http_status",
          String(request.status),
          `The confirming form-like request returned HTTP ${request.status}.`,
        ),
      );
      const responseClass = `${Math.floor(request.status / 100)}xx`;
      addSignal(
        groups,
        site,
        positiveDefinition(
          "network_response_class",
          "http_response_class",
          responseClass,
          `The confirming form-like request returned a ${responseClass} response.`,
        ),
      );
    }
    const basis = networkCorrelationBasis(evidence.networkProviderRuleId);
    addSignal(
      groups,
      site,
      positiveDefinition(
        "network_correlation",
        "correlation_basis",
        basis,
        basis === "generic_first_party"
          ? "A form-like request was correlated by first-party host and request content."
          : basis === "known_form_service"
            ? "A form-like request matched a known form-service heuristic."
            : "A form-like request matched a bounded provider-specific rule.",
      ),
    );
    if (evidence.networkProviderRuleId) {
      addSignal(
        groups,
        site,
        positiveDefinition(
          "network_provider",
          "provider_rule",
          evidence.networkProviderRuleId,
          "The confirming request matched this deterministic provider rule.",
        ),
      );
    }
  }

  for (const message of evidence.messageSignals.filter((item) => item.polarity === "positive")) {
    addSignal(
      groups,
      site,
      positiveDefinition(
        "message_variant",
        message.signalType,
        message.text,
        "A bounded, redacted exact visible confirmation message recorded by deep-debug evidence.",
      ),
    );
  }
};

const addNegativeSignals = (groups: Map<string, SignalGroup>, site: SiteEvidence): void => {
  const evidence = site.submissionSignals;
  for (const category of evidence.rejectionCategories) {
    addSignal(
      groups,
      site,
      negativeDefinition(
        "rejection_category",
        "explicit_rejection",
        category,
        `Explicit post-click ${category} rejection evidence was recorded.`,
      ),
    );
  }

  if (evidence.postClickDisposition === "rejected") {
    addSignal(
      groups,
      site,
      negativeDefinition(
        "rejection",
        "explicit_rejection",
        "rejected",
        "The authoritative post-click assessment found explicit rejection evidence.",
      ),
    );
  }
  if (evidence.postClickDisposition === "captchaBlocked") {
    addSignal(
      groups,
      site,
      negativeDefinition(
        "captcha",
        "captcha_blocked",
        "captcha_blocked",
        "CAPTCHA physically blocked or explicitly rejected the submission.",
      ),
    );
  }
  if (evidence.postClickDisposition === "contradictory") {
    addSignal(
      groups,
      site,
      negativeDefinition(
        "contradiction",
        "positive_and_negative_evidence",
        "contradictory",
        "Strong positive and negative evidence were both recorded for the same attempt.",
      ),
    );
  }

  if (evidence.networkRejectsSubmission === true) {
    addSignal(
      groups,
      site,
      negativeDefinition(
        "rejection_source",
        "network_rejection",
        "network",
        "A correlated form-like request was explicitly rejected by the server or transport.",
      ),
    );
    const request =
      evidence.networkBestRejectionRequest ??
      (evidence.networkBestRequest?.status !== null &&
      evidence.networkBestRequest?.status !== undefined &&
      evidence.networkBestRequest.status >= 400
        ? evidence.networkBestRequest
        : undefined);
    if (request?.status !== null && request?.status !== undefined && request.status >= 400) {
      addSignal(
        groups,
        site,
        negativeDefinition(
          "network_http_status",
          "http_status",
          String(request.status),
          `The rejected form-like request returned HTTP ${request.status}.`,
        ),
      );
      const responseClass = `${Math.floor(request.status / 100)}xx`;
      addSignal(
        groups,
        site,
        negativeDefinition(
          "network_response_class",
          "http_response_class",
          responseClass,
          `The rejected form-like request returned a ${responseClass} response.`,
        ),
      );
    }
    if (/form-like request failed:/i.test(evidence.networkReason)) {
      addSignal(
        groups,
        site,
        negativeDefinition(
          "network_transport",
          "transport_failure",
          "request_failed",
          "The correlated form-like request failed at the network transport layer.",
        ),
      );
    }
    if (evidence.networkProviderRuleId) {
      addSignal(
        groups,
        site,
        negativeDefinition(
          "network_provider",
          "provider_rule",
          evidence.networkProviderRuleId,
          "The rejected request matched this deterministic provider rule.",
        ),
      );
    }
  }

  for (const message of evidence.messageSignals.filter((item) => item.polarity === "negative")) {
    addSignal(
      groups,
      site,
      negativeDefinition(
        "message_variant",
        message.category || message.signalType,
        message.text,
        "A bounded, redacted exact rejection message recorded by deep-debug evidence.",
      ),
    );
    if (message.source === "visibleMessage") {
      addSignal(
        groups,
        site,
        negativeDefinition(
          "rejection_source",
          "visible_message_rejection",
          "visible_message",
          "A newly visible message explicitly rejected the submission.",
        ),
      );
    }
  }
};

const emittedSignalFamily = (signalId: string): string => {
  if (signalId.includes("network")) return "network";
  if (signalId.includes("captcha")) return "captcha";
  if (signalId === "validation_rejection") return "validation";
  if (signalId === "success_url") return "success_url";
  if (signalId.includes("success")) return "visible_confirmation";
  if (signalId.includes("rejection")) return "visible_rejection";
  return "emitted_signal";
};

const addEmittedSignals = (groups: Map<string, SignalGroup>, site: SiteEvidence): void => {
  for (const entry of site.submissionSignals.arithmetic.ledger.filter((item) => item.state === "retained")) {
    if (entry.score === 0) continue;
    addSignal(groups, site, {
      polarity: entry.score > 0 ? "positive" : "negative",
      family: emittedSignalFamily(entry.signalId),
      type: entry.signalId,
      value: entry.variantId || entry.signalId,
      description: "Authoritative retained signal emitted by the workflow scoring rulebook.",
    });
  }
};

const statistics = (
  groups: Map<string, SignalGroup>,
  polarity: FormSignalPolarity,
  attemptedCount: number,
  processedCount: number,
): FormSignalStatistic[] =>
  [...groups.values()]
    .filter((group) => group.definition.polarity === polarity)
    .map((group) => {
      const statusCounts = emptyStatusCounts();
      for (const site of group.sites) statusCounts[statusBucket(site.status)] += 1;
      return {
        polarity,
        signalFamily: group.definition.family,
        signalType: group.definition.type,
        signalValue: group.definition.value,
        description: group.definition.description,
        count: group.sites.length,
        percentageOfSubmissionAttempts: percentage(group.sites.length, attemptedCount),
        percentageOfProcessedSites: percentage(group.sites.length, processedCount),
        statusCounts,
        siteIds: group.sites.map((site) => site.id),
      };
    })
    .sort(
      (left, right) =>
        left.signalFamily.localeCompare(right.signalFamily) ||
        left.signalType.localeCompare(right.signalType) ||
        right.count - left.count ||
        left.signalValue.localeCompare(right.signalValue),
    );

const dispositionStatistics = (sites: SiteEvidence[]): FormSignalDispositionStatistics => {
  const group = (value: string): CountAndSites =>
    countAndSites(sites.filter((site) => site.submissionSignals.postClickDisposition === value));
  const known = new Set(["confirmed", "rejected", "contradictory", "captchaBlocked", "unconfirmed", ""]);
  return {
    confirmed: group("confirmed"),
    rejected: group("rejected"),
    contradictory: group("contradictory"),
    captchaBlocked: group("captchaBlocked"),
    unconfirmed: group("unconfirmed"),
    missing: group(""),
    other: countAndSites(
      sites.filter((site) => !known.has(site.submissionSignals.postClickDisposition)),
    ),
  };
};

const neutralNetworkObservations = (sites: SiteEvidence[]): Record<string, CountAndSites> => {
  const definitions: Array<[string, (site: SiteEvidence) => boolean]> = [
    [
      "no_form_like_request",
      (site) => /no form-like post-click network request was found/i.test(site.submissionSignals.networkReason),
    ],
    [
      "tracking_only",
      (site) => /only tracking or analytics post-click network requests were found/i.test(site.submissionSignals.networkReason),
    ],
    [
      "submit_click_unavailable",
      (site) => /submit click timestamp was unavailable|submit click timestamp was invalid/i.test(site.submissionSignals.networkReason),
    ],
    [
      "ambiguous_form_like_request",
      (site) =>
        site.submissionSignals.networkEvidenceFound === true &&
        site.submissionSignals.networkRejectsSubmission !== true &&
        !networkConfirmsSubmission(site),
    ],
  ];
  return Object.fromEntries(
    definitions.map(([name, matches]) => [name, countAndSites(sites.filter(matches))]),
  );
};

const signalSiteIds = (items: FormSignalStatistic[]): Set<string> =>
  new Set(items.flatMap((item) => item.siteIds));

const unionSites = (sites: SiteEvidence[], ids: Set<string>): SiteEvidence[] =>
  sites.filter((site) => ids.has(site.id));

export const analyzeFormSubmissionSignals = (sites: SiteEvidence[]): FormSignalStatistics => {
  const attempted = sites.filter((site) => site.submissionAttempted === true);
  const legacy = attempted.filter((site) => site.submissionSignals.arithmetic.presence === "absent");
  const arithmeticComplete = sites.filter((site) => site.submissionSignals.arithmetic.presence === "complete");
  const arithmeticMalformed = sites.filter((site) => site.submissionSignals.arithmetic.presence === "malformed");
  const groups = new Map<string, SignalGroup>();
  if (legacy.length > 0) seedKnownSignalTypes(groups);
  for (const site of attempted) {
    if (site.submissionSignals.arithmetic.presence === "complete") {
      if (site.submissionSignals.arithmetic.evaluation === "evaluated") addEmittedSignals(groups, site);
    } else if (site.submissionSignals.arithmetic.presence === "absent") {
      addPositiveSignals(groups, site);
      addNegativeSignals(groups, site);
    }
  }
  const positive = statistics(groups, "positive", attempted.length, sites.length);
  const negative = statistics(groups, "negative", attempted.length, sites.length);
  const positiveIds = signalSiteIds(positive);
  const negativeIds = signalSiteIds(negative);
  const bothIds = new Set([...positiveIds].filter((id) => negativeIds.has(id)));
  const allProcessedIds = new Set(sites.map((site) => site.id));
  const allStatistics = [...positive, ...negative];
  const dataQualityWarnings: string[] = [];
  const missingPrimary = sites.filter(
    (site) => site.mode === "full" && !site.submissionSignals.primaryAvailable,
  );
  if (missingPrimary.length > 0) {
    dataQualityWarnings.push(
      `${missingPrimary.length} Full-mode site(s) lack a current structured SUBMISSION section and were not text-inferred.`,
    );
  }
  const malformedRejections = sites.filter(
    (site) =>
      (site.submissionSignals.rejectionEvidenceCount ?? 0) > 0 &&
      site.submissionSignals.rejectionCategories.length === 0,
  );
  if (malformedRejections.length > 0) {
    dataQualityWarnings.push(
      `${malformedRejections.length} site(s) reported rejection evidence without a supported category.`,
    );
  }
  if (arithmeticMalformed.length > 0) {
    dataQualityWarnings.push(
      `${arithmeticMalformed.length} site(s) contain partial or malformed arithmetic signal output; legacy inference was not used for them.`,
    );
  }

  const coverageGroup = (matches: (site: SiteEvidence) => boolean): CountAndSites =>
    countAndSites(sites.filter(matches));
  const statisticCountsMatchUniqueSites = allStatistics.every(
    (item) => item.count === new Set(item.siteIds).size,
  );
  const statusCountsMatchStatisticCounts = allStatistics.every(
    (item) =>
      item.count ===
      item.statusCounts.SUCCESS +
        item.statusCounts.INCONCLUSIVE +
        item.statusCounts.PARTIAL +
        item.statusCounts.FAILED +
        item.statusCounts.OTHER,
  );
  const signalSitesAreProcessed = allStatistics.every((item) =>
    item.siteIds.every((id) => allProcessedIds.has(id)),
  );
  const undefined_groups = new Map<string, {
    kind: string; fingerprint: string; summary: string; reason: string;
    siteIds: Set<string>; modes: Set<string>;
  }>();
  for (const site of sites) {
    for (const candidate of site.unknownSubmissionSignals) {
      const existing = undefined_groups.get(candidate.fingerprint) ?? {
        ...candidate,
        siteIds: new Set<string>(),
        modes: new Set<string>(),
      };
      existing.siteIds.add(site.id);
      existing.modes.add(site.mode);
      undefined_groups.set(candidate.fingerprint, existing);
    }
  }
  const undefinedSignals = [...undefined_groups.values()]
    .map((candidate) => ({
      kind: candidate.kind,
      fingerprint: candidate.fingerprint,
      summary: candidate.summary,
      reason: candidate.reason,
      count: candidate.siteIds.size,
      siteIds: [...candidate.siteIds].sort(),
      modes: [...candidate.modes].sort(),
    }))
    .sort((left, right) => right.count - left.count || left.fingerprint.localeCompare(right.fingerprint));

  const arithmetic_sites = arithmeticComplete.map((site) => {
    const evidence = site.submissionSignals.arithmetic;
    const retained = evidence.ledger.filter((entry) => entry.state === "retained");
    const retainedScoreSum = retained.reduce((sum, entry) => sum + entry.score, 0);
    const positive = retained.some((entry) => entry.score > 0);
    const negative = retained.some((entry) => entry.score < 0);
    const both = positive && negative;
    const expectedClassification = retainedScoreSum > 0
      ? "success"
      : retainedScoreSum < 0
        ? "failure"
        : "inconclusive";
    const expectedStatus = expectedClassification === "success"
      ? "SUCCESS"
      : expectedClassification === "failure"
        ? "FAILED"
        : "INCONCLUSIVE";
    const expectedDisplay = expectedClassification === "success"
      ? `Success ${retainedScoreSum}`
      : expectedClassification === "failure"
        ? `Failure ${retainedScoreSum}`
        : "Inconclusive";
    const evaluated = evidence.evaluation === "evaluated";
    return {
      siteId: site.id,
      status: site.status,
      evaluation: evaluated ? "evaluated" as const : "not_evaluated" as const,
      classification: evaluated ? evidence.classification as "success" | "failure" | "inconclusive" : "not_evaluated" as const,
      displayResult: evidence.displayResult,
      totalScore: evidence.totalScore,
      retainedScoreSum,
      retainedSignalCount: retained.length,
      suppressedSignalCount: evidence.ledger.length - retained.length,
      rulebookVersion: evidence.rulebookVersion,
      arithmeticReconciles: !evaluated || evidence.totalScore === retainedScoreSum,
      statusReconciles: evaluated ? site.status.trim().toUpperCase() === expectedStatus : true,
      polarityReconciles: !evaluated || (
        evidence.hasPositiveSignals === positive &&
        evidence.hasNegativeSignals === negative &&
        evidence.hasBothPolarities === both
      ),
      resultLabelReconciles: !evaluated || (
        evidence.classification === expectedClassification && evidence.displayResult === expectedDisplay
      ),
      unknownCountReconciles:
        evidence.reportedUnknownCount === null || evidence.reportedUnknownCount === site.unknownSubmissionSignals.length,
    };
  });
  const evaluatedArithmetic = arithmetic_sites.filter((site) => site.evaluation === "evaluated");
  const arithmeticByClassification = (classification: "success" | "failure" | "inconclusive") =>
    countAndSites(sites.filter((site) => arithmetic_sites.some(
      (score) => score.siteId === site.id && score.classification === classification,
    )));
  const score_groups = new Map<number, string[]>();
  for (const site of evaluatedArithmetic) {
    if (site.totalScore === null) continue;
    const ids = score_groups.get(site.totalScore) ?? [];
    ids.push(site.siteId);
    score_groups.set(site.totalScore, ids);
  }

  return {
    rulebookVersion: FORM_SIGNAL_RULEBOOK_VERSION,
    processedSites: countAndSites(sites),
    submissionAttemptedSites: countAndSites(attempted),
    sitesWithAnyPositiveSignal: countAndSites(unionSites(sites, positiveIds)),
    sitesWithAnyNegativeSignal: countAndSites(unionSites(sites, negativeIds)),
    sitesWithBothPolarities: countAndSites(unionSites(sites, bothIds)),
    positive,
    negative,
    dispositions: dispositionStatistics(sites),
    coverage: {
      primarySubmissionSections: coverageGroup((site) => site.submissionSignals.primaryAvailable),
      primaryNetworkSections: coverageGroup((site) => site.submissionSignals.networkAvailable),
      debugPathsReported: coverageGroup((site) => site.submissionSignals.debugPathReported),
      debugArtifactsAvailable: coverageGroup((site) => site.submissionSignals.debugArtifactAvailable),
      confirmationEventsAvailable: coverageGroup(
        (site) => site.submissionSignals.confirmationEventsAvailable,
      ),
      messageEnrichedSites: coverageGroup((site) => site.submissionSignals.messageSignals.length > 0),
      malformedDebugArtifacts: coverageGroup((site) => site.submissionSignals.debugArtifactMalformed),
      unsafeDebugPaths: coverageGroup((site) => site.submissionSignals.unsafeDebugPath),
      arithmeticCompleteSites: countAndSites(arithmeticComplete),
      arithmeticMalformedSites: countAndSites(arithmeticMalformed),
      legacyInferredSites: countAndSites(legacy),
    },
    neutralNetworkObservations: neutralNetworkObservations(sites),
    undefinedSignals,
    arithmetic: {
      evaluated: countAndSites(sites.filter((site) => arithmetic_sites.some(
        (score) => score.siteId === site.id && score.evaluation === "evaluated",
      ))),
      notEvaluated: countAndSites(sites.filter((site) => arithmetic_sites.some(
        (score) => score.siteId === site.id && score.evaluation === "not_evaluated",
      ))),
      malformed: countAndSites(arithmeticMalformed),
      classifications: {
        success: arithmeticByClassification("success"),
        failure: arithmeticByClassification("failure"),
        inconclusive: arithmeticByClassification("inconclusive"),
      },
      observedWorkflowRulebookVersions: [...new Set(
        arithmeticComplete.map((site) => site.submissionSignals.arithmetic.rulebookVersion).filter(Boolean),
      )].sort(),
      scoreDistribution: [...score_groups.entries()]
        .map(([score, siteIds]) => ({ score, count: siteIds.length, siteIds: siteIds.sort() }))
        .sort((left, right) => right.score - left.score),
      sites: arithmetic_sites,
    },
    dataQualityWarnings,
    reconciliation: {
      statisticCountsMatchUniqueSites,
      statusCountsMatchStatisticCounts,
      signalSitesAreProcessed,
      polaritySiteCountsMatchUnions:
        positiveIds.size === unionSites(sites, positiveIds).length &&
        negativeIds.size === unionSites(sites, negativeIds).length,
      arithmeticLedgerSumsMatch: arithmetic_sites.every((site) => site.arithmeticReconciles),
      arithmeticStatusesMatch: arithmetic_sites.every((site) => site.statusReconciles),
      arithmeticPolaritiesMatch: arithmetic_sites.every((site) => site.polarityReconciles),
      arithmeticResultLabelsMatch: arithmetic_sites.every((site) => site.resultLabelReconciles),
      reportedUnknownCountsMatch: arithmetic_sites.every((site) => site.unknownCountReconciles),
    },
  };
};
