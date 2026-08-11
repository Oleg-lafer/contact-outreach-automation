import { mkdir } from "node:fs/promises";
import { ACTION_TIMEOUT_MS } from "../../../../shared_files_orchestrator/outreach_constants_(Support).js";
import { describe_error } from "../../../../shared_files_orchestrator/outreach_errors_(Support).js";
import {
  assess_captcha_blockage,
  assess_page_captcha,
  captcha_blocks_submit_activation,
  type CaptchaAssessment,
  type CaptchaBlockAssessment,
} from "../../shared_files_forms/captcha_detection_(Deterministic).js";
import type {
  AiActionEvidence,
  BrowserSession,
  ContactFormCandidate,
  SubmissionAssessment,
} from "../../shared_files_forms/forms_types_(Support).js";
import {
  temporarily_disable_inactive_required_controls,
  type InactiveRequiredControlLease,
  type RequiredControlRestorationResult,
} from "../../shared_files_forms/required_control_inventory_(Deterministic).js";
import { reconcile_population_submission_handoff } from "../B_population/B1_contact_form_population_(Integration).js";
import type {
  ButtonControlDebugInfo,
  ButtonClickAuditEvent,
  EffectivePreSubmitValidationResult,
  MessageCandidateDebugInfo,
  PreSubmitValidationDebugEvidence,
  SubmissionDebugContext,
  SubmissionDebugOptions,
  SubmitCandidateDebugInfo,
  SubmitControlSearchResult,
} from "./C2_submission_types_(Support).js";
import { prepare_submit_control } from "./C3_submit_control_selection_(Deterministic).js";
import {
  create_button_click_audit_event,
  describe_button_control,
  mark_button_click_failed,
  mark_button_click_succeeded,
} from "./C4_button_click_audit_(Support).js";
import {
  collect_visible_message_candidates,
  create_submission_debug_context,
  finalize_submission_debug,
  safe_page_screenshot,
} from "./C5_submission_observability_(Support).js";
import {
  assess_effective_pre_submit_validity,
  click_confirmation_control_if_present,
  collect_invalid_controls,
  has_visible_success_message,
  wait_for_submission_confirmation,
} from "./C6_submission_confirmation_(Deterministic).js";
import { analyze_network_submission_evidence } from "./C7_network_submission_evidence_(Deterministic).js";
import {
  activate_stagehand_submission_proposal,
  propose_stagehand_submission_fallback,
  release_stagehand_submission_proposal,
  type StagehandSubmissionProposal,
} from "./C8_stagehand_submission_fallback_(LLM).js";
import { classify_stagehand_submission_confirmation } from "./C9_stagehand_confirmation_fallback_(LLM).js";
import { assess_authoritative_submission_evidence } from "./C10_submission_evidence_assessment_(Deterministic).js";

/*
 * TOP LEVEL WORKFLOW:
 *
 * submit_and_assess_contact_form(browser_session, candidate)
 *        |
 *        v
 * find enabled submit control
 *        |
 *        v
 * click submit and audit button click
 *        |
 *        v
 * detect validation blockage or explicit confirmation
 *        |
 *        v
 * write submission observability artifacts
 */

/*
 * ========================================================================
 * TOP_LEVEL_WORKFLOW_FUNCTIONS
 * ========================================================================
 */

/*
 * ========================================================================
 * FORM SUBMISSION ASSESSMENT - submit_and_assess_contact_form(...)
 * ========================================================================
 * Input:  The active session and populated contact-form candidate.
 * Output: Whether submission was attempted, confirmed, or validation-blocked.
 *
 * Responsibility: Activate a real submit control, coordinate post-click
 * assessment, and delegate submit selection, audit, observability, and
 * confirmation details to focused submission modules.
 * ========================================================================
 */
export async function submit_and_assess_contact_form(
  browser_session: BrowserSession,
  candidate: ContactFormCandidate,
  debug_options: SubmissionDebugOptions = {},
): Promise<SubmissionAssessment> {
  const inactive_control_lifecycle =
    create_inactive_conditional_control_lifecycle(browser_session);
  try {
    return await submit_and_assess_contact_form_internal(
      browser_session,
      candidate,
      debug_options,
      inactive_control_lifecycle,
    );
  } finally {
    await inactive_control_lifecycle.restore("terminal-finally");
  }
}

