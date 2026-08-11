import type { Locator, Page } from "playwright";
import {
  AI_ACTION_TIMEOUT_MS,
  AI_OBSERVE_TIMEOUT_MS,
} from "../../../../shared_files_orchestrator/outreach_constants_(Support).js";
import { describe_error } from "../../../../shared_files_orchestrator/outreach_errors_(Support).js";
import {
  CAPTCHA_SELECTOR,
  selector_targets_captcha,
} from "../../shared_files_forms/captcha_detection_(Deterministic).js";
import { create_ai_operation_evidence } from "../../../../shared_files_orchestrator/ai_observability_(Support).js";
import type {
  PageIntelligence,
  PageIntelligenceAction,
} from "../../../../shared_files_orchestrator/page_intelligence_(Integration).js";
import {
  create_page_intelligence_scope,
  with_masked_page_values,
} from "../../../../shared_files_orchestrator/page_value_redaction_(Integration).js";
import type {
  AiActionEvidence,
  ContactFormCandidate,
} from "../../shared_files_forms/forms_types_(Support).js";
import type {
  ButtonClickAuditEvent,
  SubmitControlSearchResult,
} from "./C2_submission_types_(Support).js";
import {
  create_button_click_audit_event,
  mark_button_click_failed,
  mark_button_click_succeeded,
} from "./C4_button_click_audit_(Support).js";
import { submit_actionability_failure_reason } from "./C3_submit_control_selection_(Deterministic).js";

const SUBMISSION_OBSERVE_INSTRUCTION =
  "Find exactly one enabled control inside the populated contact form that submits the form. Return only a click action. Do not click navigation, reset, cancel, scheduling, download, or CAPTCHA controls.";

export interface StagehandSubmissionFallbackResult {
  attempted: boolean;
  reason: string;
  submitControlResult?: SubmitControlSearchResult;
  submitButtonEvent?: ButtonClickAuditEvent;
  clickError?: string;
  aiActions: AiActionEvidence[];
}

export interface StagehandSubmissionProposal {
  submitControlResult: SubmitControlSearchResult;
  aiActions: AiActionEvidence[];
}

export interface StagehandSubmissionProposalResult {
  proposed: boolean;
  reason: string;
  proposal?: StagehandSubmissionProposal;
  submitControlResult?: SubmitControlSearchResult;
  aiActions: AiActionEvidence[];
}

export interface StagehandSubmissionFallbackInput {
  page: Page;
  pageIntelligence: PageIntelligence;
  candidate: ContactFormCandidate;
  buttonAuditEvents: ButtonClickAuditEvent[];
  submissionAlreadyAttempted: boolean;
  redactionValues: string[];
}

interface StagehandSubmissionProposalState {
  page: Page;
  pageIntelligence: PageIntelligence;
  action: PageIntelligenceAction;
  aiAction: AiActionEvidence;
  submitControlResult: SubmitControlSearchResult;
  closeScope: () => Promise<void>;
  consumed: boolean;
}

const stagehand_submission_proposal_states = new WeakMap<
  StagehandSubmissionProposal,
  StagehandSubmissionProposalState
>();

/*
 * ========================================================================
 * STAGEHAND SUBMISSION FALLBACK
 * ========================================================================
 * Observes at most one submit action, validates it against the native
 * Playwright form, and executes it exactly once. The caller remains
 * responsible for validation, confirmation, and network assessment.
 * ========================================================================
 */
export async function attempt_stagehand_submission_fallback({
  page,
  pageIntelligence,
  candidate,
  buttonAuditEvents,
  submissionAlreadyAttempted,
  redactionValues,
}: StagehandSubmissionFallbackInput): Promise<StagehandSubmissionFallbackResult> {
  const proposal_result = await propose_stagehand_submission_fallback({
    page,
    pageIntelligence,
    candidate,
    buttonAuditEvents,
    submissionAlreadyAttempted,
    redactionValues,
  });
  if (!proposal_result.proposal) {
    return {
      attempted: false,
      reason: proposal_result.reason,
      ...(proposal_result.submitControlResult
        ? { submitControlResult: proposal_result.submitControlResult }
        : {}),
      aiActions: proposal_result.aiActions,
    };
  }

  return activate_stagehand_submission_proposal(
    proposal_result.proposal,
    buttonAuditEvents,
  );
}

