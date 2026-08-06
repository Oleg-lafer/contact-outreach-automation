import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
  AiActionEvidence,
  ContactFormCandidate,
  ContactRequest,
  FormPopulationResult,
  FieldMatchingDiagnostic,
  MessageDisposition,
  MissingFieldsReport,
  PageObstructionAction,
  PopulatedField,
  PopulationSubmissionHandoff,
  PopulationDebugSummary,
} from "../../shared_files_forms/forms_types_(Support).js";
import { assess_contact_form } from "../../shared_files_forms/contact_form_intent_(Deterministic).js";
import type { PageIntelligence } from "../../../../shared_files_orchestrator/page_intelligence_(Integration).js";
import type { DeepDebugContext } from "../../shared_files_forms/deep_debug_types_(Support).js";
import { assess_required_control_inventory } from "../../shared_files_forms/required_control_inventory_(Deterministic).js";
import { dismiss_cookie_obstruction } from "../../../../shared_files_orchestrator/page_obstructions_(Deterministic).js";
import {
  populate_form_like_container_fields,
} from "./B2_population_strategies_(Deterministic).js";
import {
  FILLABLE_CONTACT_CONTROL_SELECTOR,
  describe_field,
  fill_matched_control,
  is_usable_control,
  match_contact_field,
} from "./B3_population_field_matching_(Deterministic).js";
import { satisfy_undefined_field_fallback } from "./B5_undefined_field_fallback_(Deterministic).js";
import { populate_contact_form_with_stagehand_fallback } from "./B6_stagehand_population_fallback_(LLM).js";
import {
  advance_contact_form_step,
  find_stagehand_complete_alternative_form,
} from "./B7_contact_form_progression_(Integration).js";

const MAX_CONTACT_FORM_PROGRESSION_STEPS = 2;

const POPULATED_FIELD_ORDER: PopulatedField[] = [
  "name",
  "email",
  "phone",
  "message",
  "company",
  "role",
  "website",
  "country",
  "consent",
  "selection",
];

export interface ContactFormPopulationOptions {
  artifactDirectory?: string | undefined;
  pageIntelligence?: PageIntelligence | undefined;
  ensurePageIntelligence?: (() => Promise<PageIntelligence>) | undefined;
  obstructionActions?: PageObstructionAction[] | undefined;
  deepDebug?: DeepDebugContext | undefined;
}

/*
 * TOP LEVEL WORKFLOW:
 *
 * populate_contact_form(contact_request, candidate)
 *        |
 *        v
 * avoid CAPTCHA controls without treating provider markup as a failure
 *        |
 *        v
 * fill contact fields using structural or generic matching
 *        |
 *        v
 * satisfy required radio controls
 *        |
 *        v
 * check required privacy consent
 *        |
 *        v
 * run undefined-field fallback
 */

/*
 * ========================================================================
 * TOP_LEVEL_WORKFLOW_FUNCTIONS
 * ========================================================================
 */

/*
 * ========================================================================
 * CONTACT FORM POPULATION - populate_contact_form(...)
 * ========================================================================
 * Input:  The validated contact request and selected form candidate.
 * Output: The fields populated and any condition that prevents submission.
 *
 * Responsibility: Coordinate field population and required-control handling
 * while delegating matching, strategy-specific filling, and consent details.
 * ========================================================================
 */