async function submit_and_assess_contact_form_internal(
  browser_session: BrowserSession,
  candidate: ContactFormCandidate,
  debug_options: SubmissionDebugOptions,
  inactive_control_lifecycle: InactiveConditionalControlLifecycle,
): Promise<SubmissionAssessment> {
  const page = browser_session.page;
  const deep_debug = debug_options.deepDebug ?? browser_session.deepDebug;
  const debug_context = create_submission_debug_context(debug_options);
  const button_audit_events: ButtonClickAuditEvent[] = [];
  let url_before_submission = page.url();
  let population_recovery_attempted = false;
  let population_recovery_evidence: Record<string, unknown> | undefined;
  deep_debug?.record({
    stage: "submission",
    substage: "entry",
    operation: "submit-and-assess-contact-form",
    outcome: "started",
    url: url_before_submission,
    frameUrl: candidate.frame.url(),
    data: {
      hasPopulationHandoff: Boolean(debug_options.populationHandoff),
      classification: candidate.classification,
      messageDisposition: candidate.messageDisposition,
    },
  });
  await deep_debug?.captureFormSnapshot({
    stage: "handoff",
    label: "00-submission-entry-before-reconciliation",
    form: candidate.form,
    expectedValues: browser_session.redactionValues ?? [],
  });

  if (debug_options.populationHandoff && debug_options.contactRequest) {
    const reconciled = await reconcile_population_submission_handoff(
      debug_options.contactRequest,
      candidate,
      debug_options.populationHandoff,
      deep_debug,
    );
    if ("reason" in reconciled) {
      return finalize_unattempted_submission({
        browserSession: browser_session,
        debugContext: debug_context,
        urlBeforeSubmission: url_before_submission,
        submitCandidates: [],
        buttonAuditEvents: button_audit_events,
        reason: `population-to-submission handoff failed: ${reconciled.reason}`,
        failureKind: "submission.validation",
        validationBlocked: true,
        aiActions: [],
        obstructionActions: browser_session.obstructionActions ?? [],
      });
    }
    candidate = reconciled.candidate;
    if (reconciled.populationResult) {
      population_recovery_attempted = true;
      population_recovery_evidence = {
        attempted: true,
        succeeded: true,
        source: "population-handoff-reconciliation",
        populatedFields: reconciled.populationResult.populatedFields,
        messageDisposition: reconciled.populationResult.messageDisposition,
        hasSubmissionHandoff: Boolean(
          reconciled.populationResult.submissionHandoff,
        ),
      };
      debug_options.onPopulationResultUpdated?.(
        reconciled.populationResult,
      );
    }
    debug_options = {
      ...debug_options,
      populationHandoff: reconciled.handoff,
    };
    await deep_debug?.captureFormSnapshot({
      stage: "handoff",
      label: "01-submission-entry-after-reconciliation",
      form: candidate.form,
      expectedValues: browser_session.redactionValues ?? [],
    });
  }
  let confirmation_visible_before = await has_visible_success_message(page);
  let messages_before_submission = await collect_visible_message_candidates(page);
  let captcha_before_submission = await assess_page_captcha(page);
  deep_debug?.record({
    stage: "submission",
    substage: "baseline",
    operation: "capture-preparation-baseline",
    outcome: "succeeded",
    data: {
      confirmationVisibleBefore: confirmation_visible_before,
      messageCandidatesBefore: messages_before_submission,
      captchaBefore: captcha_before_submission,
    },
  });
  let submit_preparation = await prepare_submit_control(candidate, deep_debug);
  let submit_control_result = submit_preparation.result;
  browser_session.obstructionActions?.push(
    ...submit_preparation.obstructionActions,
  );
  deep_debug?.record({
    stage: "submission",
    substage: "submit-selection",
    operation: "prepare-submit-control",
    outcome: submit_control_result.control ? "succeeded" : "blocked",
    reason: submit_control_result.reason || undefined,
    data: {
      strategy: submit_control_result.strategy ?? null,
      selector: submit_control_result.selector ?? null,
      selectedIndex: submit_control_result.selectedIndex ?? null,
      score: submit_control_result.score ?? null,
      preflightBlocked: submit_control_result.preflightBlocked ?? false,
      preflightInterceptor: submit_control_result.preflightInterceptor ?? null,
      candidates: submit_control_result.candidates ?? [],
      obstructionActions: submit_preparation.obstructionActions,
    },
  });
  await deep_debug?.writeJson("submission/submit-candidates-deep.json", {
    selected: {
      strategy: submit_control_result.strategy ?? null,
      selector: submit_control_result.selector ?? null,
      selectedIndex: submit_control_result.selectedIndex ?? null,
      score: submit_control_result.score ?? null,
      reason: submit_control_result.reason,
      preflightBlocked: submit_control_result.preflightBlocked ?? false,
      preflightInterceptor: submit_control_result.preflightInterceptor ?? null,
    },
    candidates: submit_control_result.candidates ?? [],
    obstructionActions: submit_preparation.obstructionActions,
  });
  await deep_debug?.captureFormSnapshot({
    stage: "submission",
    label: "10-after-submit-selection-and-preflight",
    form: candidate.form,
    expectedValues: browser_session.redactionValues ?? [],
  });
  await deep_debug?.captureScreenshot(
    page,
    "submission",
    "10-after-submit-selection-and-preflight",
  );

  if (debug_context) {
    await mkdir(debug_context.absoluteArtifactDirectory, { recursive: true });
    await safe_page_screenshot(
      page,
      debug_context.beforeSubmitScreenshotPath,
      browser_session.redactionValues,
    );
  }

  let stagehand_proposal: StagehandSubmissionProposal | undefined;
  let stagehand_ai_actions: AiActionEvidence[] = [];
  let stagehand_proposal_discarded = false;
  let initial_pre_submit_validation:
    | EffectivePreSubmitValidationResult
    | undefined;
  let final_pre_submit_validation:
    | EffectivePreSubmitValidationResult
    | undefined;

  if (!submit_control_result.control) {
    const captcha_activation_block_reason =
      await captcha_blocks_submit_activation(
        candidate.form,
        captcha_before_submission,
      );
    const page_intelligence =
      submit_control_result.preflightBlocked || captcha_activation_block_reason
        ? undefined
        : browser_session.pageIntelligence ??
          (await browser_session.ensurePageIntelligence?.());
    const stagehand_proposal_result = page_intelligence
      ? await propose_stagehand_submission_fallback({
          page,
          pageIntelligence: page_intelligence,
          candidate,
          buttonAuditEvents: button_audit_events,
          submissionAlreadyAttempted: false,
          redactionValues: browser_session.redactionValues ?? [],
        })
      : undefined;
    stagehand_ai_actions = stagehand_proposal_result?.aiActions ?? [];

    if (
      !stagehand_proposal_result?.proposal ||
      !stagehand_proposal_result.proposal.submitControlResult.control
    ) {
      const no_submit_reason =
        captcha_activation_block_reason ??
        (stagehand_proposal_result
          ? `${submit_control_result.reason}; ${stagehand_proposal_result.reason}`
          : submit_control_result.reason);
      const original_submit_candidate =
        describe_original_submit_candidate(submit_control_result);
      return finalize_unattempted_submission({
        browserSession: browser_session,
        debugContext: debug_context,
        urlBeforeSubmission: url_before_submission,
        submitCandidates: submit_control_result.candidates ?? [],
        buttonAuditEvents: button_audit_events,
        reason: no_submit_reason,
        failureKind: captcha_activation_block_reason
          ? "submission.captcha"
          : submit_control_result.preflightBlocked
            ? "submission.preflight"
            : "submission.no_control",
        ...(submit_control_result.preflightInterceptor
          ? { preflightInterceptor: submit_control_result.preflightInterceptor }
          : {}),
        ...(original_submit_candidate
          ? { originalSubmitCandidate: original_submit_candidate }
          : {}),
        aiActions: stagehand_ai_actions,
        obstructionActions: browser_session.obstructionActions ?? [],
        ...(captcha_activation_block_reason
          ? {
              captchaAssessment: {
                blocked: true,
                reason: captcha_activation_block_reason,
                before: captcha_before_submission,
                after: captcha_before_submission,
              },
            }
          : {}),
      });
    }
    stagehand_proposal = stagehand_proposal_result.proposal;
    submit_control_result = stagehand_proposal.submitControlResult;
  }

  await inactive_control_lifecycle.refresh(
    candidate.form,
    "initial-pre-submit-validation",
  );
  initial_pre_submit_validation = await assess_effective_pre_submit_validity(
    candidate.form,
    submit_control_result.control!,
  );
  final_pre_submit_validation = initial_pre_submit_validation;
  await record_pre_submit_validation(
    browser_session,
    initial_pre_submit_validation,
    "initial",
    false,
  );

  if (
    initial_pre_submit_validation.applicability === "applicable" &&
    initial_pre_submit_validation.valid === false
  ) {
    if (stagehand_proposal) {
      await release_stagehand_submission_proposal_if_present(
        stagehand_proposal,
        "native validity failed before activation; the proposal was discarded before deterministic population recovery",
      );
      stagehand_proposal = undefined;
      stagehand_proposal_discarded = true;
    }
    if (population_recovery_attempted) {
      population_recovery_evidence = {
        ...(population_recovery_evidence ?? {}),
        attempted: true,
        succeeded: false,
        finalValidationReason: initial_pre_submit_validation.reason,
        reason:
          "the single deterministic population recovery budget was already consumed during handoff reconciliation",
      };
      await write_pre_submit_validation_artifact(deep_debug, {
        initial: initial_pre_submit_validation,
        final: final_pre_submit_validation,
        recovery: population_recovery_evidence,
      });
      return finalize_unattempted_submission({
        browserSession: browser_session,
        debugContext: debug_context,
        urlBeforeSubmission: url_before_submission,
        submitCandidates: submit_control_result.candidates ?? [],
        buttonAuditEvents: button_audit_events,
        reason: pre_submit_validation_failure_reason(
          initial_pre_submit_validation,
        ),
        failureKind: "submission.validation",
        validationBlocked: true,
        invalidControls: initial_pre_submit_validation.invalidControls,
        preSubmitValidation: create_pre_submit_validation_evidence(
          initial_pre_submit_validation,
          final_pre_submit_validation,
          population_recovery_evidence,
          inactive_control_lifecycle.evidence,
        ),
        aiActions: stagehand_ai_actions,
        obstructionActions: browser_session.obstructionActions ?? [],
      });
    }
    population_recovery_attempted = true;
    if (!debug_options.recoverPopulation) {
      await write_pre_submit_validation_artifact(deep_debug, {
        initial: initial_pre_submit_validation,
        final: final_pre_submit_validation,
        recovery: {
          attempted: true,
          succeeded: false,
          reason: "no population recovery callback was available",
        },
      });
      return finalize_unattempted_submission({
        browserSession: browser_session,
        debugContext: debug_context,
        urlBeforeSubmission: url_before_submission,
        submitCandidates: submit_control_result.candidates ?? [],
        buttonAuditEvents: button_audit_events,
        reason: pre_submit_validation_failure_reason(
          initial_pre_submit_validation,
        ),
        failureKind: "submission.validation",
        validationBlocked: true,
        invalidControls: initial_pre_submit_validation.invalidControls,
        preSubmitValidation: create_pre_submit_validation_evidence(
          initial_pre_submit_validation,
          final_pre_submit_validation,
          {
            attempted: true,
            succeeded: false,
            reason: "no population recovery callback was available",
          },
          inactive_control_lifecycle.evidence,
        ),
        aiActions: stagehand_ai_actions,
        obstructionActions: browser_session.obstructionActions ?? [],
      });
    }

    await inactive_control_lifecycle.restore(
      "before-deterministic-population-recovery",
    );
    let recovery_result;
    try {
      recovery_result = await debug_options.recoverPopulation({
        candidate,
        validation: initial_pre_submit_validation,
      });
    } catch (error) {
      const recovery_error = describe_error(error);
      await release_stagehand_submission_proposal_if_present(stagehand_proposal);
      population_recovery_evidence = {
        attempted: true,
        succeeded: false,
        reason: recovery_error,
      };
      await write_pre_submit_validation_artifact(deep_debug, {
        initial: initial_pre_submit_validation,
        final: final_pre_submit_validation,
        recovery: population_recovery_evidence,
      });
      return finalize_unattempted_submission({
        browserSession: browser_session,
        debugContext: debug_context,
        urlBeforeSubmission: url_before_submission,
        submitCandidates: submit_control_result.candidates ?? [],
        buttonAuditEvents: button_audit_events,
        reason: `deterministic population recovery failed: ${recovery_error}`,
        failureKind: "submission.validation",
        validationBlocked: true,
        invalidControls: initial_pre_submit_validation.invalidControls,
        preSubmitValidation: create_pre_submit_validation_evidence(
          initial_pre_submit_validation,
          final_pre_submit_validation,
          population_recovery_evidence,
          inactive_control_lifecycle.evidence,
        ),
        aiActions: stagehand_ai_actions,
        obstructionActions: browser_session.obstructionActions ?? [],
      });
    }
    const recovered_population = recovery_result.populationResult;
    population_recovery_evidence = {
      attempted: true,
      succeeded: Boolean(
        !recovered_population.blockingReason &&
          recovered_population.submissionHandoff,
      ),
      blockingReason: recovered_population.blockingReason ?? null,
      populatedFields: recovered_population.populatedFields,
      messageDisposition: recovered_population.messageDisposition,
      hasSubmissionHandoff: Boolean(recovered_population.submissionHandoff),
      aiActionCount: recovered_population.aiActions?.length ?? 0,
    };
    candidate = recovery_result.candidate;

    if (
      recovered_population.blockingReason ||
      !recovered_population.submissionHandoff
    ) {
      await release_stagehand_submission_proposal_if_present(stagehand_proposal);
      await write_pre_submit_validation_artifact(deep_debug, {
        initial: initial_pre_submit_validation,
        final: final_pre_submit_validation,
        recovery: population_recovery_evidence,
      });
      return finalize_unattempted_submission({
        browserSession: browser_session,
        debugContext: debug_context,
        urlBeforeSubmission: url_before_submission,
        submitCandidates: submit_control_result.candidates ?? [],
        buttonAuditEvents: button_audit_events,
        reason:
          recovered_population.blockingReason ??
          "deterministic population recovery did not produce a submission handoff",
        failureKind: "submission.validation",
        validationBlocked: true,
        invalidControls: initial_pre_submit_validation.invalidControls,
        preSubmitValidation: create_pre_submit_validation_evidence(
          initial_pre_submit_validation,
          final_pre_submit_validation,
          population_recovery_evidence,
          inactive_control_lifecycle.evidence,
        ),
        aiActions: stagehand_ai_actions,
        obstructionActions: browser_session.obstructionActions ?? [],
      });
    }

    if (debug_options.contactRequest) {
      const reconciled_recovery =
        await reconcile_population_submission_handoff(
          debug_options.contactRequest,
          candidate,
          recovered_population.submissionHandoff,
          deep_debug,
          { allowRepopulation: false },
        );
      if ("reason" in reconciled_recovery) {
        await release_stagehand_submission_proposal_if_present(
          stagehand_proposal,
        );
        population_recovery_evidence = {
          ...population_recovery_evidence,
          succeeded: false,
          reconciliationReason: reconciled_recovery.reason,
        };
        await write_pre_submit_validation_artifact(deep_debug, {
          initial: initial_pre_submit_validation,
          final: final_pre_submit_validation,
          recovery: population_recovery_evidence,
        });
        return finalize_unattempted_submission({
          browserSession: browser_session,
          debugContext: debug_context,
          urlBeforeSubmission: url_before_submission,
          submitCandidates: submit_control_result.candidates ?? [],
          buttonAuditEvents: button_audit_events,
          reason: `population recovery handoff failed: ${reconciled_recovery.reason}`,
          failureKind: "submission.validation",
          validationBlocked: true,
          invalidControls: initial_pre_submit_validation.invalidControls,
          preSubmitValidation: create_pre_submit_validation_evidence(
            initial_pre_submit_validation,
            final_pre_submit_validation,
            population_recovery_evidence,
            inactive_control_lifecycle.evidence,
          ),
          aiActions: stagehand_ai_actions,
          obstructionActions: browser_session.obstructionActions ?? [],
        });
      }
      if (reconciled_recovery.populationResult) {
        const reconciliation_population =
          reconciled_recovery.populationResult;
        const cumulative_reconciliation_ai_actions = [
          ...(recovered_population.aiActions ?? []),
          ...(reconciliation_population.aiActions ?? []),
        ];
        recovered_population.populatedFields =
          reconciliation_population.populatedFields;
        recovered_population.messageDisposition =
          reconciliation_population.messageDisposition;
        recovered_population.submissionHandoff =
          reconciled_recovery.handoff;
        if (reconciliation_population.blockingReason) {
          recovered_population.blockingReason =
            reconciliation_population.blockingReason;
        } else {
          delete recovered_population.blockingReason;
        }
        if (reconciliation_population.failureKind) {
          recovered_population.failureKind =
            reconciliation_population.failureKind;
        } else {
          delete recovered_population.failureKind;
        }
        if (reconciliation_population.debug) {
          recovered_population.debug = reconciliation_population.debug;
        }
        if (cumulative_reconciliation_ai_actions.length > 0) {
          recovered_population.aiActions =
            cumulative_reconciliation_ai_actions;
        } else {
          delete recovered_population.aiActions;
        }
      } else {
        recovered_population.submissionHandoff =
          reconciled_recovery.handoff;
      }
      candidate = reconciled_recovery.candidate;
      debug_options = {
        ...debug_options,
        populationHandoff: reconciled_recovery.handoff,
      };
    }

    submit_preparation = await prepare_submit_control(candidate, deep_debug);
    browser_session.obstructionActions?.push(
      ...submit_preparation.obstructionActions,
    );
    const recovered_submit_control_result = submit_preparation.result;
    await record_recovered_submit_preparation(
      browser_session,
      candidate,
      recovered_submit_control_result,
      submit_preparation.obstructionActions,
    );
    if (recovered_submit_control_result.control) {
      await release_stagehand_submission_proposal_if_present(stagehand_proposal);
      stagehand_proposal = undefined;
      submit_control_result = recovered_submit_control_result;
    } else {
      await write_pre_submit_validation_artifact(deep_debug, {
        initial: initial_pre_submit_validation,
        final: final_pre_submit_validation,
        recovery: {
          ...population_recovery_evidence,
          succeeded: false,
          finalSubmitControlReason: recovered_submit_control_result.reason,
        },
      });
      return finalize_unattempted_submission({
        browserSession: browser_session,
        debugContext: debug_context,
        urlBeforeSubmission: url_before_submission,
        submitCandidates: recovered_submit_control_result.candidates ?? [],
        buttonAuditEvents: button_audit_events,
        reason:
          `native validity could not be re-established after population recovery: ${recovered_submit_control_result.reason}`,
        failureKind: "submission.validation",
        validationBlocked: true,
        invalidControls: final_pre_submit_validation.invalidControls,
        preSubmitValidation: create_pre_submit_validation_evidence(
          initial_pre_submit_validation,
          final_pre_submit_validation,
          {
            ...population_recovery_evidence,
            succeeded: false,
            finalSubmitControlReason: recovered_submit_control_result.reason,
          },
          inactive_control_lifecycle.evidence,
        ),
        aiActions: stagehand_ai_actions,
        obstructionActions: browser_session.obstructionActions ?? [],
      });
    }

    await inactive_control_lifecycle.refresh(
      candidate.form,
      "after-deterministic-population-recovery",
    );
    final_pre_submit_validation = await assess_effective_pre_submit_validity(
      candidate.form,
      submit_control_result.control!,
    );
    await record_pre_submit_validation(
      browser_session,
      final_pre_submit_validation,
      "final-after-recovery",
      true,
    );
  }

  if (
    final_pre_submit_validation.applicability === "inspectionFailed" ||
    (final_pre_submit_validation.applicability === "applicable" &&
      final_pre_submit_validation.valid !== true)
  ) {
    if (population_recovery_attempted) {
      population_recovery_evidence = {
        ...(population_recovery_evidence ?? {}),
        attempted: true,
        succeeded: false,
        finalValidationReason: final_pre_submit_validation.reason,
      };
    }
    await release_stagehand_submission_proposal_if_present(stagehand_proposal);
    await write_pre_submit_validation_artifact(deep_debug, {
      initial: initial_pre_submit_validation,
      final: final_pre_submit_validation,
      recovery:
        population_recovery_evidence ?? {
          attempted: population_recovery_attempted,
          succeeded: false,
        },
      inactiveConditionalControls: inactive_control_lifecycle.evidence,
    });
    return finalize_unattempted_submission({
      browserSession: browser_session,
      debugContext: debug_context,
      urlBeforeSubmission: url_before_submission,
      submitCandidates: submit_control_result.candidates ?? [],
      buttonAuditEvents: button_audit_events,
      reason: pre_submit_validation_failure_reason(
        final_pre_submit_validation,
      ),
      failureKind: "submission.validation",
      validationBlocked: true,
      invalidControls: final_pre_submit_validation.invalidControls,
      preSubmitValidation: create_pre_submit_validation_evidence(
        initial_pre_submit_validation,
        final_pre_submit_validation,
        population_recovery_evidence ?? {
          attempted: population_recovery_attempted,
          succeeded: false,
        },
      ),
      aiActions: stagehand_ai_actions,
      obstructionActions: browser_session.obstructionActions ?? [],
    });
  }

  await inactive_control_lifecycle.refresh(
    candidate.form,
    "immediately-before-submit-activation",
  );
  final_pre_submit_validation = await assess_effective_pre_submit_validity(
    candidate.form,
    submit_control_result.control!,
  );
  await record_pre_submit_validation(
    browser_session,
    final_pre_submit_validation,
    "immediately-before-submit-activation",
    population_recovery_attempted,
  );
  if (
    final_pre_submit_validation.applicability === "inspectionFailed" ||
    (final_pre_submit_validation.applicability === "applicable" &&
      final_pre_submit_validation.valid !== true)
  ) {
    population_recovery_evidence = {
      ...(population_recovery_evidence ?? {}),
      attempted: population_recovery_attempted,
      succeeded: false,
      finalValidationReason: final_pre_submit_validation.reason,
      lastMomentActivityChange: true,
    };
    await release_stagehand_submission_proposal_if_present(stagehand_proposal);
    await write_pre_submit_validation_artifact(deep_debug, {
      initial: initial_pre_submit_validation,
      final: final_pre_submit_validation,
      recovery: population_recovery_evidence,
      inactiveConditionalControls: inactive_control_lifecycle.evidence,
    });
    return finalize_unattempted_submission({
      browserSession: browser_session,
      debugContext: debug_context,
      urlBeforeSubmission: url_before_submission,
      submitCandidates: submit_control_result.candidates ?? [],
      buttonAuditEvents: button_audit_events,
      reason: pre_submit_validation_failure_reason(final_pre_submit_validation),
      failureKind: "submission.validation",
      validationBlocked: true,
      invalidControls: final_pre_submit_validation.invalidControls,
      preSubmitValidation: create_pre_submit_validation_evidence(
        initial_pre_submit_validation,
        final_pre_submit_validation,
        population_recovery_evidence,
        inactive_control_lifecycle.evidence,
      ),
      aiActions: stagehand_ai_actions,
      obstructionActions: browser_session.obstructionActions ?? [],
    });
  }

  const pre_submit_validation_evidence =
    create_pre_submit_validation_evidence(
      initial_pre_submit_validation,
      final_pre_submit_validation,
      population_recovery_evidence ?? {
        attempted: false,
        succeeded: false,
      },
      inactive_control_lifecycle.evidence,
    );
  await write_pre_submit_validation_artifact(deep_debug, {
    initial: initial_pre_submit_validation,
    final: final_pre_submit_validation,
    recovery:
      population_recovery_evidence ?? {
        attempted: false,
        succeeded: false,
      },
    inactiveConditionalControls: inactive_control_lifecycle.evidence,
  });
  url_before_submission = page.url();
  confirmation_visible_before = await has_visible_success_message(page);
  messages_before_submission = await collect_visible_message_candidates(page);
  captcha_before_submission = await assess_page_captcha(page);
  deep_debug?.record({
    stage: "submission",
    substage: "baseline",
    operation: "capture-activation-baseline",
    outcome: "succeeded",
    url: url_before_submission,
    frameUrl: candidate.frame.url(),
    data: {
      confirmationVisibleBefore: confirmation_visible_before,
      messageCandidatesBefore: messages_before_submission,
      captchaBefore: captcha_before_submission,
      populationRecoveryAttempted: population_recovery_attempted,
    },
  });
  if (debug_context) {
    await safe_page_screenshot(
      page,
      debug_context.beforeSubmitScreenshotPath,
      browser_session.redactionValues,
    );
  }

  if (stagehand_proposal) {
    const stagehand_result = await activate_stagehand_submission_proposal(
      stagehand_proposal,
      button_audit_events,
    );
    if (
      !stagehand_result.attempted ||
      !stagehand_result.submitControlResult?.control ||
      !stagehand_result.submitButtonEvent
    ) {
      return finalize_unattempted_submission({
        browserSession: browser_session,
        debugContext: debug_context,
        urlBeforeSubmission: url_before_submission,
        submitCandidates: submit_control_result.candidates ?? [],
        buttonAuditEvents: button_audit_events,
        reason: stagehand_result.reason,
        failureKind: "submission.no_control",
        preSubmitValidation: pre_submit_validation_evidence,
        aiActions: stagehand_result.aiActions,
        obstructionActions: browser_session.obstructionActions ?? [],
      });
    }
    if (stagehand_result.aiActions.length > 0) {
      deep_debug?.recordAiOperations(
        "submission",
        stagehand_result.reason || "Stagehand submit proposal activated",
        stagehand_result.aiActions,
      );
    }
    return assess_attempted_submission({
      browserSession: browser_session,
      candidate,
      debugContext: debug_context,
      urlBeforeSubmission: url_before_submission,
      confirmationVisibleBefore: confirmation_visible_before,
      messagesBeforeSubmission: messages_before_submission,
      submitControl: stagehand_result.submitButtonEvent,
      submitCandidates: submit_control_result.candidates ?? [],
      buttonAuditEvents: button_audit_events,
      submitButtonEvent: stagehand_result.submitButtonEvent,
      allowIntermediateConfirmation: false,
      ...(stagehand_result.clickError
        ? { clickError: stagehand_result.clickError }
        : {}),
      aiActions: stagehand_result.aiActions,
      captchaBeforeSubmission: captcha_before_submission,
      obstructionActions: browser_session.obstructionActions ?? [],
      preSubmitValidation: pre_submit_validation_evidence,
    });
  }

  if (stagehand_proposal_discarded && stagehand_ai_actions.length > 0) {
    deep_debug?.recordAiOperations(
      "submission",
      "Stagehand submit proposal was rejected before deterministic population recovery",
      stagehand_ai_actions,
    );
  }
  const submit_control_debug = await describe_button_control(
    submit_control_result.control!,
    submit_control_result,
  );
  const submit_button_event = await create_button_click_audit_event(
    page,
    "submit",
    submit_control_result.control!,
    submit_control_result,
    button_audit_events.length + 1,
  );
  button_audit_events.push(submit_button_event);
  deep_debug?.record({
    stage: "submission",
    substage: "submit-click",
    operation: "activate-submit-control",
    outcome: "started",
    correlationId: "primary-submit-click",
    url: page.url(),
    frameUrl: candidate.frame.url(),
    data: {
      control: submit_control_debug,
      audit: submit_button_event,
    },
  });
  await deep_debug?.captureFormSnapshot({
    stage: "submission",
    label: "20-immediately-before-submit-click",
    form: candidate.form,
    expectedValues: browser_session.redactionValues ?? [],
  });

  let click_error: string | undefined;
  try {
    await submit_control_result.control!.click({ timeout: ACTION_TIMEOUT_MS });
    mark_button_click_succeeded(submit_button_event);
  } catch (error) {
    click_error = describe_error(error);
    mark_button_click_failed(submit_button_event, click_error);
  }
  deep_debug?.record({
    stage: "submission",
    substage: "submit-click",
    operation: "activate-submit-control",
    outcome: click_error ? "failed" : "succeeded",
    correlationId: "primary-submit-click",
    reason: click_error,
    url: page.url(),
    data: { audit: submit_button_event },
  });

  return assess_attempted_submission({
    browserSession: browser_session,
    candidate,
    debugContext: debug_context,
    urlBeforeSubmission: url_before_submission,
    confirmationVisibleBefore: confirmation_visible_before,
    messagesBeforeSubmission: messages_before_submission,
    submitControl: submit_control_debug,
    submitCandidates: submit_control_result.candidates ?? [],
    buttonAuditEvents: button_audit_events,
    submitButtonEvent: submit_button_event,
    allowIntermediateConfirmation: true,
    ...(click_error ? { clickError: click_error } : {}),
    aiActions: stagehand_ai_actions,
    captchaBeforeSubmission: captcha_before_submission,
    obstructionActions: browser_session.obstructionActions ?? [],
    preSubmitValidation: pre_submit_validation_evidence,
  });
}

