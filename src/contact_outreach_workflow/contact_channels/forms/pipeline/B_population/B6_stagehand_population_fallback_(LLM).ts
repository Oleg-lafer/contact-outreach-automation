import type { Locator } from "playwright";
import {
  AI_ACTION_TIMEOUT_MS,
  AI_OBSERVE_TIMEOUT_MS,
  MAX_AI_POPULATION_ACTIONS,
} from "../../../../shared_files_orchestrator/outreach_constants_(Support).js";
import { describe_error } from "../../../../shared_files_orchestrator/outreach_errors_(Support).js";
import { create_ai_operation_evidence } from "../../../../shared_files_orchestrator/ai_observability_(Support).js";
import {
  CAPTCHA_SELECTOR,
  selector_targets_captcha,
} from "../../shared_files_forms/captcha_detection_(Deterministic).js";
import type {
  AiActionEvidence,
  ContactFormCandidate,
  ContactRequest,
  PopulatedField,
} from "../../shared_files_forms/forms_types_(Support).js";
import type {
  PageIntelligence,
  PageIntelligenceAction,
  PageIntelligenceObserveResult,
  PageIntelligenceVariableName,
  PageIntelligenceVariables,
} from "../../../../shared_files_orchestrator/page_intelligence_(Integration).js";
import {
  create_page_intelligence_scope,
  with_masked_page_values,
} from "../../../../shared_files_orchestrator/page_value_redaction_(Integration).js";

type ContactPopulationField = Extract<
  PopulatedField,
  | "name"
  | "email"
  | "phone"
  | "message"
  | "company"
  | "role"
  | "website"
  | "country"
>;

interface PopulationTarget {
  field: ContactPopulationField;
  variable: PageIntelligenceVariableName;
  value: string;
}

interface AcceptedPopulationAction {
  accepted: true;
  locator: Locator;
}

interface RejectedPopulationAction {
  accepted: false;
  reason: string;
  containsContactValue: boolean;
}

type PopulationActionValidation =
  | AcceptedPopulationAction
  | RejectedPopulationAction;

export interface StagehandPopulationFallbackResult {
  resolved: boolean;
  reason: string;
  aiActions: AiActionEvidence[];
}

/*
 * Population fallback is intentionally narrower than a general browser agent:
 * it can fill only a known contact-data placeholder into an editable control
 * inside the already-selected form. It cannot choose domain answers, consent,
 * CAPTCHA, files, dates, numbers, URLs, radios, checkboxes, or dropdown values.
 */
export async function populate_contact_form_with_stagehand_fallback(
  page_intelligence: PageIntelligence,
  contact_request: ContactRequest,
  candidate: ContactFormCandidate,
  populated_fields: Set<PopulatedField>,
  original_blocking_reason: string,
): Promise<StagehandPopulationFallbackResult> {
  let scope;
  try {
    scope = await create_page_intelligence_scope(candidate.form);
  } catch (error) {
    return {
      resolved: false,
      reason: `could not create a safe form scope: ${redact_contact_values(
        describe_error(error),
        contact_request,
      )}`,
      aiActions: [],
    };
  }
  try {
    return await run_stagehand_population_fallback(
      page_intelligence,
      contact_request,
      candidate,
      populated_fields,
      original_blocking_reason,
      scope.selector,
    );
  } finally {
    await scope.close();
  }
}