export async function populate_contact_form(
  contact_request: ContactRequest,
  candidate: ContactFormCandidate,
  options: ContactFormPopulationOptions = {},
): Promise<FormPopulationResult> {
  const population_started_at = performance.now();
  options.deepDebug?.record({
    stage: "population",
    substage: "entry",
    operation: "populate-contact-form",
    outcome: "started",
    url: candidate.frame.page().url(),
    frameUrl: candidate.frame.url(),
    data: {
      candidateScore: candidate.score,
      classification: candidate.classification,
      messageDisposition: candidate.messageDisposition,
      source: candidate.source,
      structure: candidate.structure,
    },
  });
  const obstruction_action = await dismiss_cookie_obstruction(
    candidate.frame.page(),
  );
  if (obstruction_action) {
    options.obstructionActions?.push(obstruction_action);
  }
  options.deepDebug?.record({
    stage: "population",
    substage: "obstruction",
    operation: "dismiss-cookie-obstruction",
    outcome: obstruction_action
      ? obstruction_action.result === "clicked" ? "succeeded" : "failed"
      : "skipped",
    data: obstruction_action ?? { reason: "no recognized obstruction" },
  });

  const populated_fields = new Set<PopulatedField>();
  const filled_kinds = new Set<string>();
  const matching_diagnostics: FieldMatchingDiagnostic[] = [];
  const progression_ai_actions: AiActionEvidence[] = [];
  const contact_form_assessment = await assess_contact_form(candidate.form);
  options.deepDebug?.record({
    stage: "population",
    substage: "assessment",
    operation: "assess-selected-form",
    outcome: contact_form_assessment.accepted ? "succeeded" : "blocked",
    data: contact_form_assessment,
  });
  if (
    contact_form_assessment.accepted &&
    contact_form_assessment.classification !== "rejected"
  ) {
    candidate.classification = contact_form_assessment.classification;
    candidate.messageDisposition = contact_form_assessment.messageDisposition;
  }
  const progression_candidate = candidate.classification === "progression";
  const allows_missing_message =
    candidate.classification === "complete" &&
    candidate.messageDisposition === "notOffered";

  const container_population_attempt = await populate_form_like_container_fields(
    candidate,
    contact_request,
    populated_fields,
    filled_kinds,
    options.deepDebug,
  );
  options.deepDebug?.record({
    stage: "population",
    substage: "strategy",
    operation: "form-like-container-population",
    outcome: container_population_attempt.blockingReason
      ? "blocked"
      : container_population_attempt.usedContainerFields
        ? "succeeded"
        : "skipped",
    reason: container_population_attempt.blockingReason,
    data: { populatedFields: ordered_populated_fields(populated_fields) },
  });
  let deterministic_blocking_reason =
    container_population_attempt.blockingReason;

  if (
    deterministic_blocking_reason ||
    !container_population_attempt.usedContainerFields
  ) {
    await populate_generic_fields(
      candidate,
      contact_request,
      populated_fields,
      filled_kinds,
      matching_diagnostics,
      1,
      options.deepDebug,
    );
  }

  if (
    deterministic_blocking_reason ||
    !populated_fields.has("message")
  ) {
    await candidate.frame.page().waitForTimeout(500).catch(() => undefined);
    await populate_generic_fields(
      candidate,
      contact_request,
      populated_fields,
      filled_kinds,
      matching_diagnostics,
      2,
      options.deepDebug,
    );
  }
  deterministic_blocking_reason = unresolved_deterministic_blocker(
    deterministic_blocking_reason,
    populated_fields,
    allows_missing_message,
  );

  if (options.deepDebug) {
    const required_inventory_before =
      await assess_required_control_inventory(candidate.form);
    await options.deepDebug.writeJson(
      "population/required-controls-before-completion.json",
      required_inventory_before,
    );
    options.deepDebug.record({
      stage: "population",
      substage: "required-controls",
      operation: "inventory-active-required-controls",
      outcome:
        required_inventory_before.counts.unsupportedUnsafe > 0
          ? "blocked"
          : "succeeded",
      data: required_inventory_before,
    });
  }
  let unknown_controls_report = await satisfy_undefined_field_fallback(
    candidate.form,
    contact_request,
  );
  if (options.deepDebug) {
    const required_inventory_after =
      await assess_required_control_inventory(candidate.form);
    await options.deepDebug.writeJson(
      "population/required-controls-after-completion.json",
      required_inventory_after,
    );
    options.deepDebug.record({
      stage: "population",
      substage: "required-controls",
      operation: "reconcile-active-required-controls",
      outcome:
        required_inventory_after.counts.activeNative +
            required_inventory_after.counts.activeCustomBacked +
            required_inventory_after.counts.unsupportedUnsafe >
          0
          ? "blocked"
          : "succeeded",
      data: required_inventory_after,
    });
  }
  unknown_controls_report.matchingDiagnostics = matching_diagnostics;
  apply_unknown_control_population(unknown_controls_report, populated_fields);
  await options.deepDebug?.writeJson(
    "population/undefined-fields-initial.json",
    deep_safe_missing_fields_report(unknown_controls_report),
  );
  options.deepDebug?.record({
    stage: "population",
    substage: "undefined-fields",
    operation: "undefined-field-fallback",
    outcome: unknown_controls_report.summary.unhandledRequiredFields > 0
      ? "blocked"
      : "succeeded",
    data: unknown_controls_report,
  });

  let progression_failure_reason: string | undefined;
  if (!populated_fields.has("message") && progression_candidate) {
    const seen_progression_states = new Set<string>();
    for (
      let step = 1;
      step <= MAX_CONTACT_FORM_PROGRESSION_STEPS;
      step += 1
    ) {
      options.deepDebug?.record({
        stage: "population",
        substage: "progression",
        operation: "advance-contact-form-step",
        outcome: "started",
        correlationId: `progression-${step}`,
        data: { step },
      });
      const progression = await advance_contact_form_step({
        candidate,
        ...(options.pageIntelligence
          ? { pageIntelligence: options.pageIntelligence }
          : {}),
        ...(options.ensurePageIntelligence
          ? { ensurePageIntelligence: options.ensurePageIntelligence }
          : {}),
        redactionValues: contact_request_values(contact_request),
        seenStateFingerprints: seen_progression_states,
        ...(options.deepDebug ? { deepDebug: options.deepDebug } : {}),
      });
      progression_ai_actions.push(...progression.aiActions);
      options.deepDebug?.record({
        stage: "population",
        substage: "progression",
        operation: "advance-contact-form-step",
        outcome: progression.progressed ? "succeeded" : "blocked",
        correlationId: `progression-${step}`,
        reason: progression.reason,
        data: {
          step,
          messageAvailable: progression.messageAvailable,
          aiActionCount: progression.aiActions.length,
        },
      });
      if (progression.aiActions.length > 0) {
        options.deepDebug?.recordAiOperations(
          "population",
          `multi-step progression step ${step}`,
          progression.aiActions,
        );
      }
      if (!progression.progressed) {
        progression_failure_reason = progression.reason;
        break;
      }

      await populate_generic_fields(
        candidate,
        contact_request,
        populated_fields,
        filled_kinds,
        matching_diagnostics,
        step + 2,
        options.deepDebug,
      );
      const step_unknown_controls = await satisfy_undefined_field_fallback(
        candidate.form,
        contact_request,
      );
      unknown_controls_report = merge_missing_field_reports(
        unknown_controls_report,
        step_unknown_controls,
      );
      unknown_controls_report.matchingDiagnostics = matching_diagnostics;
      apply_unknown_control_population(
        step_unknown_controls,
        populated_fields,
      );
      if (populated_fields.has("message")) {
        candidate.classification = "complete";
        candidate.messageDisposition = "unresolved";
        break;
      }
    }
    if (!populated_fields.has("message") && !progression_failure_reason) {
      progression_failure_reason =
        "multi-step contact form exhausted the two-step progression limit without revealing a message field";
    }

    if (!populated_fields.has("message") && has_page_intelligence_fallback(options)) {
      const page_intelligence =
        options.pageIntelligence ??
        (await options.ensurePageIntelligence?.().catch(() => undefined));
      if (page_intelligence) {
        const alternative = await find_stagehand_complete_alternative_form({
          candidate,
          pageIntelligence: page_intelligence,
          redactionValues: contact_request_values(contact_request),
        });
        progression_ai_actions.push(...alternative.aiActions);
        if (alternative.found) {
          populated_fields.clear();
          filled_kinds.clear();
          await populate_generic_fields(
            candidate,
            contact_request,
            populated_fields,
            filled_kinds,
          matching_diagnostics,
          MAX_CONTACT_FORM_PROGRESSION_STEPS + 3,
          options.deepDebug,
          );
          const alternative_unknown_controls =
            await satisfy_undefined_field_fallback(
              candidate.form,
              contact_request,
            );
          unknown_controls_report = merge_missing_field_reports(
            unknown_controls_report,
            alternative_unknown_controls,
          );
          unknown_controls_report.matchingDiagnostics = matching_diagnostics;
          apply_unknown_control_population(
            alternative_unknown_controls,
            populated_fields,
          );
          if (populated_fields.has("message")) {
            progression_failure_reason = undefined;
          }
        } else {
          progression_failure_reason = `${progression_failure_reason}; ${alternative.reason}`;
        }
      }
    }
  }

  deterministic_blocking_reason = unresolved_deterministic_blocker(
    deterministic_blocking_reason,
    populated_fields,
  );

  const population_debug = await write_missing_fields_report(
    unknown_controls_report,
    options,
  );

  if (progression_candidate && !populated_fields.has("message")) {
    return {
      populatedFields: ordered_populated_fields(populated_fields),
      messageDisposition: "notOffered",
      blockingReason:
        progression_failure_reason ??
        "multi-step contact form did not reveal a message field",
      failureKind: "population.blocked",
      ...(population_debug ? { debug: population_debug } : {}),
      ...(progression_ai_actions.length > 0
        ? { aiActions: progression_ai_actions }
        : {}),
    };
  }

  const population_blocking_reason =
    deterministic_blocking_reason ??
    (!populated_fields.has("message") && !allows_missing_message
      ? "a message field could not be identified"
      : undefined);
  const message_disposition = current_message_disposition(
    populated_fields,
    allows_missing_message,
  );
  if (!population_blocking_reason) {
    return {
      populatedFields: ordered_populated_fields(populated_fields),
      messageDisposition: message_disposition,
      submissionHandoff: await create_population_submission_handoff(
        candidate,
        contact_request,
        populated_fields,
      ),
      ...(population_debug ? { debug: population_debug } : {}),
      ...(progression_ai_actions.length > 0
        ? { aiActions: progression_ai_actions }
        : {}),
    };
  }

  if (!has_page_intelligence_fallback(options)) {
    return {
      populatedFields: ordered_populated_fields(populated_fields),
      messageDisposition: message_disposition,
      blockingReason: population_blocking_reason,
      failureKind: "population.blocked",
      ...(population_debug ? { debug: population_debug } : {}),
      ...(progression_ai_actions.length > 0
        ? { aiActions: progression_ai_actions }
        : {}),
    };
  }

  const page_intelligence =
    options.pageIntelligence ?? (await options.ensurePageIntelligence?.());
  if (!page_intelligence) {
    return {
      populatedFields: ordered_populated_fields(populated_fields),
      messageDisposition: message_disposition,
      blockingReason: population_blocking_reason,
      failureKind: "population.blocked",
      ...(population_debug ? { debug: population_debug } : {}),
      ...(progression_ai_actions.length > 0
        ? { aiActions: progression_ai_actions }
        : {}),
    };
  }

  const stagehand_fallback =
    await populate_contact_form_with_stagehand_fallback(
      page_intelligence,
      contact_request,
      candidate,
      populated_fields,
      population_blocking_reason,
    );
  options.deepDebug?.recordAiOperations(
    "population",
    population_blocking_reason,
    stagehand_fallback.aiActions,
  );
  options.deepDebug?.record({
    stage: "population",
    substage: "stagehand-fallback",
    operation: "populate-contact-form-with-stagehand",
    outcome: stagehand_fallback.resolved ? "succeeded" : "blocked",
    reason: stagehand_fallback.reason,
    durationMs: performance.now() - population_started_at,
    data: {
      populatedFields: ordered_populated_fields(populated_fields),
      aiActionCount: stagehand_fallback.aiActions.length,
    },
  });

  return {
    populatedFields: ordered_populated_fields(populated_fields),
    messageDisposition: current_message_disposition(
      populated_fields,
      allows_missing_message,
    ),
    ...(stagehand_fallback.resolved
      ? {
          submissionHandoff: await create_population_submission_handoff(
            candidate,
            contact_request,
            populated_fields,
          ),
        }
      : {}),
    ...(stagehand_fallback.resolved
      ? {}
      : {
          blockingReason: `${population_blocking_reason}; Stagehand fallback: ${stagehand_fallback.reason}`,
          failureKind: "population.blocked" as const,
        }),
    ...(population_debug ? { debug: population_debug } : {}),
    ...(progression_ai_actions.length + stagehand_fallback.aiActions.length > 0
      ? {
          aiActions: [
            ...progression_ai_actions,
            ...stagehand_fallback.aiActions,
          ],
        }
      : {}),
  };
}

