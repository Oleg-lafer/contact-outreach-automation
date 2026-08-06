export const ANALYTICS_SCHEMA_VERSION = 3 as const;
export const FORM_RULEBOOK_VERSION = "1.0.0" as const;
export const DISCOVERY_RULEBOOK_VERSION = "1.0.0" as const;
export const FORM_SIGNAL_RULEBOOK_VERSION = "2.0.0" as const;
export const RULEBOOK_VERSION = FORM_RULEBOOK_VERSION;

export const STAGES = [
  "input",
  "browser",
  "discovery",
  "population",
  "submission",
  "reporting",
] as const;

export const DISCOVERY_OUTCOMES = [
  "found_complete",
  "found_partial",
  "no_opportunity",
  "incomplete",
  "execution_failed",
  "artifact_incomplete",
  "conflicting",
] as const;

export type ChannelName = "forms" | "emails" | "meetings";
export type DiscoveryChannelName = Exclude<ChannelName, "forms">;
export type DiscoveryNormalizedOutcome = (typeof DISCOVERY_OUTCOMES)[number];
export type DiscoveryRawStatusBucket = "SUCCESS" | "PARTIAL" | "FAILED" | "MISSING" | "OTHER";
export type WorkflowMode = "full" | "discovery" | "mixed";
export type SiteWorkflowMode = "full" | "discovery" | "conflicting" | "unknown";
export type RunState = "completed" | "qualified" | "stopped" | "incomplete" | "not_started";
export type TerminalStage = (typeof STAGES)[number];
export type Attribution =
  | "workflow_attributable"
  | "non_workflow_attributable"
  | "indeterminate"
  | "not_applicable";
export type CauseFamily =
  | "input_data_issue"
  | "workflow_logic_issue"
  | "execution_environment_issue"
  | "reporting_issue"
  | "expected_no_opportunity"
  | "external_site_or_service_issue"
  | "policy_scope_boundary"
  | "insufficient_evidence"
  | "conflicting_evidence"
  | "unclassified_outcome"
  | "not_applicable";
export type StageState =
  | "not_entered"
  | "entered"
  | "advanced"
  | "qualified_not_executed"
  | "completed"
  | "stopped"
  | "not_applicable"
  | "incomplete";
export type EvidenceTier = "structured_json" | "structured_text" | "debug_artifact" | "bounded_text" | "artifact_absence";
export type FormStatusBucket = "SUCCESS" | "INCONCLUSIVE" | "PARTIAL" | "FAILED" | "OTHER";
export type FormSignalPolarity = "positive" | "negative";
export type FormConfirmationEvidence =
  | "success_text"
  | "success_url"
  | "network"
  | "ai_visible_text"
  | "none"
  | "unknown";
export type FormRejectionCategory = "validation" | "captcha" | "server" | "generic";

export interface NetworkRequestEvidence {
  method: string;
  status: number | null;
  url: string;
}

export interface FormMessageSignalEvidence {
  polarity: FormSignalPolarity;
  signalType: string;
  category: string;
  source: string;
  text: string;
}

export interface FormSubmissionSignalEvidence {
  primaryAvailable: boolean;
  debugPathReported: boolean;
  debugArtifactAvailable: boolean;
  confirmationEventsAvailable: boolean;
  debugArtifactMalformed: boolean;
  unsafeDebugPath: boolean;
  confirmationEvidence: FormConfirmationEvidence;
  postClickDisposition: string;
  rejectionEvidenceCount: number | null;
  rejectionCategories: FormRejectionCategory[];
  networkAvailable: boolean;
  networkEvidenceFound?: boolean;
  networkConfidence: string;
  networkRejectsSubmission?: boolean;
  networkProviderRuleId: string;
  networkBestRequest?: NetworkRequestEvidence;
  networkBestRejectionRequest?: NetworkRequestEvidence;
  networkReason: string;
  messageSignals: FormMessageSignalEvidence[];
  arithmetic: FormArithmeticSignalEvidence;
}

export interface FormArithmeticLedgerEntry {
  state: "retained" | "suppressed";
  signalId: string;
  variantId: string;
  score: number;
  evidenceSummary: string;
  suppressionReason: string;
}

