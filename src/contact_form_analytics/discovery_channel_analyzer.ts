import type {
  CountAndSites,
  DiscoveryChannelAnalyticsResult,
  DiscoveryChannelEvidence,
  DiscoveryChannelName,
  DiscoveryNormalizedOutcome,
  DiscoveryRawStatusBucket,
  DiscoverySiteClassification,
  SiteEvidence,
} from "./analytics_types.js";
import {
  ANALYTICS_SCHEMA_VERSION,
  DISCOVERY_OUTCOMES,
  DISCOVERY_RULEBOOK_VERSION,
} from "./analytics_types.js";

const percentage = (numerator: number, denominator: number): number =>
  denominator === 0 ? 0 : Number(((numerator / denominator) * 100).toFixed(2));

const countAndSites = (sites: DiscoverySiteClassification[]): CountAndSites => ({
  count: sites.length,
  siteIds: sites.map((site) => site.id),
});

const rawStatusBucket = (status: string): DiscoveryRawStatusBucket => {
  const normalized = status.trim().toUpperCase();
  if (normalized === "SUCCESS" || normalized === "PARTIAL" || normalized === "FAILED") return normalized;
  return normalized ? "OTHER" : "MISSING";
};

const evidenceFor = (site: SiteEvidence, channel: DiscoveryChannelName): DiscoveryChannelEvidence =>
  channel === "emails" ? site.emails : site.meetings;

const expectedNoOpportunityFailure = (channel: DiscoveryChannelName): string =>
  channel === "emails" ? "email.discovery.no_address" : "meeting.discovery.no_option";

const expectedExecutionFailure = (channel: DiscoveryChannelName): string =>
  channel === "emails" ? "email.discovery.failed" : "meeting.discovery.failed";

const expectedIncompleteFailure = (channel: DiscoveryChannelName): string =>
  channel === "emails" ? "email.discovery.incomplete" : "meeting.discovery.incomplete";

const hasCompleteCoverage = (evidence: DiscoveryChannelEvidence): boolean =>
  evidence.plannedPages !== null &&
  evidence.plannedPages > 0 &&
  evidence.inspectedPages === evidence.plannedPages &&
  evidence.failedPages === 0;

const contradictoryFields = (
  channel: DiscoveryChannelName,
  evidence: DiscoveryChannelEvidence,
): string[] => {
  if (!evidence.available) return [];
  const contradictions = [...evidence.malformedFields];
  const itemCount = evidence.itemCount ?? 0;
  const planned = evidence.plannedPages ?? 0;
  const inspected = evidence.inspectedPages ?? 0;
  const failed = evidence.failedPages ?? 0;
  const status = evidence.status.toUpperCase();
  const complete = hasCompleteCoverage(evidence);
  if (evidence.itemCount !== null && evidence.itemCount !== evidence.items.length) {
    contradictions.push("reported item count does not match parsed item lines");
  }
  if (channel === "meetings" && evidence.providers.length !== evidence.items.length) {
    contradictions.push("meeting provider count does not match parsed links");
  }
  if (
    evidence.plannedPages !== null &&
    evidence.inspectedPages !== null &&
    evidence.failedPages !== null &&
    (inspected > planned || failed > planned || inspected + failed !== planned)
  ) {
    contradictions.push("planned pages do not reconcile with inspected and failed pages");
  }
  if (status === "SUCCESS" && (itemCount === 0 || !complete)) {
    contradictions.push("SUCCESS requires a discovered item and complete coverage");
  }
  if (status === "PARTIAL" && complete) contradictions.push("PARTIAL cannot have complete coverage");
  if (status === "FAILED" && evidence.failureKind === expectedNoOpportunityFailure(channel) && (itemCount > 0 || !complete)) {
    contradictions.push("no-opportunity failure requires zero items and complete coverage");
  }
  if (status === "FAILED" && evidence.failureKind === expectedExecutionFailure(channel) && inspected > 0) {
    contradictions.push("execution failure cannot report inspected pages");
  }
  if (status === "PARTIAL" && evidence.failureKind && evidence.failureKind !== expectedIncompleteFailure(channel)) {
    contradictions.push("PARTIAL uses an unexpected failure kind");
  }
  return [...new Set(contradictions)];
};