async function run_stagehand_population_fallback(
  page_intelligence: PageIntelligence,
  contact_request: ContactRequest,
  candidate: ContactFormCandidate,
  populated_fields: Set<PopulatedField>,
  original_blocking_reason: string,
  scope_selector: string,
): Promise<StagehandPopulationFallbackResult> {
  const ai_actions: AiActionEvidence[] = [];
  const failure_reasons: string[] = [];
  const used_selectors = new Set<string>();
  const variables: PageIntelligenceVariables = {
    name: contact_request.name,
    email: contact_request.email,
    phone: contact_request.phone,
    message: contact_request.message,
    ...(contact_request.company ? { company: contact_request.company } : {}),
    ...(contact_request.role ? { role: contact_request.role } : {}),
    ...(contact_request.website ? { website: contact_request.website } : {}),
    ...(contact_request.country ? { country: contact_request.country } : {}),
  };

  await recheck_known_contact_values(
    candidate.form,
    contact_request,
    populated_fields,
  );

  const targets = unresolved_population_targets(
    contact_request,
    populated_fields,
    candidate.messageDisposition === "notOffered",
  );
  let executed_action_count = 0;

  for (const target of targets) {
    if (executed_action_count >= MAX_AI_POPULATION_ACTIONS) {
      failure_reasons.push("the ten-action population limit was reached");
      break;
    }

    const instruction = population_instruction(target);
    let observation: PageIntelligenceObserveResult;
    const observation_started_at = Date.now();
    try {
      observation = await observe_with_masked_contact_values(
        page_intelligence,
        candidate,
        contact_request,
        variables,
        instruction,
        scope_selector,
      );
    } catch (error) {
      ai_actions.push(
        create_ai_operation_evidence({
          stage: "population",
          placeholderInstruction: instruction,
          method: "observe",
          model: page_intelligence.model,
          durationMs: Date.now() - observation_started_at,
          acceptanceReason: `${target.field} observation failed`,
          result: "failed",
        }),
      );
      failure_reasons.push(
        `${target.field} observation failed: ${redact_contact_values(
          describe_error(error),
          contact_request,
        )}`,
      );
      continue;
    }

    if (observation.actions.length === 0) {
      ai_actions.push(
        create_ai_operation_evidence({
          stage: "population",
          placeholderInstruction: instruction,
          method: "observe",
          model: observation.model,
          durationMs: observation.durationMs,
          acceptanceReason: `${target.field} observation returned no candidate action`,
          result: "observed",
        }),
      );
      failure_reasons.push(
        `${target.field} observation returned no candidate action`,
      );
      continue;
    }

    let accepted_action:
      | {
          action: PageIntelligenceAction;
          locator: Locator;
          evidenceIndex: number;
        }
      | undefined;

    for (const action of observation.actions) {
      const validation = await validate_population_action(
        action,
        target,
        candidate,
        contact_request,
        used_selectors,
      );
      if (!validation.accepted) {
        ai_actions.push(
          population_evidence(
            action,
            instruction,
            observation,
            "rejected",
            validation.reason,
            "notRun",
            validation.containsContactValue,
          ),
        );
        continue;
      }

      const evidence_index = ai_actions.push(
        population_evidence(
          action,
          instruction,
          observation,
          "accepted",
          "approved placeholder fill inside the selected form",
          "observed",
          false,
        ),
      ) - 1;
      accepted_action = {
        action,
        locator: validation.locator,
        evidenceIndex: evidence_index,
      };
      break;
    }

    if (!accepted_action) {
      failure_reasons.push(
        `${target.field} observation returned no policy-compliant fill action`,
      );
      continue;
    }

    used_selectors.add(accepted_action.action.selector);
    executed_action_count += 1;

    try {
      const act_result = await page_intelligence.act({
        stage: "population",
        page: candidate.frame.page(),
        instruction,
        action: accepted_action.action,
        variables,
        timeoutMs: AI_ACTION_TIMEOUT_MS,
      });
      const verified =
        act_result.success &&
        (await verify_population_action(
          accepted_action.locator,
          target.value,
        ));

      ai_actions[accepted_action.evidenceIndex] = {
        ...ai_actions[accepted_action.evidenceIndex]!,
        result: verified ? "succeeded" : "failed",
        resultMessage: verified
          ? "placeholder fill completed and passed deterministic value validation"
          : "placeholder fill did not pass deterministic value validation",
        model: act_result.model,
        durationMs:
          ai_actions[accepted_action.evidenceIndex]!.durationMs +
          act_result.durationMs,
      };

      if (verified) {
        populated_fields.add(target.field);
      } else {
        failure_reasons.push(
          `${target.field} action did not pass deterministic value validation`,
        );
      }
    } catch (error) {
      ai_actions[accepted_action.evidenceIndex] = {
        ...ai_actions[accepted_action.evidenceIndex]!,
        result: "failed",
        resultMessage: "validated placeholder fill raised an error",
      };
      failure_reasons.push(
        `${target.field} action failed: ${redact_contact_values(
          describe_error(error),
          contact_request,
        )}`,
      );
    }

  }

  await recheck_known_contact_values(
    candidate.form,
    contact_request,
    populated_fields,
  );

  const required_fields = blocking_reason_fields(original_blocking_reason);
  const unresolved_required_fields = required_fields.filter(
    (field) => !populated_fields.has(field),
  );
  if (unresolved_required_fields.length > 0) {
    failure_reasons.unshift(
      `required ${unresolved_required_fields.join(", ")} field remains unresolved`,
    );
  }

  const browser_valid = await selected_form_is_browser_valid(candidate.form);
  if (!browser_valid) {
    failure_reasons.push("the selected form still fails browser validity checks");
  }

  const resolved =
    unresolved_required_fields.length === 0 && browser_valid;
  return {
    resolved,
    reason: resolved
      ? "resolved the deterministic population blocker and passed value and validity checks"
      : concise_failure_reason(failure_reasons),
    aiActions: ai_actions,
  };
}

