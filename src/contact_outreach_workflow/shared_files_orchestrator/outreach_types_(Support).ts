import type { BrowserContext, Page } from "playwright";
import type { EmailChannelOutcome } from "../contact_channels/emails/shared_files_emails/email_types_(Support).js";
import type { FormChannelOutcome } from "../contact_channels/forms/shared_files_forms/forms_types_(Support).js";
import type { MeetingChannelOutcome } from "../contact_channels/meetings/shared_files_meetings/meeting_types_(Support).js";
import type { PageIntelligence } from "./page_intelligence_(Integration).js";
import type { DeepDebugContext, DeepDebugArtifactSummary } from "./deep_debug_types_(Support).js";

export type AutomationStatus = "SUCCESS" | "PARTIAL" | "INCONCLUSIVE" | "FAILED";

export type AutomationFailureKind =
  | "input.invalid"
  | "navigation.failed"
  | "outreach.resend_prevented"
  | "discovery.no_route"
  | "discovery.email_only"
  | "discovery.booking_only"
  | "discovery.rejected_form"
  | "discovery.llm_unresolved"
  | "population.blocked"
  | "submission.no_control"
  | "submission.preflight"
  | "submission.validation"
  | "submission.captcha"
  | "submission.rejected"
  | "submission.contradictory"
  | "submission.unconfirmed"
  | "submission.inconclusive"
  | "runtime.error";

export type AutomationRunMode = "production" | "deep-debug";
export type AutomationEngine = "playwright" | "stagehand";
export type WorkflowExecutionStatus = "FINISHED" | "RUN_FAILED" | "SKIPPED";
export type WebsiteRunStatus = "pending" | "succeeded" | "failed";

export type DiscoveryAssessment =
  | "confirmed_form_present"
  | "strong_form_evidence"
  | "possible_form_evidence"
  | "contact_channel_without_form"
  | "no_form_observed_after_complete_search"
  | "no_form_observed_after_limited_search"
  | "site_inspection_blocked";

export type PresenceEvidenceStrength = "strong" | "moderate" | "weak" | "none";
export type DiscoverySearchCoverage = "complete" | "partial" | "blocked";

export interface ContactFillValues {
  name: string;
  email: string;
  phone: string;
  message: string;
  company?: string;
  role?: string;
  website?: string;
  country?: string;
}

export interface WebsiteDiscoveryState {
  assessment: DiscoveryAssessment;
  presenceEvidenceStrength: PresenceEvidenceStrength;
  searchCoverage: DiscoverySearchCoverage;
  description: string;
  assessedAt: string;
}

export interface WebsiteRunEntry {
  websiteUrl: string;
  status: WebsiteRunStatus;
  statusDescription: string;
  discovery?: WebsiteDiscoveryState;
}

export interface ContactRequestInputSource {
  websiteListPath: string;
  websiteIndex: number;
}

export interface ContactRequest extends ContactFillValues {
  websiteUrl: string;
  inputSource?: ContactRequestInputSource;
}

export interface ContactRouteCandidate {
  url: string;
  score: number;
  label: string;
}

export interface ContactRouteDiscoveryResult {
  startingUrl: string;
  candidates: ContactRouteCandidate[];
}

export interface ContactOutreachOutcome {
  websiteUrl: string;
  executionStatus: WorkflowExecutionStatus;
  status: AutomationStatus;
  reason?: string;
  failureKind?: AutomationFailureKind;
  channels: {
    forms: FormChannelOutcome;
    emails: EmailChannelOutcome;
    meetings: MeetingChannelOutcome;
  };
  browserStage?: BrowserStageResult;
  deepDebug?: DeepDebugArtifactSummary;
}

export type BrowserStageOutcome =
  | "LOADED"
  | "LOADED_AFTER_TIMEOUT"
  | "FAILED"
  | "NOT_ENTERED";

export type BrowserFailureCategory =
  | "OUR_SYSTEM_FAILURE"
  | "DESTINATION_FAILURE"
  | "ACCESS_RESTRICTION"
  | "UNDETERMINED";

export type BrowserResponsibleParty =
  | "OUR_SYSTEM"
  | "DESTINATION"
  | "THIRD_PARTY_PATH"
  | "UNKNOWN";

export type BrowserFailureConfidence = "HIGH" | "MEDIUM" | "LOW";

export type BrowserFailurePhase =
  | "PRE_BROWSER"
  | "LOOPBACK_PORT_RESERVATION"
  | "CDP_CONNECTION"
  | "BROWSER_LAUNCH"
  | "CONTEXT_CREATION"
  | "PAGE_CREATION"
  | "DIAGNOSTIC_ATTACHMENT"
  | "INITIAL_NAVIGATION"
  | "POST_TIMEOUT_INSPECTION";

export interface BrowserStageErrorEvidence {
  name: string;
  code?: string;
  message: string;
  stackFingerprint?: string;
}

export interface BrowserStageContentEvidence {
  inspected: boolean;
  readyState?: string;
  titleLength?: number;
  titlePreview?: string;
  bodyTextLength?: number;
  elementCount?: number;
  controlCount?: number;
  meaningfulContent: boolean;
  accessRestrictionIndicators: string[];
}