/**
 * Observe and deterministically validate one Stagehand submit proposal without
 * activating it. Callers can therefore apply the same final native-validity
 * gate used for deterministic controls before permitting the single act.
 */
export async function propose_stagehand_submission_fallback({
  page,
  pageIntelligence,
  candidate,
  buttonAuditEvents,
  submissionAlreadyAttempted,
  redactionValues,
}: StagehandSubmissionFallbackInput): Promise<StagehandSubmissionProposalResult> {
  if (submissionAlreadyAttempted) {
    return {
      proposed: false,
      reason: "Stagehand submission fallback was not run after a submit attempt",
      aiActions: [],
    };
  }

  let scope;
  try {
    scope = await create_page_intelligence_scope(candidate.form);
  } catch (error) {
    return {
      proposed: false,
      reason: `Stagehand could not create a safe submit scope: ${describe_error(error)}`,
      aiActions: [],
    };
  }
  return run_stagehand_submission_proposal({
      page,
      pageIntelligence,
      candidate,
      buttonAuditEvents,
      submissionAlreadyAttempted,
      redactionValues,
      scopeSelector: scope.selector,
      closeScope: scope.close,
    });
}

interface ScopedStagehandSubmissionFallbackInput
  extends StagehandSubmissionFallbackInput {
  scopeSelector: string;
  closeScope: () => Promise<void>;
}

async function run_stagehand_submission_proposal({
  page,
  pageIntelligence,
  candidate,
  redactionValues,
  scopeSelector,
  closeScope,
}: ScopedStagehandSubmissionFallbackInput): Promise<StagehandSubmissionProposalResult> {
  let retain_scope = false;
  try {
    let observation;
    const observation_started_at = Date.now();
    try {
      observation = await with_masked_page_values(
        page,
        redactionValues,
        () =>
          pageIntelligence.observe({
            stage: "submission",
            page,
            instruction: SUBMISSION_OBSERVE_INSTRUCTION,
            selector: scopeSelector,
            ignoreSelectors: [CAPTCHA_SELECTOR],
            timeoutMs: AI_OBSERVE_TIMEOUT_MS,
          }),
      );
    } catch (error) {
      return {
        proposed: false,
        reason: `Stagehand could not inspect submit controls: ${describe_error(error)}`,
        aiActions: [
          create_ai_operation_evidence({
            stage: "submission",
            placeholderInstruction: SUBMISSION_OBSERVE_INSTRUCTION,
            method: "observe",
            model: pageIntelligence.model,
            durationMs: Date.now() - observation_started_at,
            acceptanceReason: "Stagehand submit-control observation failed",
            result: "failed",
          }),
        ],
      };
    }

    if (observation.actions.length !== 1) {
      const reason = `Stagehand returned ${observation.actions.length} submit actions; exactly one was required`;
      return {
        proposed: false,
        reason,
        aiActions:
          observation.actions.length > 0
            ? observation.actions.map((action) => ({
                stage: "submission" as const,
                placeholderInstruction: SUBMISSION_OBSERVE_INSTRUCTION,
                selector: action.selector,
                method: action.method,
                acceptance: "rejected" as const,
                acceptanceReason: reason,
                result: "notRun" as const,
                model: observation.model,
                durationMs: observation.durationMs,
              }))
            : [
                create_ai_operation_evidence({
                  stage: "submission",
                  placeholderInstruction: SUBMISSION_OBSERVE_INSTRUCTION,
                  method: "observe",
                  model: observation.model,
                  durationMs: observation.durationMs,
                  acceptanceReason: reason,
                  result: "observed",
                }),
              ],
      };
    }

    const action = observation.actions[0];
    if (!action) {
      return {
        proposed: false,
        reason: "Stagehand returned no submit action",
        aiActions: [],
      };
    }

    const validation = await validate_stagehand_submit_action(action, candidate);
    const ai_action: AiActionEvidence = {
      stage: "submission",
      placeholderInstruction: SUBMISSION_OBSERVE_INSTRUCTION,
      selector: action.selector,
      method: action.method,
      acceptance: validation.control ? "accepted" : "rejected",
      acceptanceReason: validation.reason,
      result: validation.control ? "observed" : "notRun",
      model: observation.model,
      durationMs: observation.durationMs,
    };

    if (!validation.control) {
      return {
        proposed: false,
        reason: `Stagehand submit action was rejected: ${validation.reason}`,
        aiActions: [ai_action],
      };
    }

    const actionability_reason = await submit_actionability_failure_reason(
      validation.control,
    );
    if (actionability_reason) {
      ai_action.acceptance = "rejected";
      ai_action.acceptanceReason = actionability_reason;
      ai_action.result = "notRun";
      return {
        proposed: false,
        reason: `Stagehand submit action was rejected: ${actionability_reason}`,
        aiActions: [ai_action],
      };
    }

    const submit_control_result: SubmitControlSearchResult = {
      control: validation.control,
      reason: "",
      strategy: "stagehandObservedSubmitControl",
      selector: action.selector,
      selectedIndex: 0,
      score: 1,
    };
    const proposal: StagehandSubmissionProposal = {
      submitControlResult: submit_control_result,
      aiActions: [ai_action],
    };
    stagehand_submission_proposal_states.set(proposal, {
      page,
      pageIntelligence,
      action,
      aiAction: ai_action,
      submitControlResult: submit_control_result,
      closeScope,
      consumed: false,
    });
    retain_scope = true;
    return {
      proposed: true,
      reason: "",
      proposal,
      submitControlResult: submit_control_result,
      aiActions: proposal.aiActions,
    };
  } finally {
    if (!retain_scope) {
      await closeScope().catch(() => undefined);
    }
  }
}