function unresolved_population_targets(
  contact_request: ContactRequest,
  populated_fields: Set<PopulatedField>,
  message_not_offered: boolean,
): PopulationTarget[] {
  const targets: PopulationTarget[] = [
    {
      field: "message",
      variable: "message",
      value: contact_request.message,
    },
    { field: "email", variable: "email", value: contact_request.email },
    { field: "name", variable: "name", value: contact_request.name },
    { field: "phone", variable: "phone", value: contact_request.phone },
    ...(contact_request.company
      ? [{ field: "company", variable: "company", value: contact_request.company } as const]
      : []),
    ...(contact_request.role
      ? [{ field: "role", variable: "role", value: contact_request.role } as const]
      : []),
    ...(contact_request.website
      ? [{ field: "website", variable: "website", value: contact_request.website } as const]
      : []),
    ...(contact_request.country
      ? [{ field: "country", variable: "country", value: contact_request.country } as const]
      : []),
  ];
  return targets.filter(
    (target) =>
      !populated_fields.has(target.field) &&
      !(message_not_offered && target.field === "message"),
  );
}

function population_instruction(target: PopulationTarget): string {
  return [
    `Locate the one visible editable control inside the selected contact form that requests the contact ${target.field}.`,
    `Return one fill action whose only argument is exactly %${target.variable}%.`,
    "Do not return or repeat the variable value itself.",
    "Do not choose dropdown, radio, checkbox, consent, budget, legal, CAPTCHA, file, date, number, or any value other than the required placeholder.",
    "Do not click submit or any other control.",
  ].join(" ");
}

async function validate_population_action(
  action: PageIntelligenceAction,
  target: PopulationTarget,
  candidate: ContactFormCandidate,
  contact_request: ContactRequest,
  used_selectors: Set<string>,
): Promise<PopulationActionValidation> {
  const contains_contact_value = action_contains_contact_value(
    action,
    contact_request,
  );
  if (contains_contact_value) {
    return {
      accepted: false,
      reason: "action exposed a literal contact value instead of a placeholder",
      containsContactValue: true,
    };
  }
  if (action.method.trim().toLowerCase() !== "fill") {
    return {
      accepted: false,
      reason: "only fill actions are allowed during population fallback",
      containsContactValue: false,
    };
  }
  if (!action.selector.trim()) {
    return {
      accepted: false,
      reason: "the observed fill action had no selector",
      containsContactValue: false,
    };
  }
  if (
    await selector_targets_captcha(
      candidate.frame.page(),
      action.selector.trim(),
    )
  ) {
    return {
      accepted: false,
      reason: "the observed selector targeted a CAPTCHA control",
      containsContactValue: false,
    };
  }
  if (used_selectors.has(action.selector)) {
    return {
      accepted: false,
      reason: "the selector was already used for another contact field",
      containsContactValue: false,
    };
  }

  const expected_argument = `%${target.variable}%`;
  if (
    action.arguments?.length !== 1 ||
    action.arguments[0] !== expected_argument
  ) {
    return {
      accepted: false,
      reason: `fill action must use only the ${expected_argument} placeholder`,
      containsContactValue: false,
    };
  }

  const locator = await first_safe_population_locator(
    candidate,
    action.selector,
    target,
  );
  return locator
    ? { accepted: true, locator }
    : {
        accepted: false,
        reason:
          "selector did not resolve to a safe editable control inside the selected form",
        containsContactValue: false,
      };
}

