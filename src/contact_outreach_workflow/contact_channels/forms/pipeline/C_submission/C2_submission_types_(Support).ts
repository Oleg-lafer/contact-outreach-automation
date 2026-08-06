import type { Locator, Page } from "playwright";
import type {
  ContactFormCandidate,
  ContactRequest,
  FormPopulationResult,
  NetworkDebugRecord,
  NetworkSubmissionEvidenceSummary,
  PageObstructionAction,
  PopulationSubmissionHandoff,
  SubmissionDebugSummary,
  SubmissionConfirmationEvidence,
  SubmissionPostClickDisposition,
  SubmissionRejectionEvidence,
} from "../../shared_files_forms/forms_types_(Support).js";
import type {
  RequiredControlInventory,
  RequiredControlRestorationResult,
  TemporarilyDisabledRequiredControl,
} from "../../shared_files_forms/required_control_inventory_(Deterministic).js";
import type { CaptchaBlockAssessment } from "../../shared_files_forms/captcha_detection_(Deterministic).js";
import type { DeepDebugContext } from "../../shared_files_forms/deep_debug_types_(Support).js";

export interface SubmissionDebugOptions {
  artifactDirectory?: string | undefined;
  contactRequest?: ContactRequest | undefined;
  populationHandoff?: PopulationSubmissionHandoff | undefined;
  deepDebug?: DeepDebugContext | undefined;
  recoverPopulation?: PopulationRecoveryCallback | undefined;
  onPopulationResultUpdated?:
    | ((result: FormPopulationResult) => void)
    | undefined;
}

export interface PopulationRecoveryInput {
  candidate: ContactFormCandidate;
  validation: EffectivePreSubmitValidationResult;
}

export interface PopulationRecoveryResult {
  candidate: ContactFormCandidate;
  populationResult: FormPopulationResult;
}

export type PopulationRecoveryCallback = (
  input: PopulationRecoveryInput,
) => Promise<PopulationRecoveryResult>;

export interface SubmitControlSearchResult {
  control?: Locator;
  reason: string;
  strategy?: string;
  selector?: string;
  selectedIndex?: number;
  score?: number;
  candidates?: SubmitCandidateDebugInfo[];
  preflightBlocked?: boolean;
  preflightInterceptor?: SubmitHitTestReceiver;
}

export interface SubmitHitTestReceiver {
  tag: string;
  id: string;
  className: string;
  text: string;
}

export interface SubmitCandidateDebugInfo {
  index: number;
  selector: string;
  tag: string;
  type: string;
  text: string;
  value: string;
  name: string;
  id: string;
  ariaLabel: string;
  title: string;
  href: string;
  className: string;
  visible: boolean;
  enabled: boolean;
  score: number;
  positiveSignals: string[];
  negativeSignals: string[];
  afterFieldDistance: number | null;
  selected: boolean;
  reason: string;
  boundingBox: {
    x: number;
    y: number;
    width: number;
    height: number;
  } | null;
}

export interface ButtonControlDebugInfo {
  selectorStrategy: string;
  selector: string;
  selectedIndex: number | null;
  score: number | null;
  frameUrl: string;
  tag: string;
  type: string;
  text: string;
  value: string;
  name: string;
  id: string;
  ariaLabel: string;
  title: string;
  boundingBox: {
    x: number;
    y: number;
    width: number;
    height: number;
  } | null;
}

export interface ButtonClickAuditEvent extends ButtonControlDebugInfo {
  sequenceNumber: number;
  actionName: "submit" | "intermediateConfirmation";
  pageUrlBeforeClick: string;
  timestamp: string;
  clickResult: "pending" | "clicked" | "failed";
  error?: string | undefined;
}

export interface MessageCandidateDebugInfo {
  selector: string;
  text: string;
  frameUrl: string;
}

export interface SubmissionVisibleEvidence {
  confirmationEvidence: Exclude<
    SubmissionConfirmationEvidence,
    "network" | "aiVisibleText"
  >;
  rejectionEvidence: SubmissionRejectionEvidence[];
  newMessages: MessageCandidateDebugInfo[];
}