function has_page_intelligence_fallback(
  options: ContactFormPopulationOptions,
): boolean {
  return Boolean(options.pageIntelligence || options.ensurePageIntelligence);
}

function unresolved_deterministic_blocker(
  reason: string | undefined,
  populated_fields: Set<PopulatedField>,
  allows_missing_message = false,
): string | undefined {
  if (!reason) {
    return undefined;
  }
  const normalized = reason.toLowerCase();
  const required: PopulatedField[] = [];
  if (!allows_missing_message && /message|comment|inquir|enquir/.test(normalized)) {
    required.push("message");
  }
  if (/e-?mail/.test(normalized)) required.push("email");
  if (/phone|mobile|telephone/.test(normalized)) required.push("phone");
  if (
    /name/.test(normalized) &&
    !/company|business|organi[sz]ation|employer/.test(normalized)
  ) {
    required.push("name");
  }
  if (/company|business|organi[sz]ation|employer/.test(normalized)) {
    required.push("company");
  }
  if (/job[ _-]?title|job[ _-]?role|position|designation|occupation/.test(normalized)) {
    required.push("role");
  }
  if (/website|web[ _-]?site|domain|company[ _-]?url/.test(normalized)) {
    required.push("website");
  }
  if (/country|nation/.test(normalized)) required.push("country");
  return required.length > 0 &&
    required.every((field) => populated_fields.has(field))
    ? undefined
    : reason;
}