/**
 * Activate a previously validated proposal once. Reusing a proposal can never
 * result in a second Stagehand act.
 */
export async function activate_stagehand_submission_proposal(
  proposal: StagehandSubmissionProposal,
  button_audit_events: ButtonClickAuditEvent[],
): Promise<StagehandSubmissionFallbackResult> {
  const state = stagehand_submission_proposal_states.get(proposal);
  if (!state) {
    return {
      attempted: false,
      reason: "Stagehand submit proposal was unavailable or already released",
      aiActions: proposal.aiActions,
    };
  }
  if (state.consumed) {
    return {
      attempted: false,
      reason: "Stagehand submit proposal was already consumed",
      submitControlResult: state.submitControlResult,
      aiActions: proposal.aiActions,
    };
  }
  state.consumed = true;

  try {
    let audit_event: ButtonClickAuditEvent;
    try {
      audit_event = await create_button_click_audit_event(
        state.page,
        "submit",
        state.submitControlResult.control!,
        state.submitControlResult,
        button_audit_events.length + 1,
      );
      button_audit_events.push(audit_event);
    } catch (error) {
      const reason = `Stagehand submit control became unavailable before activation: ${describe_error(error)}`;
      state.aiAction.result = "failed";
      state.aiAction.resultMessage =
        "submit control became unavailable before activation";
      return {
        attempted: false,
        reason,
        submitControlResult: state.submitControlResult,
        aiActions: proposal.aiActions,
      };
    }

    try {
      const action_result = await state.pageIntelligence.act({
        stage: "submission",
        page: state.page,
        instruction: SUBMISSION_OBSERVE_INSTRUCTION,
        action: state.action,
        timeoutMs: AI_ACTION_TIMEOUT_MS,
      });
      state.aiAction.durationMs += action_result.durationMs;
      state.aiAction.model = action_result.model;

      if (!action_result.success) {
        const reason =
          "Stagehand reported that the submit control was not activated";
        mark_button_click_failed(audit_event, reason);
        state.aiAction.result = "failed";
        state.aiAction.resultMessage = reason;
        return {
          attempted: true,
          reason,
          submitControlResult: state.submitControlResult,
          submitButtonEvent: audit_event,
          clickError: reason,
          aiActions: proposal.aiActions,
        };
      }

      mark_button_click_succeeded(audit_event);
      state.aiAction.result = "succeeded";
      state.aiAction.resultMessage = "submit control activated once";
      return {
        attempted: true,
        reason: "",
        submitControlResult: state.submitControlResult,
        submitButtonEvent: audit_event,
        aiActions: proposal.aiActions,
      };
    } catch (error) {
      const click_error = describe_error(error);
      mark_button_click_failed(audit_event, click_error);
      state.aiAction.result = "failed";
      state.aiAction.resultMessage = "submit activation failed";
      return {
        attempted: true,
        reason: `Stagehand submit control could not be activated: ${click_error}`,
        submitControlResult: state.submitControlResult,
        submitButtonEvent: audit_event,
        clickError: click_error,
        aiActions: proposal.aiActions,
      };
    }
  } finally {
    await release_stagehand_submission_proposal(proposal);
  }
}

