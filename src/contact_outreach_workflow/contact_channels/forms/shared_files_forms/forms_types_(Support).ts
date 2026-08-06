import type { Frame, Locator } from "playwright";
import type {
  AiActionEvidence,
  AiAssistanceSummary,
  AiUsageSummary,
  AutomationFailureKind,
  AutomationRunMode,
  AutomationStatus,
  ContactFillValues,
  ContactRequest,
  NetworkDebugRecord,
  OutreachBrowserSession,
  PageObstructionAction,
  PresenceEvidenceStrength,
  DiscoveryAssessment,
  DiscoverySearchCoverage,
  WebsiteDiscoveryState,
} from "../../../shared_files_orchestrator/outreach_types_(Support).js";
import type {
  SubmissionSignalEvaluation,
  UnknownSubmissionSignalCandidate,
} from "./submission_signal_scoring_(Deterministic).js";
import type {
  DeepDebugArtifactSummary,
  DeepDebugContext,
} from "./deep_debug_types_(Support).js";

export type {
  AiActionEvidence,
  AiAssistanceSummary,
  AiUsageSummary,
  AutomationFailureKind,
  AutomationRunMode,
  AutomationStatus,
  ContactFillValues,
  ContactRequest,
  NetworkDebugRecord,
  PageObstructionAction,
  PresenceEvidenceStrength,
  DiscoveryAssessment,
  DiscoverySearchCoverage,
  WebsiteDiscoveryState,
} from "../../../shared_files_orchestrator/outreach_types_(Support).js";

/*
 * ========================================================================
 * SHARED AUTOMATION TYPES
 * ========================================================================
 * Defines the domain objects passed between ordered workflow stages. Property
 * names remain stable because they are part of the CLI result contract.
 * ========================================================================
 */

export type PopulatedField =
  | "name"
  | "email"
  | "phone"
  | "message"
  | "company"
  | "role"
  | "website"
  | "country"
  | "consent"
  | "selection";

export type MessageDisposition =
  | "populated"
  | "notOffered"
  | "unresolved";

export type ContactFormClassification = "complete" | "progression";

export interface FormChannelOutcome {
  websiteUrl: string;
  contactPageFound: boolean;
  formFound: boolean;
  discovery?: WebsiteDiscoveryState;
  populatedFields: PopulatedField[];
  messageDisposition?: MessageDisposition;
  discoveryDebug?: DiscoveryDebugSummary;
  populationDebug?: PopulationDebugSummary;
  submissionAttempted: boolean;
  submissionConfirmed: boolean;
  signalEvaluation?: SubmissionSignalEvaluation;
  unknownSubmissionSignals?: UnknownSubmissionSignalCandidate[];
  status: AutomationStatus;
  failureKind?: AutomationFailureKind;
  reason?: string;
  postClickDisposition?: SubmissionPostClickDisposition;
  confirmationEvidence?: SubmissionConfirmationEvidence;
  rejectionEvidence?: SubmissionRejectionEvidence[];
  submissionDebug?: SubmissionDebugSummary;
  aiAssistance?: AiAssistanceSummary;
  deepDebug?: DeepDebugArtifactSummary;
}

export interface BrowserSession
  extends Omit<OutreachBrowserSession, "context" | "createChannelPage"> {
  context?: OutreachBrowserSession["context"];
  createChannelPage?: OutreachBrowserSession["createChannelPage"];
  deepDebug?: DeepDebugContext;
}

export type SubmissionConfirmationEvidence =
  | "successText"
  | "successUrl"
  | "network"
  | "aiVisibleText"
  | "none";

export type NetworkSubmissionEvidenceConfidence =
  | "none"
  | "weak"
  | "medium"
  | "strong";

export interface NetworkSubmissionRequestSummary {
  method: string;
  status?: number;
  url: string;
  resourceType: string;
}

export interface NetworkSubmissionEvidenceSummary {
  found: boolean;
  confirmsSubmission: boolean;
  rejectsSubmission?: boolean;
  confidence: NetworkSubmissionEvidenceConfidence;
  summary: string;
  reason: string;
  bestRequest?: NetworkSubmissionRequestSummary;
  bestRejectionRequest?: NetworkSubmissionRequestSummary;
  providerRuleId?: string;
  rejectionCategory?: SubmissionRejectionCategory;
  captchaRejected?: boolean;
  captchaRejectionReason?: string;
}

export type SubmissionPostClickDisposition =
  | "confirmed"
  | "rejected"
  | "contradictory"
  | "captchaBlocked"
  | "unconfirmed";

export type SubmissionRejectionCategory =
  | "validation"
  | "captcha"
  | "server"
  | "generic";

export interface SubmissionRejectionEvidence {
  source: "visibleMessage" | "network";
  category: SubmissionRejectionCategory;
  patternId: string;
  confidence: "strong";
  selector?: string;
  frameUrl?: string;
  excerpt?: string;
  request?: NetworkSubmissionRequestSummary;
}