function contact_request_values(contact_request: ContactRequest): string[] {
  return [
    contact_request.name,
    contact_request.email,
    contact_request.phone,
    contact_request.message,
    contact_request.company,
    contact_request.role,
    contact_request.website,
    contact_request.country,
  ].filter((value): value is string => Boolean(value));
}

function current_message_disposition(
  populated_fields: Set<PopulatedField>,
  allows_missing_message = false,
): MessageDisposition {
  if (populated_fields.has("message")) return "populated";
  return allows_missing_message ? "notOffered" : "unresolved";
}

export async function create_population_submission_handoff(
  candidate: ContactFormCandidate,
  contact_request: ContactRequest,
  populated_fields: Set<PopulatedField>,
): Promise<PopulationSubmissionHandoff> {
  const controls = candidate.form.locator(FILLABLE_CONTACT_CONTROL_SELECTOR);
  const fields: PopulationSubmissionHandoff["fields"] = [];
  const used_kinds = new Set<string>();

  for (let index = 0; index < (await controls.count()); index += 1) {
    const control = controls.nth(index);
    const description = await describe_field(control).catch(() => undefined);
    if (!description) continue;
    const match = match_contact_field(description, used_kinds, contact_request);
    if (!match || !populated_fields.has(match.reportedField)) continue;
    used_kinds.add(match.uniqueKind);
    const actual_value = await control.inputValue().catch(() => "");
    if (!actual_value) continue;
    fields.push({
      field: match.reportedField,
      controlIndex: index,
      metadata: description.metadata,
      expectedValue: actual_value,
    });
  }

  return {
    frameUrl: candidate.frame.url(),
    formFingerprint: await population_form_fingerprint(candidate.form),
    fields,
  };
}