/** Release a proposal when a pre-submit gate prevents activation. */
export async function release_stagehand_submission_proposal(
  proposal: StagehandSubmissionProposal,
  reason?: string,
): Promise<void> {
  const state = stagehand_submission_proposal_states.get(proposal);
  if (!state) {
    return;
  }
  if (!state.consumed && reason) {
    state.aiAction.acceptance = "rejected";
    state.aiAction.acceptanceReason = reason;
    state.aiAction.result = "notRun";
    state.aiAction.resultMessage = "submit proposal released before activation";
  }
  stagehand_submission_proposal_states.delete(proposal);
  await state.closeScope().catch(() => undefined);
}

interface SubmitActionValidation {
  control?: Locator;
  reason: string;
}

async function validate_stagehand_submit_action(
  action: {
    selector: string;
    method: string;
    arguments?: string[];
  },
  candidate: ContactFormCandidate,
): Promise<SubmitActionValidation> {
  if (action.method.trim().toLowerCase() !== "click") {
    return { reason: "only a click method is permitted" };
  }

  if ((action.arguments?.length ?? 0) > 0) {
    return { reason: "submit clicks cannot include action arguments" };
  }

  const selector = action.selector.trim();
  if (!selector) {
    return { reason: "the submit selector was empty" };
  }
  if (await selector_targets_captcha(candidate.frame.page(), selector)) {
    return { reason: "the submit selector targeted a CAPTCHA control" };
  }

  let controls: Locator;
  try {
    controls = candidate.frame.locator(selector);
    const count = await controls.count();
    if (count !== 1) {
      return {
        reason: `the submit selector resolved to ${count} controls instead of one`,
      };
    }
  } catch (error) {
    return {
      reason: `the submit selector was invalid: ${describe_error(error)}`,
    };
  }

  const control = controls.first();
  const [visible, enabled] = await Promise.all([
    control.isVisible().catch(() => false),
    control.isEnabled().catch(() => false),
  ]);
  if (!visible || !enabled) {
    return { reason: "the submit control was not visible and enabled" };
  }

  const form_element = await candidate.form.elementHandle().catch(() => null);
  if (!form_element) {
    return { reason: "the contact form was no longer attached" };
  }

  try {
    const is_inside_form = await control.evaluate(
      (element, form) => form === element || form.contains(element),
      form_element,
    );
    if (!is_inside_form) {
      return { reason: "the submit control was outside the contact form" };
    }

    const is_safe_click_target = await control.evaluate((element) => {
      const tag = element.tagName.toLowerCase();
      const type = (element.getAttribute("type") ?? "").toLowerCase();
      const role = (element.getAttribute("role") ?? "").toLowerCase();
      const metadata = [
        element.textContent ?? "",
        element.getAttribute("value") ?? "",
        element.getAttribute("aria-label") ?? "",
        element.getAttribute("title") ?? "",
        element.getAttribute("name") ?? "",
        element.id,
      ]
        .join(" ")
        .toLowerCase();

      const form_field =
        tag === "textarea" ||
        tag === "select" ||
        (tag === "input" && !["button", "image", "submit"].includes(type));
      const explicitly_unsafe =
        /\b(cancel|reset|clear|back|previous|download|schedule|book|login|sign in|captcha|robot|human|challenge|verify)\b/.test(
          metadata,
        );
      const positive_submit_signal =
        ["image", "submit"].includes(type) ||
        /\b(send|submit|message|contact|enquir|inquir|request|continue|confirm|finish|complete|talk)\b|get in touch/.test(
          metadata,
        );
      const button_semantics =
        tag === "button" ||
        role === "button" ||
        ["button", "image", "submit"].includes(type) ||
        element.hasAttribute("onclick");

      return (
        !form_field &&
        !explicitly_unsafe &&
        positive_submit_signal &&
        button_semantics
      );
    });
    if (!is_safe_click_target) {
      return {
        reason: "the selected element was not a safe submit-like control",
      };
    }
  } catch (error) {
    return {
      reason: `the submit control could not be validated: ${describe_error(error)}`,
    };
  } finally {
    await form_element.dispose().catch(() => undefined);
  }

  return {
    control,
    reason: "one visible enabled submit control inside the contact form was validated",
  };
}