async function first_safe_population_locator(
  candidate: ContactFormCandidate,
  selector: string,
  target: PopulationTarget,
): Promise<Locator | undefined> {
  let candidates: Locator;
  try {
    candidates = candidate.frame.locator(selector);
  } catch {
    return undefined;
  }

  let count = 0;
  try {
    count = Math.min(await candidates.count(), 10);
  } catch {
    return undefined;
  }

  for (let index = 0; index < count; index += 1) {
    const locator = candidates.nth(index);
    const usable =
      (await locator.isVisible().catch(() => false)) &&
      (await locator.isEnabled().catch(() => false)) &&
      (await locator.isEditable().catch(() => false)) &&
      (await locator_is_inside_form(candidate.form, locator));
    if (!usable) {
      continue;
    }

    const state = await locator
      .evaluate((element) => {
        const html_element = element as HTMLElement;
        const input = element as HTMLInputElement;
        const labels = Array.from(input.labels ?? []).map(
          (label) => label.textContent ?? "",
        );
        return {
          tag: element.tagName.toLowerCase(),
          type: input.getAttribute("type")?.toLowerCase() ?? "",
          contentEditable: html_element.isContentEditable,
          metadata: [
            input.getAttribute("name"),
            html_element.id,
            input.getAttribute("placeholder"),
            html_element.getAttribute("aria-label"),
            ...labels,
          ]
            .filter(Boolean)
            .join(" ")
            .toLowerCase(),
          value:
            element.tagName.toLowerCase() === "input" ||
            element.tagName.toLowerCase() === "textarea"
              ? input.value
              : html_element.textContent ?? "",
        };
      })
      .catch(() => undefined);
    if (!state) {
      continue;
    }

    const is_text_input =
      state.tag === "input" &&
      ["", "text", "email", "tel", "url", "search"].includes(state.type);
    const is_textarea = state.tag === "textarea";
    const allowed_structure =
      target.field === "message"
        ? is_textarea || is_text_input || state.contentEditable
        : !is_textarea && (is_text_input || state.contentEditable);
    if (!allowed_structure) {
      continue;
    }
    if (has_conflicting_contact_semantics(target.field, state)) {
      continue;
    }
    if (
      target.field === "email" &&
      (state.type === "tel" || state.type === "search")
    ) {
      continue;
    }
    if (
      target.field === "phone" &&
      (state.type === "email" || state.type === "search")
    ) {
      continue;
    }
    if (
      target.field === "message" &&
      (state.type === "email" ||
        state.type === "tel" ||
        state.type === "search")
    ) {
      continue;
    }
    if (
      target.field === "name" &&
      (state.type === "email" ||
        state.type === "tel" ||
        state.type === "search")
    ) {
      continue;
    }
    if (
      ["company", "role", "country"].includes(target.field) &&
      ["email", "tel", "url", "search"].includes(state.type)
    ) {
      continue;
    }
    if (
      target.field === "website" &&
      ["email", "tel", "search"].includes(state.type)
    ) {
      continue;
    }

    const current_value = state.value.trim();
    if (
      current_value &&
      current_value !== "Hello" &&
      current_value !== target.value
    ) {
      continue;
    }

    return locator;
  }

  return undefined;
}