export async function reconcile_population_submission_handoff(
  contact_request: ContactRequest,
  candidate: ContactFormCandidate,
  handoff: PopulationSubmissionHandoff,
  deep_debug?: DeepDebugContext,
  options: { allowRepopulation?: boolean } = {},
): Promise<PopulationHandoffReconciliationResult> {
  const started_at = performance.now();
  const diagnostics: Record<string, unknown> = {
    enteredAt: new Date().toISOString(),
    expectedFrameUrl: handoff.frameUrl,
    actualFrameUrl: candidate.frame.url(),
    frameMatches: candidate.frame.url() === handoff.frameUrl,
    expectedFingerprintLength: handoff.formFingerprint.length,
    fieldCount: handoff.fields.length,
    rebound: false,
    repopulationAttempted: false,
    fields: [],
  };
  const finish = async (
    result: PopulationHandoffReconciliationResult,
  ): Promise<PopulationHandoffReconciliationResult> => {
    const reason = "reason" in result ? result.reason : undefined;
    const document = {
      ...diagnostics,
      finishedAt: new Date().toISOString(),
      durationMs: performance.now() - started_at,
      result: reason ? "failed" : "succeeded",
      reason: reason ?? null,
    };
    await deep_debug?.writeJson("handoff/reconciliation.json", document);
    deep_debug?.record({
      stage: "handoff",
      substage: "reconciliation",
      operation: "population-to-submission-handoff",
      outcome: reason ? "failed" : "succeeded",
      reason,
      durationMs: performance.now() - started_at,
      frameUrl: candidate.frame.url(),
      data: document,
    });
    return result;
  };
  if (candidate.frame.url() !== handoff.frameUrl) {
    return finish({ reason: "the populated form frame changed before submission" });
  }

  let live_candidate = candidate;
  let rebound = false;
  const current_fingerprint = await population_form_fingerprint(
    candidate.form,
  ).catch(() => "");
  diagnostics.currentFingerprintLength = current_fingerprint.length;
  diagnostics.fingerprintMatches = current_fingerprint === handoff.formFingerprint;
  if (current_fingerprint !== handoff.formFingerprint) {
    const forms = candidate.frame.locator("form:visible");
    const form_count = await forms.count();
    diagnostics.visibleFormCountDuringRebind = form_count;
    for (let index = 0; index < form_count; index += 1) {
      const form = forms.nth(index);
      if (
        (await population_form_fingerprint(form).catch(() => "")) ===
        handoff.formFingerprint
      ) {
        live_candidate = { ...candidate, form };
        rebound = true;
        diagnostics.rebound = true;
        diagnostics.reboundFormIndex = index;
        break;
      }
    }
  }

  if (!rebound && current_fingerprint !== handoff.formFingerprint) {
    return finish({ reason: "the populated form could not be re-resolved before submission" });
  }

  const controls = live_candidate.form.locator(FILLABLE_CONTACT_CONTROL_SELECTOR);
  let values_match = true;
  const field_diagnostics: Array<Record<string, unknown>> = [];
  for (const field of handoff.fields) {
    const control = controls.nth(field.controlIndex);
    const metadata = await describe_field(control).catch(() => undefined);
    const value = await control.inputValue().catch(() => "");
    field_diagnostics.push({
      field: field.field,
      controlIndex: field.controlIndex,
      expectedMetadata: field.metadata,
      actualMetadata: metadata?.metadata ?? null,
      metadataMatches: metadata?.metadata === field.metadata,
      valuePresent: value.length > 0,
      valueLength: value.length,
      expectedValueLength: field.expectedValue.length,
      valueMatchesExpected: value === field.expectedValue,
    });
    if (!metadata || metadata.metadata !== field.metadata || value !== field.expectedValue) {
      values_match = false;
      break;
    }
  }
  diagnostics.fields = field_diagnostics;
  diagnostics.valuesMatch = values_match;

  if (values_match) {
    return finish({ candidate: live_candidate, handoff });
  }

  if (options.allowRepopulation === false) {
    return finish({
      reason:
        "the populated form values changed after the single deterministic recovery budget was consumed",
    });
  }

  // One deterministic recovery is allowed. It deliberately omits AI options
  // so a rerender cannot expand the LLM fallback scope during submission.
  diagnostics.repopulationAttempted = true;
  const repopulated = await populate_contact_form(
    contact_request,
    live_candidate,
    deep_debug ? { deepDebug: deep_debug } : {},
  );
  diagnostics.repopulationResult = {
    populatedFields: repopulated.populatedFields,
    messageDisposition: repopulated.messageDisposition,
    blockingReason: repopulated.blockingReason ?? null,
    hasHandoff: Boolean(repopulated.submissionHandoff),
  };
  if (repopulated.blockingReason || !repopulated.submissionHandoff) {
    return finish({
      reason:
        repopulated.blockingReason ??
        "the populated form values could not be restored before submission",
    });
  }
  return finish({
    candidate: live_candidate,
    handoff: repopulated.submissionHandoff,
    populationResult: repopulated,
  });
}