async function record_pre_submit_validation(
  browser_session: BrowserSession,
  validation: EffectivePreSubmitValidationResult,
  label: string,
  recovery_attempted: boolean,
): Promise<void> {
  const deep_debug = browser_session.deepDebug;
  deep_debug?.record({
    stage: "submission",
    substage: "pre-submit-validation",
    operation: "assess-effective-native-validity",
    outcome:
      validation.applicability === "inspectionFailed"
        ? "failed"
        : validation.applicability === "applicable" &&
            validation.valid === false
          ? "blocked"
          : validation.applicability === "notApplicable"
            ? "skipped"
            : "succeeded",
    reason: validation.reason,
    url: browser_session.page.url(),
    data: {
      checkpoint: label,
      recoveryAttempted: recovery_attempted,
      validation,
    },
  });
}

type InactiveConditionalControlEvidence = NonNullable<
  PreSubmitValidationDebugEvidence["inactiveConditionalControls"]
>;

interface InactiveConditionalControlLifecycle {
  evidence: InactiveConditionalControlEvidence;
  refresh: (form: import("playwright").Locator, label: string) => Promise<void>;
  restore: (label: string) => Promise<RequiredControlRestorationResult>;
}

function create_inactive_conditional_control_lifecycle(
  browser_session: BrowserSession,
): InactiveConditionalControlLifecycle {
  let lease: InactiveRequiredControlLease | undefined;
  const evidence: InactiveConditionalControlEvidence = {
    checkpoints: [],
    restorations: [],
  };
  const restore = async (
    label: string,
  ): Promise<RequiredControlRestorationResult> => {
    const result = lease
      ? await lease.restore()
      : { attempted: 0, restored: 0, detached: 0, failed: 0 };
    lease = undefined;
    evidence.restorations.push({ label, result });
    browser_session.deepDebug?.record({
      stage: "submission",
      substage: "inactive-conditional-controls",
      operation: "restore-temporarily-disabled-required-controls",
      outcome: result.failed > 0 ? "failed" : "succeeded",
      reason:
        result.failed > 0
          ? `${result.failed} temporarily disabled control(s) could not be restored`
          : undefined,
      url: browser_session.page.url(),
      data: { label, result },
    });
    await browser_session.deepDebug?.writeJson(
      "submission/inactive-conditional-controls.json",
      evidence,
    );
    return result;
  };
  return {
    evidence,
    restore,
    refresh: async (form, label) => {
      if (lease) {
        await restore(`${label}:restore-previous-checkpoint`);
      }
      lease = await temporarily_disable_inactive_required_controls(form);
      const checkpoint = {
        label,
        inventory: lease.inventory.counts,
        disabledControls: lease.disabledControls,
      };
      evidence.checkpoints.push(checkpoint);
      browser_session.deepDebug?.record({
        stage: "submission",
        substage: "inactive-conditional-controls",
        operation: "temporarily-disable-inactive-required-controls",
        outcome:
          lease.disabledControls.length > 0 ? "succeeded" : "skipped",
        url: browser_session.page.url(),
        data: checkpoint,
      });
      await browser_session.deepDebug?.writeJson(
        "submission/inactive-conditional-controls.json",
        evidence,
      );
    },
  };
}