export interface FormArithmeticSignalEvidence {
  presence: "absent" | "complete" | "malformed";
  evaluation: "evaluated" | "not_evaluated" | "unknown";
  displayResult: string;
  classification: "success" | "failure" | "inconclusive" | "unknown";
  totalScore: number | null;
  rulebookVersion: string;
  hasPositiveSignals?: boolean;
  hasNegativeSignals?: boolean;
  hasBothPolarities?: boolean;
  ledger: FormArithmeticLedgerEntry[];
  reportedUnknownCount: number | null;
  parseErrors: string[];
}

export interface AnalyticsError {
  siteId: string;
  severity: "warning" | "error";
  code: string;
  message: string;
  sourcePath: string;
}

export interface DiscoveryChannelEvidence {
  available: boolean;
  status: string;
  reason: string;
  failureKind: string;
  itemCount: number | null;
  items: string[];
  providers: string[];
  plannedPages: number | null;
  inspectedPages: number | null;
  failedPages: number | null;
  malformedFields: string[];
}

export interface SiteEvidence {
  id: string;
  numericId: number;
  directory: string;
  websiteUrl: string;
  mode: SiteWorkflowMode;
  sourcePaths: string[];
  inputPath?: string;
  primaryJsonPath?: string;
  primaryTextPath?: string;
  hasOnlyInput: boolean;
  primaryArtifactMalformed: boolean;
  conflictingModeEvidence: boolean;
  conflictingStructuredEvidence: boolean;
  status: string;
  reason: string;
  failureKind: string;
  discoveryAssessment: string;
  presenceEvidenceStrength: string;
  searchCoverage: string;
  description: string;
  contactFormFound?: boolean;
  submissionAttempted?: boolean;
  submissionConfirmed?: boolean;
  submissionSignals: FormSubmissionSignalEvidence;
  unknownSubmissionSignals: UnknownSubmissionSignalEvidence[];
  fullText: string;
  structuredEvidence: string[];
  debugEvidence: string[];
  emails: DiscoveryChannelEvidence;
  meetings: DiscoveryChannelEvidence;
  errors: AnalyticsError[];
}

export interface UnknownSubmissionSignalEvidence {
  kind: string;
  fingerprint: string;
  summary: string;
  reason: string;
}

export interface UnknownSubmissionSignalStatistic extends UnknownSubmissionSignalEvidence {
  count: number;
  siteIds: string[];
  modes: string[];
}

export interface RuleDefinition {
  id: string;
  order: number;
  stage: TerminalStage;
  title: string;
  attribution: Attribution;
  causeFamily: CauseFamily;
  subcategory: string;
  evidenceTier: EvidenceTier;
  description: string;
}

export interface SiteClassification {
  id: string;
  numericId: number;
  websiteUrl: string;
  sourceDirectory: string;
  mode: SiteWorkflowMode;
  runState: RunState;
  terminalStage: TerminalStage;
  attribution: Attribution;
  causeFamily: CauseFamily;
  subcategory: string;
  ruleId: string;
  evidenceBasis: EvidenceTier;
  evidenceSummary: string;
  sourcePaths: string[];
  primaryCause: string;
  secondarySignals: string[];
  status: string;
  failureKind: string;
  discoveryAssessment: string;
  stageStates: Record<TerminalStage, StageState>;
}

export interface CountAndSites {
  count: number;
  siteIds: string[];
}

export interface StageSubcategoryStatistics extends CountAndSites {
  attribution: Attribution;
  causeFamily: CauseFamily;
  subcategory: string;
}

export interface StageStatistics {
  stage: TerminalStage;
  applicable: number;
  entered: number;
  advancedOrQualifiedOrCompleted: number;
  stopped: number;
  incomplete: number;
  notApplicable: number;
  advanceRateAmongEntrants: number;
  stopRateAmongEntrants: number;
  attribution: Record<Attribution, CountAndSites>;
  subcategories: StageSubcategoryStatistics[];
}