const decision = (
  channel: DiscoveryChannelName,
  evidence: DiscoveryChannelEvidence,
): { outcome: DiscoveryNormalizedOutcome; ruleId: string; evidenceSummary: string } => {
  if (!evidence.available) {
    return {
      outcome: "artifact_incomplete",
      ruleId: "DISCOVERY-ARTIFACT-MISSING",
      evidenceSummary: "The aggregate report contains no channel section.",
    };
  }
  const contradictions = contradictoryFields(channel, evidence);
  if (contradictions.length > 0) {
    return {
      outcome: "conflicting",
      ruleId: "DISCOVERY-CONFLICTING-EVIDENCE",
      evidenceSummary: contradictions.join("; "),
    };
  }
  const itemCount = evidence.itemCount ?? 0;
  const complete = hasCompleteCoverage(evidence);
  if (itemCount > 0) {
    return complete
      ? {
          outcome: "found_complete",
          ruleId: "DISCOVERY-FOUND-COMPLETE",
          evidenceSummary: `${itemCount} item(s) found with complete planned-page coverage.`,
        }
      : {
          outcome: "found_partial",
          ruleId: "DISCOVERY-FOUND-PARTIAL",
          evidenceSummary: `${itemCount} item(s) found, but planned-page coverage was incomplete.`,
        };
  }
  if (complete) {
    return {
      outcome: "no_opportunity",
      ruleId: "DISCOVERY-NO-OPPORTUNITY",
      evidenceSummary: "Complete planned-page inspection found no qualifying opportunity.",
    };
  }
  if (
    evidence.status.toUpperCase() === "FAILED" &&
    (evidence.failureKind === expectedExecutionFailure(channel) || (evidence.inspectedPages ?? 0) === 0)
  ) {
    return {
      outcome: "execution_failed",
      ruleId: "DISCOVERY-EXECUTION-FAILED",
      evidenceSummary: evidence.reason || "Discovery could not inspect any planned page.",
    };
  }
  return {
    outcome: "incomplete",
    ruleId: "DISCOVERY-INCOMPLETE",
    evidenceSummary: evidence.reason || "Discovery inspected only part of the planned page set.",
  };
};

const classifySite = (
  site: SiteEvidence,
  channel: DiscoveryChannelName,
): DiscoverySiteClassification => {
  const evidence = evidenceFor(site, channel);
  const resolved = decision(channel, evidence);
  return {
    id: site.id,
    numericId: site.numericId,
    websiteUrl: site.websiteUrl,
    sourceDirectory: site.directory,
    channel,
    outcome: resolved.outcome,
    ruleId: resolved.ruleId,
    rawStatus: evidence.status,
    reason: evidence.reason,
    failureKind: evidence.failureKind,
    itemCount: evidence.itemCount ?? 0,
    items: evidence.items,
    providers: evidence.providers,
    plannedPages: evidence.plannedPages,
    inspectedPages: evidence.inspectedPages,
    failedPages: evidence.failedPages,
    completeCoverage: hasCompleteCoverage(evidence),
    evidenceSummary: resolved.evidenceSummary,
    sourcePaths: site.sourcePaths,
  };
};

const providerStatistics = (
  sites: DiscoverySiteClassification[],
): Record<string, CountAndSites> | undefined => {
  const providers = new Map<string, { count: number; siteIds: Set<string> }>();
  for (const site of sites) {
    for (const provider of site.providers) {
      const current = providers.get(provider) ?? { count: 0, siteIds: new Set<string>() };
      current.count += 1;
      current.siteIds.add(site.id);
      providers.set(provider, current);
    }
  }
  if (providers.size === 0) return undefined;
  return Object.fromEntries(
    [...providers.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([provider, value]) => [
        provider,
        { count: value.count, siteIds: [...value.siteIds].sort((left, right) => left.localeCompare(right)) },
      ]),
  );
};

