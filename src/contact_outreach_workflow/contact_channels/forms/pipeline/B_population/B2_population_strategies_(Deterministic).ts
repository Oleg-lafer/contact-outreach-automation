import type { Locator } from "playwright";
import type {
  ContactFormCandidate,
  ContactRequest,
  FieldDescription,
  PopulatedField,
} from "../../shared_files_forms/forms_types_(Support).js";
import type { DeepDebugContext } from "../../shared_files_forms/deep_debug_types_(Support).js";
import {
  FILLABLE_CONTACT_CONTROL_SELECTOR,
  type MatchedContactField,
  describe_form_like_field,
  fill_matched_control,
  is_usable_control,
  match_contact_field,
  contact_field_match,
} from "./B3_population_field_matching_(Deterministic).js";

export interface FormLikeContainerPopulationAttempt {
  usedContainerFields: boolean;
  blockingReason?: string;
}

interface FormLikeControlCandidate {
  control: Locator;
  index: number;
  description: FieldDescription;
}

/*
 * TOP LEVEL WORKFLOW:
 *
 * populate_form_like_container_fields(...)
 *        |
 *        v
 * select strategy-specific controls
 *        |
 *        v
 * map controls to contact values
 *        |
 *        v
 * fill matched controls or report blocking reason
 */

/*
 * ========================================================================
 * TOP_LEVEL_WORKFLOW_FUNCTIONS
 * ========================================================================
 */

/*
 * ========================================================================
 * FORM-LIKE CONTAINER POPULATION - populate_form_like_container_fields(...)
 * ========================================================================
 * Input:  A selected non-native form-like container candidate.
 * Output: Whether container fields were used and any blocking failure.
 *
 * Responsibility: Match contact controls relative to their container and use
 * bounded fallback assignment when metadata is weak.
 * ========================================================================
 */
export async function populate_form_like_container_fields(
  candidate: ContactFormCandidate,
  contact_request: ContactRequest,
  populated_fields: Set<PopulatedField>,
  filled_kinds: Set<string>,
  deep_debug?: DeepDebugContext,
): Promise<FormLikeContainerPopulationAttempt> {
  if (candidate.structure !== "formLikeContainer") {
    return { usedContainerFields: false };
  }

  const controls = await collect_form_like_controls(candidate.form);
  const used_control_indexes = new Set<number>();

  for (const control_candidate of controls) {
    const field_match = match_contact_field(
      control_candidate.description,
      filled_kinds,
      contact_request,
    );
    if (!field_match) {
      continue;
    }

    const filled = await fill_matched_control(
      control_candidate.control,
      field_match,
      control_candidate.index,
      control_candidate.description.metadata,
      populated_fields,
      filled_kinds,
      deep_debug,
    );
    if (!filled) {
      return {
        usedContainerFields: true,
        blockingReason: `form-like container field could not be filled: ${field_match.reportedField}`,
      };
    }
    used_control_indexes.add(control_candidate.index);
  }

  const fallback_attempt = await fill_form_like_fallback_fields(
    controls,
    used_control_indexes,
    contact_request,
    populated_fields,
    filled_kinds,
    deep_debug,
  );
  if (fallback_attempt.blockingReason) {
    return fallback_attempt;
  }

  return { usedContainerFields: controls.length > 0 };
}

/*
 * ========================================================================
 * STEP_LEVEL_HELPER_FUNCTIONS
 * ========================================================================
 *
 * collect_form_like_controls(...)       - Read controls with nearby text.
 * fill_form_like_fallback_fields(...)   - Assign weak fields by position.
 * fill_form_like_fallback_control(...)  - Fill one fallback-selected control.
 * unfilled_input_controls(...)        - Select unused input controls.
 * ========================================================================
 */

async function collect_form_like_controls(
  container: Locator,
): Promise<FormLikeControlCandidate[]> {
  const controls = container.locator(FILLABLE_CONTACT_CONTROL_SELECTOR);
  const candidates: FormLikeControlCandidate[] = [];

  for (let index = 0; index < (await controls.count()); index += 1) {
    const control = controls.nth(index);
    if (!(await is_usable_control(control))) {
      continue;
    }

    candidates.push({
      control,
      index,
      description: await describe_form_like_field(control),
    });
  }

  return candidates;
}

async function fill_form_like_fallback_fields(
  controls: FormLikeControlCandidate[],
  used_control_indexes: Set<number>,
  contact_request: ContactRequest,
  populated_fields: Set<PopulatedField>,
  filled_kinds: Set<string>,
  deep_debug?: DeepDebugContext,
): Promise<FormLikeContainerPopulationAttempt> {
  if (!filled_kinds.has("fullName") && !filled_kinds.has("firstName")) {
    const input_controls = unfilled_input_controls(controls, used_control_indexes);
    const name_control =
      input_controls.find((candidate) =>
        /first[ _-]?name|full[ _-]?name|(^|\s)name(\s|$)/.test(
          candidate.description.metadata,
        ),
      ) ?? input_controls[0];
    if (name_control) {
      const filled = await fill_form_like_fallback_control(
        name_control,
        contact_field_match("name", contact_request),
        used_control_indexes,
        populated_fields,
        filled_kinds,
        deep_debug,
      );
      if (!filled) {
        return {
          usedContainerFields: true,
          blockingReason: "form-like container name field could not be filled",
        };
      }
    }
  }

  if (!filled_kinds.has("email")) {
    const input_controls = unfilled_input_controls(controls, used_control_indexes);
    const email_control =
      input_controls.find((candidate) => /e-?mail/.test(candidate.description.metadata)) ??
      input_controls[0];
    if (email_control) {
      const filled = await fill_form_like_fallback_control(
        email_control,
        contact_field_match("email", contact_request),
        used_control_indexes,
        populated_fields,
        filled_kinds,
        deep_debug,
      );
      if (!filled) {
        return {
          usedContainerFields: true,
          blockingReason: "form-like container email field could not be filled",
        };
      }
    }
  }

  if (!populated_fields.has("message")) {
    const message_control = controls.find(
      (candidate) =>
        !used_control_indexes.has(candidate.index) &&
        candidate.description.tag === "textarea",
    );
    if (message_control) {
      const filled = await fill_form_like_fallback_control(
        message_control,
        contact_field_match("message", contact_request),
        used_control_indexes,
        populated_fields,
        filled_kinds,
        deep_debug,
      );
      if (!filled) {
        return {
          usedContainerFields: true,
          blockingReason: "form-like container message field could not be filled",
        };
      }
    }
  }

  return { usedContainerFields: true };
}

function unfilled_input_controls(
  controls: FormLikeControlCandidate[],
  used_control_indexes: Set<number>,
): FormLikeControlCandidate[] {
  return controls.filter(
    (candidate) =>
      !used_control_indexes.has(candidate.index) &&
      candidate.description.tag === "input",
  );
}

async function fill_form_like_fallback_control(
  control_candidate: FormLikeControlCandidate,
  field_match: MatchedContactField,
  used_control_indexes: Set<number>,
  populated_fields: Set<PopulatedField>,
  filled_kinds: Set<string>,
  deep_debug?: DeepDebugContext,
): Promise<boolean> {
  const filled = await fill_matched_control(
    control_candidate.control,
    field_match,
    control_candidate.index,
    `form-like container fallback: ${control_candidate.description.metadata}`,
    populated_fields,
    filled_kinds,
    deep_debug,
  );
  if (filled) {
    used_control_indexes.add(control_candidate.index);
  }
  return filled;
}