export interface BrowserStageHealthEvidence {
  browserConnected: boolean;
  pageClosed: boolean;
  browserDisconnectedObserved: boolean;
  contextClosedObserved: boolean;
  pageCrashObserved: boolean;
  pageCloseObserved: boolean;
}

export interface BrowserStageResult {
  schemaVersion: 1;
  entered: boolean;
  outcome: BrowserStageOutcome;
  originalUrl: string;
  finalUrl: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  phase: BrowserFailurePhase;
  operation: string;
  attempt: 1;
  timeoutMs: number;
  waitUntil: "domcontentloaded";
  redirectChain: string[];
  mainDocumentRequested: boolean;
  mainDocumentReceived: boolean;
  mainDocumentStatus?: number;
  mainDocumentStatusText?: string;
  mainDocumentFailure?: string;
  content: BrowserStageContentEvidence;
  health: BrowserStageHealthEvidence;
  proxyConfigured: boolean;
  runtime: {
    pid: number;
    node: string;
    platform: NodeJS.Platform;
    rssBytes: number;
    heapUsedBytes: number;
    userCpuMicros: number;
    systemCpuMicros: number;
  };
  runContext?: {
    campaignId?: number;
    campaignName?: string;
    siteOrdinal?: number;
    websiteId?: number;
  };
  category?: BrowserFailureCategory;
  responsibleParty?: BrowserResponsibleParty;
  subcategory?: string;
  confidence?: BrowserFailureConfidence;
  ruleId?: string;
  reason?: string;
  evidence: string[];
  contradictions: string[];
  error?: BrowserStageErrorEvidence;
  diagnosticArtifactPath?: string;
}

export interface BrowserStageRunSummary {
  schemaVersion: 1;
  generatedAt: string;
  totalWebsites: number;
  entered: number;
  loaded: number;
  loadedAfterTimeout: number;
  failures: number;
  notEntered: number;
  categoryCounts: Record<BrowserFailureCategory, number>;
  categoryPercentagesOfFailures: Record<BrowserFailureCategory, number>;
  categoryPercentagesOfEntrants: Record<BrowserFailureCategory, number>;
  subcategoryCounts: Record<string, number>;
  ledger: Array<{ siteId: string; websiteUrl: string; browserStage: BrowserStageResult }>;
  preBrowserExclusions: Array<{ websiteUrl: string; reason: string }>;
  reconciliation: {
    entrantsEqualLoadedPlusFailures: boolean;
    failuresEqualCategorySum: boolean;
    failuresEqualLedgerRows: boolean;
    ledgerSiteIdsUnique: boolean;
  };
}

export interface OutreachBrowserSession {
  page: Page;
  context: BrowserContext;
  createChannelPage: () => Promise<Page>;
  close: () => Promise<void>;
  initialNavigationError?: string;
  pageIntelligence?: PageIntelligence | undefined;
  /** Lazily attaches optional page intelligence to the Playwright-owned browser. */
  ensurePageIntelligence?: () => Promise<PageIntelligence>;
  redactionValues?: string[];
  networkDebugRecorder?: NetworkDebugRecorder;
  obstructionActions?: PageObstructionAction[];
  browserStage?: BrowserStageResult;
  deepDebug?: DeepDebugContext;
}

export interface PageObstructionAction {
  kind: "cookieConsent";
  action: "reject" | "necessaryOnly" | "close" | "accept";
  label: string;
  result: "clicked" | "failed";
  reason?: string;
  vendor?: CookieConsentVendor;
  attempt?: number;
  detectionBasis?: "knownVendor" | "consentText";
  blockingVerified?: boolean;
  cleared?: boolean;
  verificationReason?: string;
}

export type CookieConsentVendor =
  | "oneTrust"
  | "tarteaucitron"
  | "cookiebot"
  | "usercentrics"
  | "ccm19"
  | "cookieYes"
  | "drupal"
  | "generic";

export type AiActionAcceptance = "accepted" | "rejected";
export type AiActionResult = "observed" | "notRun" | "succeeded" | "failed";

export interface AiActionEvidence {
  stage: "discovery" | "population" | "submission" | "confirmation";
  placeholderInstruction: string;
  selector: string;
  method: string;
  acceptance: AiActionAcceptance;
  acceptanceReason: string;
  result: AiActionResult;
  resultMessage?: string;
  model: string;
  durationMs: number;
  argumentCount?: number;
  normalization?: string;
}

export interface AiAssistanceSummary {
  artifactPath?: string;
  actionCount: number;
  acceptedActionCount: number;
  rejectedActionCount: number;
  actions: AiActionEvidence[];
  usage?: AiUsageSummary;
}

export interface AiUsageSummary {
  model: string;
  requestCount: number;
  completedRequestCount: number;
  failedRequestCount: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cachedInputTokens: number;
  totalTokens: number;
  costUsd?: number;
  costUnavailableRequestCount: number;
}

export interface NetworkDebugRecorder {
  snapshot: () => NetworkDebugRecord[];
  stop: () => NetworkDebugRecord[];
}

export interface NetworkDebugRecord {
  id: number;
  method: string;
  url: string;
  resourceType: string;
  startedAt: string;
  postDataPreview?: string;
  status?: number;
  failureText?: string;
  completedAt?: string;
}

export interface ReportSection {
  title: string;
  lines: string[];
}