function has_conflicting_contact_semantics(
  target: ContactPopulationField,
  state: { tag: string; type: string; metadata: string },
): boolean {
  const detected_fields = new Set<ContactPopulationField>();
  if (state.type === "email" || /e-?mail/.test(state.metadata)) {
    detected_fields.add("email");
  }
  if (state.type === "tel" || /phone|mobile|telephone/.test(state.metadata)) {
    detected_fields.add("phone");
  }
  if (
    state.tag === "textarea" ||
    /message|comment|inquiry|enquiry|details|description/.test(state.metadata)
  ) {
    detected_fields.add("message");
  }
  if (
    /(^|\s)(?:full[ _-]?)?(?:your[ _-]?)?name(\s|$)|first[ _-]?name|last[ _-]?name|surname/.test(
      state.metadata,
    ) &&
    !/user[ _-]?name|company|business|organi[sz]ation/.test(state.metadata)
  ) {
    detected_fields.add("name");
  }
  if (/company|business[ _-]?name|organi[sz]ation|employer/.test(state.metadata)) {
    detected_fields.add("company");
  }
  if (/job[ _-]?title|job[ _-]?role|position|designation|occupation|(^|\s)role(\s|$)/.test(state.metadata)) {
    detected_fields.add("role");
  }
  if (state.type === "url" || /web[ _-]?site|company[ _-]?url|business[ _-]?url|domain/.test(state.metadata)) {
    detected_fields.add("website");
  }
  if (/country|nation|country[ _-]?region/.test(state.metadata)) {
    detected_fields.add("country");
  }

  return detected_fields.size > 0 && !detected_fields.has(target);
}

async function locator_is_inside_form(
  form: Locator,
  control: Locator,
): Promise<boolean> {
  const form_handle = await form.elementHandle().catch(() => null);
  const control_handle = await control.elementHandle().catch(() => null);
  if (!form_handle || !control_handle) {
    await form_handle?.dispose().catch(() => undefined);
    await control_handle?.dispose().catch(() => undefined);
    return false;
  }

  try {
    return await form_handle.evaluate(
      (root, target) => root === target || root.contains(target),
      control_handle,
    );
  } catch {
    return false;
  } finally {
    await form_handle.dispose().catch(() => undefined);
    await control_handle.dispose().catch(() => undefined);
  }
}

async function verify_population_action(
  locator: Locator,
  expected_value: string,
): Promise<boolean> {
  return locator
    .evaluate((element, expected) => {
      const html_element = element as HTMLElement;
      const input = element as HTMLInputElement;
      const actual =
        element.tagName.toLowerCase() === "input" ||
        element.tagName.toLowerCase() === "textarea"
          ? input.value
          : html_element.textContent ?? "";
      const valid = "validity" in input ? input.validity.valid : true;
      return actual === expected && valid;
    }, expected_value)
    .catch(() => false);
}

async function recheck_known_contact_values(
  form: Locator,
  contact_request: ContactRequest,
  populated_fields: Set<PopulatedField>,
): Promise<void> {
  const values = await form
    .locator('input:not([type="hidden"]), textarea, [contenteditable="true"]')
    .evaluateAll((elements) =>
      elements.map((element) => {
        const html_element = element as HTMLElement;
        const input = element as HTMLInputElement;
        return element.tagName.toLowerCase() === "input" ||
          element.tagName.toLowerCase() === "textarea"
          ? input.value
          : html_element.textContent ?? "";
      }),
    )
    .catch(() => [] as string[]);

  const expected: Array<[ContactPopulationField, string]> = [
    ["name", contact_request.name],
    ["email", contact_request.email],
    ["phone", contact_request.phone],
    ["message", contact_request.message],
    ...(contact_request.company
      ? [["company", contact_request.company] as [ContactPopulationField, string]]
      : []),
    ...(contact_request.role
      ? [["role", contact_request.role] as [ContactPopulationField, string]]
      : []),
    ...(contact_request.website
      ? [["website", contact_request.website] as [ContactPopulationField, string]]
      : []),
    ...(contact_request.country
      ? [["country", contact_request.country] as [ContactPopulationField, string]]
      : []),
  ];
  for (const [field, value] of expected) {
    if (values.includes(value)) {
      populated_fields.add(field);
    }
  }
}