async function record_recovered_submit_preparation(
  browser_session: BrowserSession,
  candidate: ContactFormCandidate,
  result: SubmitControlSearchResult,
  obstruction_actions: NonNullable<BrowserSession["obstructionActions"]>,
): Promise<void> {
  const deep_debug = browser_session.deepDebug;
  deep_debug?.record({
    stage: "submission",
    substage: "submit-selection",
    operation: "prepare-submit-control-after-population-recovery",
    outcome: result.control ? "succeeded" : "blocked",
    reason: result.reason || undefined,
    url: browser_session.page.url(),
    frameUrl: candidate.frame.url(),
    data: {
      strategy: result.strategy ?? null,
      selector: result.selector ?? null,
      selectedIndex: result.selectedIndex ?? null,
      score: result.score ?? null,
      preflightBlocked: result.preflightBlocked ?? false,
      preflightInterceptor: result.preflightInterceptor ?? null,
      candidates: result.candidates ?? [],
      obstructionActions: obstruction_actions,
    },
  });
  await deep_debug?.captureFormSnapshot({
    stage: "submission",
    label: "15-after-population-recovery-submit-preflight",
    form: candidate.form,
    expectedValues: browser_session.redactionValues ?? [],
  });
}

async function write_pre_submit_validation_artifact(
  deep_debug: BrowserSession["deepDebug"],
  evidence: {
    initial: EffectivePreSubmitValidationResult;
    final: EffectivePreSubmitValidationResult;
    recovery: Record<string, unknown>;
    inactiveConditionalControls?: InactiveConditionalControlEvidence;
  },
): Promise<void> {
  await deep_debug?.writeJson(
    "submission/pre-submit-validation.json",
    evidence,
  );
}