export interface InvalidControlDebugInfo {
  tag: string;
  type: string;
  name: string;
  id: string;
  autocomplete: string;
  required: boolean;
  disabled: boolean;
  readOnly: boolean;
  checked: boolean | null;
  valuePresent: boolean;
  valueLength: number;
  willValidate: boolean;
  validity: {
    badInput: boolean;
    customError: boolean;
    patternMismatch: boolean;
    rangeOverflow: boolean;
    rangeUnderflow: boolean;
    stepMismatch: boolean;
    tooLong: boolean;
    tooShort: boolean;
    typeMismatch: boolean;
    valueMissing: boolean;
    valid: boolean;
  };
  validationMessage: string;
  labels: string[];
}

export type PreSubmitValidationApplicability =
  | "applicable"
  | "notApplicable"
  | "inspectionFailed";

export type PreSubmitValidationBypassReason =
  | "selectedContainerIsNotForm"
  | "controlIsNotNativeSubmitter"
  | "formNoValidate"
  | "submitterFormNoValidate";

/**
 * Effective native-browser validity immediately before submit activation.
 * `valid` is null whenever native constraint validation does not apply or
 * inspection could not be completed. Control values are represented only by
 * presence and length so this structure is safe to persist in debug output.
 */
export interface EffectivePreSubmitValidationResult {
  applicability: PreSubmitValidationApplicability;
  valid: boolean | null;
  reason: string;
  bypassReason?: PreSubmitValidationBypassReason | undefined;
  inspectionFailure?: string | undefined;
  invalidControls: InvalidControlDebugInfo[];
}

export interface PreSubmitValidationDebugEvidence {
  initial: EffectivePreSubmitValidationResult;
  final: EffectivePreSubmitValidationResult;
  recovery: Record<string, unknown>;
  inactiveConditionalControls?: {
    checkpoints: Array<{
      label: string;
      inventory: RequiredControlInventory["counts"];
      disabledControls: TemporarilyDisabledRequiredControl[];
    }>;
    restorations: Array<{
      label: string;
      result: RequiredControlRestorationResult;
    }>;
  };
}

export interface SubmissionDebugContext {
  artifactDirectory: string;
  absoluteArtifactDirectory: string;
  submissionDebugPath: string;
  networkPath: string;
  buttonAuditPath: string;
  submitCandidatesPath: string;
  beforeSubmitScreenshotPath: string;
  afterSubmit2sScreenshotPath: string;
  afterConfirmationWaitScreenshotPath: string;
}

export interface FinalizeSubmissionDebugInput {
  page: Page;
  debugContext: SubmissionDebugContext | undefined;
  urlBeforeSubmission: string;
  submitControl: ButtonControlDebugInfo | undefined;
  verifiedSubmitTarget: boolean;
  submitClickDispatched: boolean;
  submitClickTimestamp?: string | undefined;
  originalSubmitCandidate?: string | undefined;
  preflightInterceptor?: SubmitHitTestReceiver | undefined;
  submitCandidates: SubmitCandidateDebugInfo[];
  postSubmitMessages: MessageCandidateDebugInfo[];
  invalidControls: InvalidControlDebugInfo[];
  preSubmitValidation?: PreSubmitValidationDebugEvidence | undefined;
  networkRecords: NetworkDebugRecord[];
  buttonAuditEvents: ButtonClickAuditEvent[];
  confirmed: boolean;
  postClickDisposition?: SubmissionPostClickDisposition | undefined;
  rejectionEvidence?: SubmissionRejectionEvidence[] | undefined;
  confirmationEvidence: SubmissionConfirmationEvidence;
  networkSubmissionEvidence: NetworkSubmissionEvidenceSummary;
  confirmationControlClicked: boolean;
  captchaAssessment?: CaptchaBlockAssessment | undefined;
  obstructionActions?: PageObstructionAction[] | undefined;
  clickError?: string | undefined;
  noSubmitReason?: string | undefined;
  redactionValues?: string[] | undefined;
}

export type FinalizedSubmissionDebug = SubmissionDebugSummary | undefined;