type PopulationHandoffReconciliationResult =
  | {
      candidate: ContactFormCandidate;
      handoff: PopulationSubmissionHandoff;
      populationResult?: FormPopulationResult;
    }
  | { reason: string };

async function population_form_fingerprint(form: import("playwright").Locator): Promise<string> {
  return form.evaluate((element) => {
    const controls = Array.from(
      element.querySelectorAll("input, textarea, select, [contenteditable='true']"),
    ).map((control) =>
      [
        control.tagName.toLowerCase(),
        control.getAttribute("type") ?? "",
        control.getAttribute("name") ?? "",
        (control as HTMLElement).id,
        control.getAttribute("placeholder") ?? "",
        control.getAttribute("aria-label") ?? "",
      ].join("|")
    );
    return [
      element.tagName.toLowerCase(),
      element.id,
      element.getAttribute("name") ?? "",
      element.getAttribute("action") ?? "",
      controls.join(";")
    ].join("::");
  });
}

type MissingFieldsReportDraft = Omit<MissingFieldsReport, "generatedAt">;

function apply_unknown_control_population(
  report: MissingFieldsReportDraft,
  populated_fields: Set<PopulatedField>,
): void {
  if (
    report.summary.dropdownsSelected > 0 ||
    report.summary.checkboxChoicesSelected > 0 ||
    (report.summary.radioChoicesSelected ?? 0) > 0 ||
    (report.summary.customChoicesSelected ?? 0) > 0
  ) {
    populated_fields.add("selection");
  }
  if (
    report.records.some(
      (record) =>
        (record.action === "selectedCheckbox" ||
          record.action === "selectedCustomChoice") &&
        /privacy|terms|consent|agree|data processing/i.test(
          [
            record.name,
            record.id,
            record.ariaLabel,
            record.labelText,
          ].join(" "),
        ),
    )
  ) {
    populated_fields.add("consent");
  }
}