async function selected_form_is_browser_valid(form: Locator): Promise<boolean> {
  return form
    .locator("input, textarea, select")
    .evaluateAll((controls) =>
      controls.every((control) => {
        const field = control as
          | HTMLInputElement
          | HTMLTextAreaElement
          | HTMLSelectElement;
        return !field.willValidate || field.validity.valid;
      }),
    )
    .catch(() => false);
}

async function observe_with_masked_contact_values(
  page_intelligence: PageIntelligence,
  candidate: ContactFormCandidate,
  contact_request: ContactRequest,
  variables: PageIntelligenceVariables,
  instruction: string,
  scope_selector: string,
): Promise<PageIntelligenceObserveResult> {
  return with_masked_page_values(
    candidate.frame.page(),
    contact_values(contact_request),
    () =>
      page_intelligence.observe({
        stage: "population",
        page: candidate.frame.page(),
        instruction,
        variables,
        selector: scope_selector,
        ignoreSelectors: [CAPTCHA_SELECTOR],
        timeoutMs: AI_OBSERVE_TIMEOUT_MS,
      }),
  );
}

function blocking_reason_fields(
  blocking_reason: string,
): ContactPopulationField[] {
  const normalized = blocking_reason.toLowerCase();
  const fields: ContactPopulationField[] = [];
  if (/message|comment|inquiry|enquiry/.test(normalized)) fields.push("message");
  if (/e-?mail/.test(normalized)) fields.push("email");
  if (/phone|mobile|telephone/.test(normalized)) fields.push("phone");
  if (
    /name/.test(normalized) &&
    !/company|business|organi[sz]ation|employer/.test(normalized)
  ) {
    fields.push("name");
  }
  if (/company|business|organi[sz]ation|employer/.test(normalized)) {
    fields.push("company");
  }
  if (/job[ _-]?title|job[ _-]?role|position|designation|occupation/.test(normalized)) {
    fields.push("role");
  }
  if (/website|web[ _-]?site|domain|company[ _-]?url/.test(normalized)) {
    fields.push("website");
  }
  if (/country|nation/.test(normalized)) fields.push("country");
  return fields.length > 0 ? fields : ["message"];
}

function action_contains_contact_value(
  action: PageIntelligenceAction,
  contact_request: ContactRequest,
): boolean {
  const searchable = [
    action.instruction,
    action.selector,
    action.method,
    ...(action.arguments ?? []),
  ].join("\n");
  return contact_values(contact_request).some((value) => searchable.includes(value));
}

function redact_contact_values(
  value: string,
  contact_request: ContactRequest,
): string {
  return contact_values(contact_request).reduce(
    (redacted, contact_value) => redacted.split(contact_value).join("[redacted]"),
    value,
  );
}

function contact_values(contact_request: ContactRequest): string[] {
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

function population_evidence(
  action: PageIntelligenceAction,
  placeholder_instruction: string,
  observation: PageIntelligenceObserveResult,
  acceptance: "accepted" | "rejected",
  acceptance_reason: string,
  result: "observed" | "notRun",
  redact_action: boolean,
): AiActionEvidence {
  return {
    stage: "population",
    placeholderInstruction: placeholder_instruction,
    selector: redact_action ? "[redacted unsafe selector]" : action.selector,
    method: redact_action ? "[redacted unsafe method]" : action.method,
    acceptance,
    acceptanceReason: acceptance_reason,
    result,
    model: observation.model,
    durationMs: observation.durationMs,
  };
}

function concise_failure_reason(reasons: string[]): string {
  const unique_reasons = [...new Set(reasons.filter(Boolean))];
  return unique_reasons.length > 0
    ? unique_reasons.slice(0, 3).join("; ")
    : "no policy-compliant contact-field action resolved the blocker";
}