export interface AnalyticsCounts {
  planned: number | null;
  processed: number;
  completed: number;
  qualified: number;
  stopped: number;
  incomplete: number;
  notStarted: number | null;
  terminalResults: number;
}

export interface AttributionStatistics extends CountAndSites {
  percentageOfStopped: number;
  percentageOfCompletedSites: number;
}

export interface ReconciliationResult {
  processedEqualsStates: boolean;
  processedStateTotal: number;
  stoppedEqualsAttributions: boolean;
  attributionTotal: number;
  uniqueSiteClassifications: boolean;
  stageSubcategoriesDoNotDoubleCount: boolean;
}

export interface FormSignalStatusCounts {
  SUCCESS: number;
  INCONCLUSIVE: number;
  PARTIAL: number;
  FAILED: number;
  OTHER: number;
}

export interface FormSignalStatistic extends CountAndSites {
  polarity: FormSignalPolarity;
  signalFamily: string;
  signalType: string;
  signalValue: string;
  description: string;
  percentageOfSubmissionAttempts: number;
  percentageOfProcessedSites: number;
  statusCounts: FormSignalStatusCounts;
}

export interface FormSignalCoverage {
  primarySubmissionSections: CountAndSites;
  primaryNetworkSections: CountAndSites;
  debugPathsReported: CountAndSites;
  debugArtifactsAvailable: CountAndSites;
  confirmationEventsAvailable: CountAndSites;
  messageEnrichedSites: CountAndSites;
  malformedDebugArtifacts: CountAndSites;
  unsafeDebugPaths: CountAndSites;
  arithmeticCompleteSites: CountAndSites;
  arithmeticMalformedSites: CountAndSites;
  legacyInferredSites: CountAndSites;
}

export interface FormArithmeticSiteScore {
  siteId: string;
  status: string;
  evaluation: "evaluated" | "not_evaluated";
  classification: "success" | "failure" | "inconclusive" | "not_evaluated";
  displayResult: string;
  totalScore: number | null;
  retainedScoreSum: number;
  retainedSignalCount: number;
  suppressedSignalCount: number;
  rulebookVersion: string;
  arithmeticReconciles: boolean;
  statusReconciles: boolean;
  polarityReconciles: boolean;
  resultLabelReconciles: boolean;
  unknownCountReconciles: boolean;
}

export interface FormArithmeticStatistics {
  evaluated: CountAndSites;
  notEvaluated: CountAndSites;
  malformed: CountAndSites;
  classifications: {
    success: CountAndSites;
    failure: CountAndSites;
    inconclusive: CountAndSites;
  };
  observedWorkflowRulebookVersions: string[];
  scoreDistribution: Array<{ score: number; count: number; siteIds: string[] }>;
  sites: FormArithmeticSiteScore[];
}

export interface FormSignalDispositionStatistics {
  confirmed: CountAndSites;
  rejected: CountAndSites;
  contradictory: CountAndSites;
  captchaBlocked: CountAndSites;
  unconfirmed: CountAndSites;
  missing: CountAndSites;
  other: CountAndSites;
}

export interface FormSignalReconciliation {
  statisticCountsMatchUniqueSites: boolean;
  statusCountsMatchStatisticCounts: boolean;
  signalSitesAreProcessed: boolean;
  polaritySiteCountsMatchUnions: boolean;
  arithmeticLedgerSumsMatch: boolean;
  arithmeticStatusesMatch: boolean;
  arithmeticPolaritiesMatch: boolean;
  arithmeticResultLabelsMatch: boolean;
  reportedUnknownCountsMatch: boolean;
}

export interface FormSignalStatistics {
  rulebookVersion: typeof FORM_SIGNAL_RULEBOOK_VERSION;
  processedSites: CountAndSites;
  submissionAttemptedSites: CountAndSites;
  sitesWithAnyPositiveSignal: CountAndSites;
  sitesWithAnyNegativeSignal: CountAndSites;
  sitesWithBothPolarities: CountAndSites;
  positive: FormSignalStatistic[];
  negative: FormSignalStatistic[];
  dispositions: FormSignalDispositionStatistics;
  coverage: FormSignalCoverage;
  neutralNetworkObservations: Record<string, CountAndSites>;
  undefinedSignals: UnknownSubmissionSignalStatistic[];
  arithmetic: FormArithmeticStatistics;
  dataQualityWarnings: string[];
  reconciliation: FormSignalReconciliation;
}