function create_pre_submit_validation_evidence(
  initial: EffectivePreSubmitValidationResult,
  final: EffectivePreSubmitValidationResult,
  recovery: Record<string, unknown>,
  inactive_conditional_controls?: InactiveConditionalControlEvidence,
): PreSubmitValidationDebugEvidence {
  return {
    initial,
    final,
    recovery,
    ...(inactive_conditional_controls
      ? { inactiveConditionalControls: inactive_conditional_controls }
      : {}),
  };
}

function pre_submit_validation_failure_reason(
  validation: EffectivePreSubmitValidationResult,
): string {
  return `browser form validation blocked submission before activation: ${validation.reason}`;
}

async function release_stagehand_submission_proposal_if_present(
  proposal: StagehandSubmissionProposal | undefined,
  reason = "Stagehand submit proposal was released before activation",
): Promise<void> {
  if (!proposal) return;
  await release_stagehand_submission_proposal(proposal, reason).catch(
    () => undefined,
  );
}

interface FinalizeUnattemptedSubmissionInput {
  browserSession: BrowserSession;
  debugContext: SubmissionDebugContext | undefined;
  urlBeforeSubmission: string;
  submitCandidates: SubmitCandidateDebugInfo[];
  buttonAuditEvents: ButtonClickAuditEvent[];
  reason: string;
  failureKind: SubmissionAssessment["failureKind"];
  validationBlocked?: boolean;
  invalidControls?: EffectivePreSubmitValidationResult["invalidControls"];
  preSubmitValidation?: PreSubmitValidationDebugEvidence;
  originalSubmitCandidate?: string | undefined;
  preflightInterceptor?: SubmitControlSearchResult["preflightInterceptor"];
  aiActions: AiActionEvidence[];
  obstructionActions: NonNullable<BrowserSession["obstructionActions"]>;
  captchaAssessment?: CaptchaBlockAssessment;
}