export const discoveryChannelRulebook = (channel: DiscoveryChannelName): object => ({
  version: DISCOVERY_RULEBOOK_VERSION,
  channel,
  firstMatchWins: true,
  semantics: {
    no_opportunity: "A complete bounded search found no qualifying opportunity; this is not an automation failure.",
    incomplete: "Some planned evidence could not be inspected, so absence is not conclusive.",
    execution_failed: "No planned page could be inspected or the channel reported an explicit discovery failure.",
    conflicting: "Structured status, item, or coverage fields do not reconcile.",
  },
  rules: [
    "DISCOVERY-ARTIFACT-MISSING",
    "DISCOVERY-CONFLICTING-EVIDENCE",
    "DISCOVERY-FOUND-COMPLETE",
    "DISCOVERY-FOUND-PARTIAL",
    "DISCOVERY-NO-OPPORTUNITY",
    "DISCOVERY-EXECUTION-FAILED",
    "DISCOVERY-INCOMPLETE",
  ],
});

export const analyzeDiscoveryChannel = (
  channel: DiscoveryChannelName,
  evidenceSites: SiteEvidence[],
  plannedCount: number | null,
  runPath: string,
  generatedAt: string,
): DiscoveryChannelAnalyticsResult => {
  const sites = evidenceSites
    .map((site) => classifySite(site, channel))
    .sort((left, right) => left.numericId - right.numericId);
  const rawBuckets: DiscoveryRawStatusBucket[] = ["SUCCESS", "PARTIAL", "FAILED", "MISSING", "OTHER"];
  const rawStatuses = Object.fromEntries(
    rawBuckets.map((value) => [value, countAndSites(sites.filter((site) => rawStatusBucket(site.rawStatus) === value))]),
  ) as DiscoveryChannelAnalyticsResult["counts"]["rawStatuses"];
  const outcomes = Object.fromEntries(
    DISCOVERY_OUTCOMES.map((value) => [value, countAndSites(sites.filter((site) => site.outcome === value))]),
  ) as DiscoveryChannelAnalyticsResult["counts"]["outcomes"];
  const completeCoverageSites = sites.filter((site) => site.completeCoverage);
  const incompleteCoverageSites = sites.filter((site) => !site.completeCoverage);
  const uniqueItems = new Set(sites.flatMap((site) => site.items));
  const completeSearches = outcomes.found_complete.count + outcomes.no_opportunity.count;
  const outcomeTotal = Object.values(outcomes).reduce((total, value) => total + value.count, 0);
  const itemCountsMatchParsedItems = sites.every((site) => site.itemCount === site.items.length);
  const counts = {
    planned: plannedCount,
    processed: sites.length,
    notStarted: plannedCount === null ? null : Math.max(0, plannedCount - sites.length),
    rawStatuses,
    outcomes,
    completeCoverage: countAndSites(completeCoverageSites),
    incompleteCoverage: countAndSites(incompleteCoverageSites),
    totalDiscoveredItems: sites.reduce((total, site) => total + site.itemCount, 0),
    uniqueDiscoveredItems: uniqueItems.size,
    opportunityRateAmongCompleteSearches: percentage(outcomes.found_complete.count, completeSearches),
    coverageCompletionRate: percentage(completeCoverageSites.length, sites.length),
  };
  return {
    schemaVersion: ANALYTICS_SCHEMA_VERSION,
    rulebookVersion: DISCOVERY_RULEBOOK_VERSION,
    channel,
    generatedAt,
    runPath,
    counts,
    ...(channel === "meetings" ? { providerCounts: providerStatistics(sites) ?? {} } : {}),
    sites,
    reconciliation: {
      oneClassificationPerSite: new Set(sites.map((site) => site.id)).size === sites.length,
      processedEqualsOutcomeTotal: sites.length === outcomeTotal,
      itemCountsMatchParsedItems,
      coverageCountsReconcile:
        completeCoverageSites.length + incompleteCoverageSites.length === sites.length,
    },
  };
};