export interface ContactFormCandidate {
  form: Locator;
  frame: Frame;
  score: number;
  source: ContactFormCandidateSource;
  structure: ContactFormCandidateStructure;
  classification?: ContactFormClassification;
  messageDisposition?: Exclude<MessageDisposition, "populated">;
}

export type ContactFormCandidateSource = "generic" | "stagehand";
export type ContactFormCandidateStructure =
  | "nativeForm"
  | "formLikeContainer";

export type ContactFieldKind =
  | "name"
  | "firstName"
  | "lastName"
  | "email"
  | "phone"
  | "message"
  | "company"
  | "role"
  | "website"
  | "country";

export interface FormDiscoveryResult {
  contactPageFound: boolean;
  candidate?: ContactFormCandidate;
  messageDisposition?: Exclude<MessageDisposition, "populated">;
  reason?: string;
  failureKind?: AutomationFailureKind;
  transportFailure?: boolean;
  aiActions?: AiActionEvidence[];
  debug?: DiscoveryDebugSummary;
}

export interface FormPopulationResult {
  populatedFields: PopulatedField[];
  messageDisposition: MessageDisposition;
  blockingReason?: string;
  failureKind?: AutomationFailureKind;
  submissionHandoff?: PopulationSubmissionHandoff;
  debug?: PopulationDebugSummary;
  aiActions?: AiActionEvidence[];
}

/**
 * In-memory deterministic handoff from population to submission. Expected
 * values are never persisted; they exist only to detect a rerender that
 * cleared or replaced the controls after population.
 */
export interface PopulationFieldSnapshot {
  field: PopulatedField;
  controlIndex: number;
  metadata: string;
  expectedValue: string;
}

export interface PopulationSubmissionHandoff {
  frameUrl: string;
  formFingerprint: string;
  fields: PopulationFieldSnapshot[];
}

export interface ContactFormAssessmentSignals {
  visibleControlCount: number;
  hasMessage: boolean;
  hasEmail: boolean;
  hasIdentity: boolean;
  hasBusinessOrProject: boolean;
  hasSubmit: boolean;
  hasSafeProgression: boolean;
  hasContactContext: boolean;
  hasNegativeContext: boolean;
}

export interface DiscoveryFormCandidateDebug {
  url: string;
  frameUrl: string;
  source: ContactFormCandidateSource | "deterministic";
  score: number;
  classification: ContactFormClassification | "rejected";
  accepted: boolean;
  reason: string;
  signals: ContactFormAssessmentSignals;
}

export interface DiscoveryRouteAttemptDebug {
  url: string;
  label: string;
  score: number;
  result: "opened" | "failed" | "duplicate" | "blocked";
  reason?: string;
}

export interface DiscoveryFrameDebug {
  url: string;
  sameOrigin: boolean;
}

export interface DiscoveryAiActionDebug {
  selector: string;
  argumentCount: number;
  normalization: string;
  result: "accepted" | "rejected" | "failed";
  reason: string;
}

export interface DiscoveryDebugSummary {
  reportPath: string;
  artifactDirectory: string;
  screenshotPath?: string;
  startingUrl: string;
  finalUrl: string;
  finalClassification: string;
  attemptedRoutes: DiscoveryRouteAttemptDebug[];
  candidates: DiscoveryFormCandidateDebug[];
  aiActions: DiscoveryAiActionDebug[];
  frames: DiscoveryFrameDebug[];
  interactions?: DiscoveryInteractionDebug[];
}

export interface DiscoveryInteractionState {
  url: string;
  visibleFormCount: number;
  visibleDialogCount: number;
  frameCount: number;
}

export interface DiscoveryInteractionDebug {
  label: string;
  performedAt: string;
  before: DiscoveryInteractionState;
  after: DiscoveryInteractionState;
  pageStateChanged: boolean;
}

export type DiscoveryEvidenceKind =
  | "validatedContactForm"
  | "recognizedFormEmbed"
  | "formLikeNetwork"
  | "contactRoute"
  | "contactRevealControl"
  | "contactChannel"
  | "rejectedForm"
  | "inspectionLimitation";

export interface DiscoveryEvidenceRecord {
  kind: DiscoveryEvidenceKind;
  strength: Exclude<PresenceEvidenceStrength, "none">;
  description: string;
  url?: string;
  status?: number;
}

export interface DiscoveryPageSignals {
  contactContext: boolean;
  contactChannels: Array<"email" | "telephone" | "chat" | "support" | "externalBooking">;
  recognizedFormEmbeds: string[];
  contactRevealControls: string[];
}

export interface FormDiscoveryOutcome {
  websiteUrl: string;
  assessment: DiscoveryAssessment;
  contactFormFound: boolean;
  presenceEvidenceStrength: PresenceEvidenceStrength;
  searchCoverage: DiscoverySearchCoverage;
  description: string;
  assessedAt: string;
  contactPageUrl?: string;
  formFrameUrl?: string;
  evidence: DiscoveryEvidenceRecord[];
  rejectedCandidates: DiscoveryFormCandidateDebug[];
  limitations: string[];
  discoveryDebug?: DiscoveryDebugSummary;
  aiAssistance?: AiAssistanceSummary;
  artifactDirectory?: string;
  reportPath?: string;
  resultPath?: string;
  networkPath?: string;
}