/** Existing detailed form-channel analytics, retained as a nested channel result. */
export interface FormAnalyticsResult {
  schemaVersion: typeof ANALYTICS_SCHEMA_VERSION;
  rulebookVersion: typeof FORM_RULEBOOK_VERSION;
  generatedAt: string;
  runPath: string;
  runMode: WorkflowMode;
  counts: AnalyticsCounts;
  finalAttribution: Record<Exclude<Attribution, "not_applicable">, AttributionStatistics>;
  signalStatistics: FormSignalStatistics;
  stages: StageStatistics[];
  sites: SiteClassification[];
  errors: AnalyticsError[];
  dataQualityWarnings: string[];
  reconciliation: ReconciliationResult;
}

/** Backward-compatible type name for form-only rendering and rulebook helpers. */
export type AnalyticsResult = FormAnalyticsResult;

export interface DiscoverySiteClassification {
  id: string;
  numericId: number;
  websiteUrl: string;
  sourceDirectory: string;
  channel: DiscoveryChannelName;
  outcome: DiscoveryNormalizedOutcome;
  ruleId: string;
  rawStatus: string;
  reason: string;
  failureKind: string;
  itemCount: number;
  items: string[];
  providers: string[];
  plannedPages: number | null;
  inspectedPages: number | null;
  failedPages: number | null;
  completeCoverage: boolean;
  evidenceSummary: string;
  sourcePaths: string[];
}

export interface DiscoveryChannelCounts {
  planned: number | null;
  processed: number;
  notStarted: number | null;
  rawStatuses: Record<DiscoveryRawStatusBucket, CountAndSites>;
  outcomes: Record<DiscoveryNormalizedOutcome, CountAndSites>;
  completeCoverage: CountAndSites;
  incompleteCoverage: CountAndSites;
  totalDiscoveredItems: number;
  uniqueDiscoveredItems: number;
  opportunityRateAmongCompleteSearches: number;
  coverageCompletionRate: number;
}

export interface DiscoveryChannelReconciliation {
  oneClassificationPerSite: boolean;
  processedEqualsOutcomeTotal: boolean;
  itemCountsMatchParsedItems: boolean;
  coverageCountsReconcile: boolean;
}

export interface DiscoveryChannelAnalyticsResult {
  schemaVersion: typeof ANALYTICS_SCHEMA_VERSION;
  rulebookVersion: typeof DISCOVERY_RULEBOOK_VERSION;
  channel: DiscoveryChannelName;
  generatedAt: string;
  runPath: string;
  counts: DiscoveryChannelCounts;
  providerCounts?: Record<string, CountAndSites>;
  sites: DiscoverySiteClassification[];
  reconciliation: DiscoveryChannelReconciliation;
}

export interface OutreachAnalyticsReconciliation {
  uniqueSiteEvidence: boolean;
  allChannelsClassifyEverySite: boolean;
  channelSiteIdsAlign: boolean;
  plannedCountIsNotBelowProcessed: boolean;
}

export interface OutreachAnalyticsResult {
  schemaVersion: typeof ANALYTICS_SCHEMA_VERSION;
  generatedAt: string;
  runPath: string;
  runMode: WorkflowMode;
  planned: number | null;
  processed: number;
  notStarted: number | null;
  channels: {
    forms: FormAnalyticsResult;
    emails: DiscoveryChannelAnalyticsResult;
    meetings: DiscoveryChannelAnalyticsResult;
  };
  errors: AnalyticsError[];
  dataQualityWarnings: string[];
  reconciliation: OutreachAnalyticsReconciliation;
}

export interface AnalyzeOptions {
  writeOutputs?: boolean;
  generatedAt?: Date;
}

export interface AnalyzeOutcome {
  result: OutreachAnalyticsResult;
  historyDirectory?: string;
  latestDirectory?: string;
}