async function finalize_unattempted_submission({
  browserSession,
  debugContext,
  urlBeforeSubmission,
  submitCandidates,
  buttonAuditEvents,
  reason,
  failureKind,
  validationBlocked = false,
  invalidControls = [],
  preSubmitValidation,
  originalSubmitCandidate,
  preflightInterceptor,
  aiActions,
  obstructionActions,
  captchaAssessment,
}: FinalizeUnattemptedSubmissionInput): Promise<SubmissionAssessment> {
  const deep_debug = browserSession.deepDebug;
  deep_debug?.record({
    stage: "submission",
    substage: "result",
    operation: "submission-not-attempted",
    outcome: "blocked",
    reason,
    url: browserSession.page.url(),
    data: {
      failureKind: failureKind ?? null,
      candidateCount: submitCandidates.length,
      buttonAuditEvents,
      captchaAssessment: captchaAssessment ?? null,
      obstructionActions,
    },
  });
  if (aiActions.length > 0) {
    deep_debug?.recordAiOperations("submission", reason, aiActions);
  }
  const network_records = browserSession.networkDebugRecorder?.stop() ?? [];
  const network_submission_evidence = analyze_network_submission_evidence(
    network_records,
    undefined,
    { pageUrlBeforeSubmission: urlBeforeSubmission },
  );
  const debug = await finalize_submission_debug({
    page: browserSession.page,
    debugContext,
    urlBeforeSubmission,
    submitControl: undefined,
    verifiedSubmitTarget: false,
    submitClickDispatched: false,
    ...(originalSubmitCandidate ? { originalSubmitCandidate } : {}),
    ...(preflightInterceptor ? { preflightInterceptor } : {}),
    submitCandidates,
    postSubmitMessages: [],
    invalidControls,
    ...(preSubmitValidation ? { preSubmitValidation } : {}),
    networkRecords: network_records,
    buttonAuditEvents,
    confirmed: false,
    confirmationEvidence: "none",
    networkSubmissionEvidence: network_submission_evidence,
    confirmationControlClicked: false,
    obstructionActions,
    ...(captchaAssessment ? { captchaAssessment } : {}),
    noSubmitReason: reason,
    redactionValues: browserSession.redactionValues ?? [],
  });

  return {
    attempted: false,
    confirmed: false,
    validationBlocked,
    ...(captchaAssessment?.blocked ? { captchaBlocked: true } : {}),
    reason,
    ...(failureKind ? { failureKind } : {}),
    ...(debug ? { debug } : {}),
    ...(aiActions.length > 0 ? { aiActions } : {}),
  };
}