export interface PopulationDebugSummary {
  reportPath: string;
  unknownTextFieldsFilled: number;
  dropdownsSelected: number;
  checkboxChoicesSelected: number;
  unhandledRequiredFields: number;
  skippedUnsafeFields: number;
  radioChoicesSelected?: number;
  customChoicesSelected?: number;
  duplicateContactFieldsFilled?: number;
  inactiveConditionalControls?: number;
  unresolvedActiveRequiredControls?: number;
}

export type MissingFieldAction =
  | "filledUnknownText"
  | "filledContactDuplicate"
  | "selectedDropdown"
  | "selectedCheckbox"
  | "selectedRadio"
  | "selectedCustomChoice"
  | "ignoredInactiveConditional"
  | "unhandledRequired"
  | "skippedUnsafe";

export interface MissingFieldReportEntry {
  index: number;
  tag: string;
  type: string;
  role: string;
  name: string;
  id: string;
  placeholder: string;
  ariaLabel: string;
  labelText: string;
  groupKey: string;
  required: boolean;
  action: MissingFieldAction;
  reason: string;
  requiredSources?: string[];
  activityClassification?: string;
  hiddenReasons?: string[];
  controlKind?: string;
  verificationSucceeded?: boolean;
  expectedValuePresent?: boolean;
  expectedValueLength?: number;
  valueMatchesExpected?: boolean;
  valueBefore?: string;
  valueAfter?: string;
  fillValue?: string;
  selectedOptionText?: string;
  selectedOptionValue?: string;
  selectedChoiceText?: string;
  selectedChoiceValue?: string;
}

export interface MissingFieldsReport {
  version: 1;
  generatedAt: string;
  summary: PopulationDebugSummary;
  records: MissingFieldReportEntry[];
  matchingDiagnostics?: FieldMatchingDiagnostic[];
}

export interface FieldMatchingDiagnostic {
  scan: number;
  index: number;
  tag: string;
  type: string;
  metadata: string;
  result: "matched" | "unmatched" | "fillFailed";
  matchedField?: PopulatedField;
  reason: string;
}

export interface SubmissionAssessment {
  attempted: boolean;
  confirmed: boolean;
  validationBlocked: boolean;
  signalEvaluation?: SubmissionSignalEvaluation;
  unknownSubmissionSignals?: UnknownSubmissionSignalCandidate[];
  captchaBlocked?: boolean;
  postClickDisposition?: SubmissionPostClickDisposition;
  confirmationEvidence?: SubmissionConfirmationEvidence;
  rejectionEvidence?: SubmissionRejectionEvidence[];
  reason?: string;
  failureKind?: AutomationFailureKind;
  debug?: SubmissionDebugSummary;
  aiActions?: AiActionEvidence[];
}

export interface SubmissionDebugSummary {
  artifactDirectory: string;
  selectedSubmitControl: string;
  verifiedSubmitTarget: boolean;
  submitTargetKind: "nativeSubmit" | "customControl" | "nonNavigationalAnchor" | "none";
  submitClickDispatched: boolean;
  submitClickTimestamp?: string;
  originalSubmitCandidate?: string;
  preflightInterceptor?: string;
  postSubmitMessageFound: boolean;
  urlBeforeSubmission: string;
  urlAfterSubmission: string;
  postClickDisposition?: SubmissionPostClickDisposition;
  rejectionEvidenceCount?: number;
  rejectionCategories?: SubmissionRejectionCategory[];
  confirmationEvidence: SubmissionConfirmationEvidence;
  networkRequestCount: number;
  networkSubmissionEvidenceFound: boolean;
  networkSubmissionEvidenceConfidence: NetworkSubmissionEvidenceConfidence;
  networkSubmissionEvidenceSummary: string;
  networkSubmissionEvidenceReason: string;
  networkSubmissionRejectsSubmission?: boolean;
  networkSubmissionProviderRuleId?: string;
  bestNetworkSubmissionRequest?: NetworkSubmissionRequestSummary;
  buttonClickCount: number;
  buttonClickSummaries: string[];
  captchaPresenceBefore: "none" | "passive" | "interactive";
  captchaPresenceAfter: "none" | "passive" | "interactive";
  captchaBlocked: boolean;
  captchaBlockReason?: string;
  preSubmitValidationApplicability?: "applicable" | "notApplicable" | "inspectionFailed";
  preSubmitValidationBypassReason?: string;
  preSubmitValid?: boolean | null;
  populationRecoveryAttempted?: boolean;
  populationRecoverySucceeded?: boolean;
  inactiveConditionalControlsDisabled?: number;
  inactiveConditionalControlsRestored?: number;
}

export interface FormSummary {
  text: string;
  controls: Array<{
    tag: string;
    type: string;
    metadata: string;
  }>;
}

export interface FieldDescription {
  tag: string;
  type: string;
  metadata: string;
}