function merge_missing_field_reports(
  current: MissingFieldsReportDraft,
  next: MissingFieldsReportDraft,
): MissingFieldsReportDraft {
  return {
    version: 1,
    summary: {
      reportPath: current.summary.reportPath || next.summary.reportPath,
      unknownTextFieldsFilled:
        current.summary.unknownTextFieldsFilled +
        next.summary.unknownTextFieldsFilled,
      dropdownsSelected:
        current.summary.dropdownsSelected + next.summary.dropdownsSelected,
      checkboxChoicesSelected:
        current.summary.checkboxChoicesSelected +
        next.summary.checkboxChoicesSelected,
      unhandledRequiredFields:
        current.summary.unhandledRequiredFields +
        next.summary.unhandledRequiredFields,
      skippedUnsafeFields:
        current.summary.skippedUnsafeFields +
        next.summary.skippedUnsafeFields,
      radioChoicesSelected:
        (current.summary.radioChoicesSelected ?? 0) +
        (next.summary.radioChoicesSelected ?? 0),
      customChoicesSelected:
        (current.summary.customChoicesSelected ?? 0) +
        (next.summary.customChoicesSelected ?? 0),
      duplicateContactFieldsFilled:
        (current.summary.duplicateContactFieldsFilled ?? 0) +
        (next.summary.duplicateContactFieldsFilled ?? 0),
      inactiveConditionalControls:
        (current.summary.inactiveConditionalControls ?? 0) +
        (next.summary.inactiveConditionalControls ?? 0),
      unresolvedActiveRequiredControls:
        (current.summary.unresolvedActiveRequiredControls ?? 0) +
        (next.summary.unresolvedActiveRequiredControls ?? 0),
    },
    records: [...current.records, ...next.records],
    ...(current.matchingDiagnostics
      ? { matchingDiagnostics: current.matchingDiagnostics }
      : {}),
  };
}

/*
 * ========================================================================
 * STEP_LEVEL_HELPER_FUNCTIONS
 * ========================================================================
 *
 * populate_generic_fields(...) - Fill native forms and structural fallbacks.
 * write_missing_fields_report(...) - Persist fallback population evidence.
 * ordered_populated_fields(...) - Return stable report ordering.
 * ========================================================================
 */