interface AssessAttemptedSubmissionInput {
  browserSession: BrowserSession;
  candidate: ContactFormCandidate;
  debugContext: SubmissionDebugContext | undefined;
  urlBeforeSubmission: string;
  confirmationVisibleBefore: boolean;
  messagesBeforeSubmission: MessageCandidateDebugInfo[];
  submitControl: ButtonControlDebugInfo;
  submitCandidates: SubmitCandidateDebugInfo[];
  buttonAuditEvents: ButtonClickAuditEvent[];
  submitButtonEvent: ButtonClickAuditEvent;
  allowIntermediateConfirmation: boolean;
  clickError?: string;
  aiActions: AiActionEvidence[];
  captchaBeforeSubmission: CaptchaAssessment;
  obstructionActions: NonNullable<BrowserSession["obstructionActions"]>;
  preSubmitValidation: PreSubmitValidationDebugEvidence;
}

async function assess_attempted_submission({
  browserSession,
  candidate,
  debugContext,
  urlBeforeSubmission,
  confirmationVisibleBefore,
  messagesBeforeSubmission,
  submitControl,
  submitCandidates,
  buttonAuditEvents,
  submitButtonEvent,
  allowIntermediateConfirmation,
  clickError,
  aiActions,
  captchaBeforeSubmission,
  obstructionActions,
  preSubmitValidation,
}: AssessAttemptedSubmissionInput): Promise<SubmissionAssessment> {
  const page = browserSession.page;
  const deep_debug = browserSession.deepDebug;
  deep_debug?.record({
    stage: "submission",
    substage: "post-click",
    operation: "begin-post-submit-assessment",
    outcome: "started",
    correlationId: "primary-submit-click",
    url: page.url(),
    data: {
      clickError: clickError ?? null,
      confirmationVisibleBefore,
      messagesBeforeSubmission,
    },
  });
  await page.waitForTimeout(2_000).catch(() => undefined);
  const messages_after_two_seconds =
    await collect_visible_message_candidates(page);
  await deep_debug?.captureFormSnapshot({
    stage: "submission",
    label: "30-after-submit-2s",
    form: candidate.form,
    expectedValues: browserSession.redactionValues ?? [],
    extra: { messages: messages_after_two_seconds },
  });
  await deep_debug?.captureScreenshot(page, "submission", "30-after-submit-2s");
  deep_debug?.record({
    stage: "submission",
    substage: "post-click",
    operation: "two-second-checkpoint",
    outcome: "observed",
    url: page.url(),
    data: { messages: messages_after_two_seconds },
  });
  if (debugContext) {
    await safe_page_screenshot(
      page,
      debugContext.afterSubmit2sScreenshotPath,
      browserSession.redactionValues,
    );
  }

  const submit_click_dispatched = submitButtonEvent.clickResult === "clicked";
  const verified_submit_target = true;
  let captcha_assessment = await assess_captcha_blockage(
    page,
    captchaBeforeSubmission,
    submit_click_dispatched,
  );
  const invalid_controls = await collect_invalid_controls(candidate.form);
  deep_debug?.record({
    stage: "submission",
    substage: "post-submit-validation-diagnostic",
    operation: "collect-post-submit-invalid-controls",
    outcome: "observed",
    data: {
      invalidControls: invalid_controls,
      invalidControlsAreDiagnosticOnly: true,
    },
  });
  const confirmation_control_clicked =
    allowIntermediateConfirmation &&
    !clickError &&
    !captcha_assessment.blocked
      ? await click_confirmation_control_if_present(
          page,
          buttonAuditEvents,
        )
      : false;
  deep_debug?.record({
    stage: "submission",
    substage: "intermediate-confirmation",
    operation: "click-confirmation-control-if-present",
    outcome: confirmation_control_clicked ? "succeeded" : "skipped",
    data: {
      allowed: allowIntermediateConfirmation,
      clickError: clickError ?? null,
      captchaBlocked: captcha_assessment.blocked,
      invalidControlCount: invalid_controls.length,
      invalidControlsAreDiagnosticOnly: true,
    },
  });
  const visible_confirmation_evidence = await wait_for_submission_confirmation(
    page,
    urlBeforeSubmission,
    confirmationVisibleBefore,
    messagesBeforeSubmission,
    browserSession.redactionValues ?? [],
  );
  const messages_after_confirmation =
    await collect_visible_message_candidates(page);
  deep_debug?.record({
    stage: "confirmation",
    substage: "deterministic-evidence",
    operation: "wait-for-submission-confirmation",
    outcome:
      visible_confirmation_evidence.confirmationEvidence === "none"
        ? visible_confirmation_evidence.rejectionEvidence.length > 0
          ? "observed"
          : "failed"
        : "succeeded",
    url: page.url(),
    data: {
      evidence: visible_confirmation_evidence.confirmationEvidence,
      rejectionEvidence: visible_confirmation_evidence.rejectionEvidence,
      newMessageCandidates: visible_confirmation_evidence.newMessages,
      messageCandidates: messages_after_confirmation,
    },
  });
  const post_submit_messages = merge_message_candidates(
    messages_after_two_seconds,
    messages_after_confirmation,
  );
  captcha_assessment = await assess_captcha_blockage(
    page,
    captchaBeforeSubmission,
    submit_click_dispatched,
  );
  const network_records = browserSession.networkDebugRecorder?.stop() ?? [];
  const network_submission_evidence = analyze_network_submission_evidence(
    network_records,
    submitButtonEvent.timestamp,
    { pageUrlBeforeSubmission: urlBeforeSubmission },
  );
  deep_debug?.record({
    stage: "confirmation",
    substage: "network-evidence",
    operation: "analyze-network-submission-evidence",
    outcome: network_submission_evidence.confirmsSubmission
      ? "succeeded"
      : network_submission_evidence.found ? "observed" : "failed",
    data: network_submission_evidence,
  });
  if (network_submission_evidence.captchaRejected) {
    captcha_assessment = {
      ...captcha_assessment,
      blocked: true,
      reason:
        network_submission_evidence.captchaRejectionReason ??
        "CAPTCHA physically blocked submission: the correlated form request was rejected",
    };
  }
  let terminal_evidence = assess_authoritative_submission_evidence({
    visibleEvidence: visible_confirmation_evidence,
    networkEvidence: network_submission_evidence,
    captchaBlocked: captcha_assessment.blocked,
    urlBeforeSubmission,
    urlAfterSubmission: page.url(),
    redactionValues: browserSession.redactionValues ?? [],
  });

  if (
    terminal_evidence.disposition === "unconfirmed" &&
    !captcha_assessment.blocked
  ) {
    const page_intelligence =
      browserSession.pageIntelligence ??
      (await browserSession.ensurePageIntelligence?.());
    if (page_intelligence) {
      const stagehand_confirmation =
        await classify_stagehand_submission_confirmation({
        pageIntelligence: page_intelligence,
        page,
        messagesBeforeSubmission,
        messagesAfterSubmission: post_submit_messages,
        redactionValues: browserSession.redactionValues ?? [],
      });
      aiActions.push(...stagehand_confirmation.aiActions);
      deep_debug?.recordAiOperations(
        "confirmation",
        "deterministic confirmation evidence was exhausted",
        stagehand_confirmation.aiActions,
      );
      terminal_evidence = assess_authoritative_submission_evidence({
        visibleEvidence: visible_confirmation_evidence,
        networkEvidence: network_submission_evidence,
        captchaBlocked: captcha_assessment.blocked,
        stagehandEvidence: stagehand_confirmation.evidence,
        urlBeforeSubmission,
        urlAfterSubmission: page.url(),
        redactionValues: browserSession.redactionValues ?? [],
      });
    }
  }

  const confirmed = terminal_evidence.confirmed;
  const confirmation_evidence = terminal_evidence.confirmationEvidence;
  const rejection_evidence = terminal_evidence.rejectionEvidence;
  const { reason: _raw_captcha_reason, ...captcha_without_reason } =
    captcha_assessment;
  const terminal_captcha_assessment: CaptchaBlockAssessment = confirmed
    ? { ...captcha_without_reason, blocked: false }
    : terminal_evidence.disposition === "captchaBlocked"
      ? {
          ...captcha_assessment,
          blocked: true,
          reason:
            captcha_assessment.reason ??
            terminal_evidence.reason ??
            "CAPTCHA physically blocked submission",
        }
      : captcha_assessment;
  await deep_debug?.captureFormSnapshot({
    stage: "confirmation",
    label: "99-final-confirmation-state",
    form: candidate.form,
    expectedValues: browserSession.redactionValues ?? [],
    extra: {
      confirmationEvidence: confirmation_evidence,
      postClickDisposition: terminal_evidence.disposition,
      rejectionEvidence: rejection_evidence,
      confirmed,
      invalidControls: invalid_controls,
      captcha: captcha_assessment,
      networkSubmissionEvidence: network_submission_evidence,
      postSubmitMessages: post_submit_messages,
    },
  });
  await deep_debug?.captureScreenshot(
    page,
    "confirmation",
    "99-final-confirmation-state",
  );
  deep_debug?.record({
    stage: "submission",
    substage: "result",
    operation: "submission-assessment-completed",
    outcome: confirmed
      ? "succeeded"
      : terminal_evidence.disposition === "contradictory"
          ? "observed"
          : terminal_evidence.disposition === "captchaBlocked"
            ? "blocked"
            : "failed",
    reason: confirmed
      ? undefined
      : terminal_evidence.disposition === "captchaBlocked"
        ? captcha_assessment.reason ??
          terminal_evidence.reason ??
          "CAPTCHA physically blocked submission"
        : terminal_evidence.reason ??
          captcha_assessment.reason ??
          clickError ??
          "submission was attempted without confirmation",
    url: page.url(),
    data: {
      submitClickDispatched: submit_click_dispatched,
      postClickDisposition: terminal_evidence.disposition,
      confirmationEvidence: confirmation_evidence,
      rejectionEvidence: rejection_evidence,
      invalidControlCount: invalid_controls.length,
      invalidControlsAreDiagnosticOnly: true,
      captcha: captcha_assessment,
      networkSubmissionEvidence: network_submission_evidence,
      buttonAuditEvents,
      signalScore: terminal_evidence.signalScore,
      unknownSignals: terminal_evidence.unknownSignals,
    },
  });
  if (deep_debug && terminal_evidence.unknownSignals.length > 0) {
    await deep_debug.writeJson("submission/unknown-signals.json", {
      schemaVersion: 1,
      rulebookVersion: terminal_evidence.signalScore.rulebookVersion,
      candidates: terminal_evidence.unknownSignals,
    });
  }
  const debug = await finalize_submission_debug({
    page,
    debugContext,
    urlBeforeSubmission,
    submitControl,
    verifiedSubmitTarget: verified_submit_target,
    submitClickDispatched: submit_click_dispatched,
    submitClickTimestamp: submitButtonEvent.timestamp,
    originalSubmitCandidate: summarize_original_button_candidate(submitControl),
    submitCandidates,
    postSubmitMessages: post_submit_messages,
    invalidControls: invalid_controls,
    preSubmitValidation,
    networkRecords: network_records,
    buttonAuditEvents,
    confirmed,
    postClickDisposition: terminal_evidence.disposition,
    rejectionEvidence: rejection_evidence,
    confirmationEvidence: confirmation_evidence,
    networkSubmissionEvidence: network_submission_evidence,
    confirmationControlClicked: confirmation_control_clicked,
    captchaAssessment: terminal_captcha_assessment,
    obstructionActions,
    ...(clickError ? { clickError } : {}),
    redactionValues: browserSession.redactionValues,
  });
  const optional_details = {
    signalEvaluation: { evaluated: true as const, ...terminal_evidence.signalScore },
    unknownSubmissionSignals: terminal_evidence.unknownSignals,
    ...(debug ? { debug } : {}),
    ...(aiActions.length > 0 ? { aiActions } : {}),
  };

  if (confirmed) {
    return {
      attempted: true,
      confirmed: true,
      validationBlocked: false,
      captchaBlocked: false,
      postClickDisposition: "confirmed",
      confirmationEvidence: confirmation_evidence,
      ...optional_details,
    };
  }

  if (
    terminal_evidence.disposition === "rejected" ||
    terminal_evidence.disposition === "contradictory"
  ) {
    return {
      attempted: true,
      confirmed: false,
      validationBlocked: false,
      captchaBlocked: false,
      postClickDisposition: terminal_evidence.disposition,
      confirmationEvidence: confirmation_evidence,
      rejectionEvidence: rejection_evidence,
      ...(terminal_evidence.reason ? { reason: terminal_evidence.reason } : {}),
      ...(terminal_evidence.failureKind
        ? { failureKind: terminal_evidence.failureKind }
        : {}),
      ...optional_details,
    };
  }

  if (terminal_evidence.disposition === "captchaBlocked") {
    return {
      attempted: true,
      confirmed: false,
      validationBlocked: false,
      captchaBlocked: true,
      postClickDisposition: "captchaBlocked",
      confirmationEvidence: "none",
      ...(rejection_evidence.length > 0
        ? { rejectionEvidence: rejection_evidence }
        : {}),
      reason:
        captcha_assessment.reason ??
        terminal_evidence.reason ??
        "CAPTCHA physically blocked submission",
      failureKind: "submission.captcha",
      ...optional_details,
    };
  }

  return {
    attempted: true,
    confirmed: false,
    validationBlocked: false,
    captchaBlocked: false,
    postClickDisposition: "unconfirmed",
    confirmationEvidence: "none",
    reason: clickError
      ? `submit control could not be activated: ${clickError}; submission was not confirmed`
      : "submission was attempted, but no explicit confirmation appeared",
    failureKind: "submission.unconfirmed",
    ...optional_details,
  };
}

function describe_original_submit_candidate(
  result: SubmitControlSearchResult,
): string | undefined {
  if (!result.strategy) {
    return undefined;
  }
  return `${result.strategy} index=${result.selectedIndex ?? "none"} score=${result.score ?? "none"}`;
}

function summarize_original_button_candidate(
  control: ButtonControlDebugInfo,
): string {
  return `${control.selectorStrategy} index=${control.selectedIndex ?? "none"} score=${control.score ?? "none"}`;
}

function merge_message_candidates(
  ...groups: MessageCandidateDebugInfo[][]
): MessageCandidateDebugInfo[] {
  const seen = new Set<string>();
  return groups.flat().filter((message) => {
    const key = `${message.frameUrl}\n${message.selector}\n${message.text}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