async function populate_generic_fields(
  candidate: ContactFormCandidate,
  contact_request: ContactRequest,
  populated_fields: Set<PopulatedField>,
  filled_kinds: Set<string>,
  matching_diagnostics: FieldMatchingDiagnostic[],
  scan: number,
  deep_debug?: DeepDebugContext,
): Promise<void> {
  const controls = candidate.form.locator(FILLABLE_CONTACT_CONTROL_SELECTOR);
  const control_count = await controls.count();
  deep_debug?.record({
    stage: "population",
    substage: "generic-scan",
    operation: "scan-fillable-controls",
    outcome: "started",
    correlationId: `generic-scan-${scan}`,
    data: { scan, controlCount: control_count },
  });

  for (let index = 0; index < control_count; index += 1) {
    const control = controls.nth(index);
    if (!(await is_usable_control(control))) {
      deep_debug?.record({
        stage: "population",
        substage: "field-match",
        operation: "inspect-control",
        outcome: "skipped",
        correlationId: `scan-${scan}-control-${index}`,
        reason: "control was not visible, enabled, and editable/selectable",
        data: { scan, index },
      });
      continue;
    }

    const description = await describe_field(control);
    const field_match = match_contact_field(
      description,
      filled_kinds,
      contact_request,
    );
    if (!field_match) {
      matching_diagnostics.push({
        scan,
        index,
        ...description,
        result: "unmatched",
        reason: "no unfilled contact-field match was found from DOM metadata",
      });
      deep_debug?.record({
        stage: "population",
        substage: "field-match",
        operation: "match-contact-field",
        outcome: "skipped",
        correlationId: `scan-${scan}-control-${index}`,
        reason: "no unfilled contact-field match was found from DOM metadata",
        data: { scan, index, description },
      });
      continue;
    }

    const filled = await fill_matched_control(
      control,
      field_match,
      index,
      description.metadata,
      populated_fields,
      filled_kinds,
      deep_debug,
    );
    matching_diagnostics.push({
      scan,
      index,
      ...description,
      result: filled ? "matched" : "fillFailed",
      matchedField: field_match.reportedField,
      reason: filled
        ? `matched and filled as ${field_match.reportedField}`
        : `matched as ${field_match.reportedField}, but Playwright fill failed`,
    });
  }
  deep_debug?.record({
    stage: "population",
    substage: "generic-scan",
    operation: "scan-fillable-controls",
    outcome: "succeeded",
    correlationId: `generic-scan-${scan}`,
    data: {
      scan,
      controlCount: control_count,
      populatedFields: ordered_populated_fields(populated_fields),
      filledKinds: [...filled_kinds],
    },
  });
}

function ordered_populated_fields(
  populated_fields: Set<PopulatedField>,
): PopulatedField[] {
  return POPULATED_FIELD_ORDER.filter((field) => populated_fields.has(field));
}

async function write_missing_fields_report(
  report: Omit<MissingFieldsReport, "generatedAt">,
  options: ContactFormPopulationOptions,
): Promise<PopulationDebugSummary | undefined> {
  if (!options.artifactDirectory) {
    return undefined;
  }

  const report_path = join(options.artifactDirectory, "missing-fields.json");
  const absolute_artifact_directory = resolve(options.artifactDirectory);
  const absolute_report_path = join(
    absolute_artifact_directory,
    "missing-fields.json",
  );
  const summary = {
    ...report.summary,
    reportPath: report_path,
  };
  const document: MissingFieldsReport = {
    ...report,
    generatedAt: new Date().toISOString(),
    summary,
  };

  if (options.deepDebug) {
    await options.deepDebug.writeJson(
      "missing-fields.json",
      deep_safe_missing_fields_report(document),
    );
    return summary;
  }

  await mkdir(absolute_artifact_directory, { recursive: true });
  await writeFile(
    absolute_report_path,
    `${JSON.stringify(document, null, 2)}\n`,
    "utf8",
  );

  return summary;
}

function deep_safe_missing_fields_report(
  report: Omit<MissingFieldsReport, "generatedAt"> | MissingFieldsReport,
): unknown {
  return {
    ...report,
    records: report.records.map((record) => {
      const {
        valueBefore,
        valueAfter,
        fillValue,
        selectedOptionValue,
        selectedChoiceValue,
        ...safe_record
      } = record;
      return {
        ...safe_record,
        ...(valueBefore !== undefined
          ? { valueBeforeState: value_state(valueBefore) }
          : {}),
        ...(valueAfter !== undefined
          ? { valueAfterState: value_state(valueAfter) }
          : {}),
        ...(fillValue !== undefined
          ? { fillValueState: value_state(fillValue) }
          : {}),
        ...(selectedOptionValue !== undefined
          ? { selectedOptionValueState: value_state(selectedOptionValue) }
          : {}),
        ...(selectedChoiceValue !== undefined
          ? { selectedChoiceValueState: value_state(selectedChoiceValue) }
          : {}),
      };
    }),
  };
}

function value_state(value: string): { present: boolean; length: number } {
  return { present: value.length > 0, length: value.length };
}
