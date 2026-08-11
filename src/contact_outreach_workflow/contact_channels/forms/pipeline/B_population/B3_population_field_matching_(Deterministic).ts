import type { Locator } from "playwright";
import type {
  ContactFieldKind,
  ContactRequest,
  FieldDescription,
  PopulatedField,
} from "../../shared_files_forms/forms_types_(Support).js";
import type { DeepDebugContext } from "../../shared_files_forms/deep_debug_types_(Support).js";

export const FILLABLE_CONTACT_CONTROL_SELECTOR =
  'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="checkbox"]):not([type="radio"]), textarea, select';

export interface MatchedContactField {
  value: string;
  uniqueKind: string;
  reportedField: PopulatedField;
}

/*
 * TOP LEVEL WORKFLOW:
 *
 * describe_field(control)
 *        |
 *        v
 * match_contact_field(description, filled_kinds, contact_request)
 *        |
 *        v
 * fill_matched_control(control, field_match, ...)
 */

/*
 * ========================================================================
 * TOP_LEVEL_WORKFLOW_FUNCTIONS
 * ========================================================================
 */

/*
 * ========================================================================
 * FIELD DESCRIPTION - describe_field(...)
 * ========================================================================
 * Input:  A fillable input or textarea locator.
 * Output: Normalized tag, type, and human-readable metadata.
 *
 * Responsibility: Convert a DOM control into metadata that field matching can
 * reason about without knowing page-specific selectors.
 * ========================================================================
 */
export async function describe_field(control: Locator): Promise<FieldDescription> {
  return control.evaluate<FieldDescription>((element) => {
    const field = element as HTMLInputElement | HTMLTextAreaElement;
    const labels = Array.from(field.labels ?? []).map(
      (label) => label.textContent ?? "",
    );
    return {
      tag: field.tagName.toLowerCase(),
      type: field.getAttribute("type")?.toLowerCase() ?? "",
      metadata: [
        field.getAttribute("name"),
        field.id,
        field.getAttribute("placeholder"),
        field.getAttribute("aria-label"),
        field.getAttribute("autocomplete"),
        ...labels,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase(),
    };
  });
}

/*
 * ========================================================================
 * FORM-LIKE FIELD DESCRIPTION - describe_form_like_field(...)
 * ========================================================================
 * Input:  A fillable control from a non-native form-like container.
 * Output: Normalized control metadata including nearby text.
 *
 * Responsibility: Broaden field evidence for form-like containers where
 * labels are often nearby text instead of formal label elements.
 * ========================================================================
 */
export async function describe_form_like_field(
  control: Locator,
): Promise<FieldDescription> {
  return control.evaluate<FieldDescription>((element) => {
    const field = element as HTMLInputElement | HTMLTextAreaElement;
    const labels = Array.from(field.labels ?? []).map(
      (label) => label.textContent ?? "",
    );
    const nearby_text = [
      field.closest("label")?.textContent,
      field.parentElement?.textContent,
      field.parentElement?.previousElementSibling?.textContent,
      field.previousElementSibling?.textContent,
      field.nextElementSibling?.textContent,
    ];

    return {
      tag: field.tagName.toLowerCase(),
      type: field.getAttribute("type")?.toLowerCase() ?? "",
      metadata: [
        field.getAttribute("name"),
        field.id,
        field.getAttribute("placeholder"),
        field.getAttribute("aria-label"),
        field.getAttribute("autocomplete"),
        ...labels,
        ...nearby_text,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase(),
    };
  });
}

/*
 * ========================================================================
 * CONTACT FIELD MATCHING - match_contact_field(...)
 * ========================================================================
 * Input:  Field metadata, already-filled unique kinds, and contact values.
 * Output: The value/kind/reporting field to fill, or undefined.
 *
 * Responsibility: Map page-specific field language to stable contact data
 * without filling the same unique field twice.
 * ========================================================================
 */
export function match_contact_field(
  field: FieldDescription,
  filled_kinds: Set<string>,
  contact_request: ContactRequest,
): MatchedContactField | undefined {
  const metadata = field.metadata;

  if (
    (field.type === "email" || /e-?mail/.test(metadata)) &&
    !filled_kinds.has("email")
  ) {
    return {
      value: contact_request.email,
      uniqueKind: "email",
      reportedField: "email",
    };
  }

  if (
    (field.type === "tel" || /phone|mobile|telephone/.test(metadata)) &&
    !filled_kinds.has("phone")
  ) {
    return {
      value: contact_request.phone,
      uniqueKind: "phone",
      reportedField: "phone",
    };
  }

  if (
    contact_request.company &&
    /company|organisation|organization|employer|business[ _-]?name|agency[ _-]?name/.test(
      metadata,
    ) &&
    !filled_kinds.has("company")
  ) {
    return {
      value: contact_request.company,
      uniqueKind: "company",
      reportedField: "company",
    };
  }

  if (
    contact_request.role &&
    /job[ _-]?title|job[ _-]?role|professional[ _-]?role|position|designation|occupation|(^|\s)role(\s|$)/.test(
      metadata,
    ) &&
    !filled_kinds.has("role")
  ) {
    return {
      value: contact_request.role,
      uniqueKind: "role",
      reportedField: "role",
    };
  }

  if (
    contact_request.website &&
    (field.type === "url" ||
      /web[ _-]?site|company[ _-]?url|business[ _-]?url|web[ _-]?address|domain/.test(
        metadata,
      )) &&
    !filled_kinds.has("website")
  ) {
    return {
      value: contact_request.website,
      uniqueKind: "website",
      reportedField: "website",
    };
  }

  if (
    contact_request.country &&
    /country|nation|country[ _-]?region/.test(metadata) &&
    !filled_kinds.has("country")
  ) {
    return {
      value: contact_request.country,
      uniqueKind: "country",
      reportedField: "country",
    };
  }

  if (
    (field.tag === "textarea" ||
      /message|comment|inquiry|enquiry|details|description/.test(metadata)) &&
    !filled_kinds.has("message")
  ) {
    return {
      value: contact_request.message,
      uniqueKind: "message",
      reportedField: "message",
    };
  }

  if (
    /first[ _-]?name|given[ _-]?name/.test(metadata) &&
    !filled_kinds.has("firstName")
  ) {
    return {
      value: first_contact_name(contact_request.name),
      uniqueKind: "firstName",
      reportedField: "name",
    };
  }

  if (
    /last[ _-]?name|family[ _-]?name|surname/.test(metadata) &&
    !filled_kinds.has("lastName")
  ) {
    return {
      value: last_contact_name(contact_request.name),
      uniqueKind: "lastName",
      reportedField: "name",
    };
  }

  if (
    /(^|\s)(full[ _-]?)?(your[ _-]?)?name(\s|$)/.test(metadata) &&
    !/user[ _-]?name/.test(metadata) &&
    !filled_kinds.has("fullName")
  ) {
    return {
      value: contact_request.name,
      uniqueKind: "fullName",
      reportedField: "name",
    };
  }

  return undefined;
}

/*
 * ========================================================================
 * CONTROL FILLING - fill_matched_control(...)
 * ========================================================================
 * Input:  A matched control/value pair plus tracking sets.
 * Output: Whether the control was filled successfully.
 *
 * Responsibility: Fill one contact field and update reporting/debug state.
 * ========================================================================
 */
export async function fill_matched_control(
  control: Locator,
  field_match: MatchedContactField,
  index: number,
  metadata: string,
  populated_fields: Set<PopulatedField>,
  filled_kinds: Set<string>,
  deep_debug?: DeepDebugContext,
): Promise<boolean> {
  const started_at = performance.now();
  const before = await read_control_debug_state(control);
  deep_debug?.record({
    stage: "population",
    substage: "field-fill",
    operation: "fill-matched-control",
    outcome: "started",
    correlationId: `field-${index}-${field_match.uniqueKind}`,
    data: {
      index,
      metadata,
      matchedField: field_match.reportedField,
      uniqueKind: field_match.uniqueKind,
      intendedValueLength: field_match.value.length,
      before,
    },
  });
  try {
    const tag = await control.evaluate((element) => element.tagName.toLowerCase());
    if (tag === "select") {
      const option_value = await matching_select_option_value(
        control,
        field_match.value,
        field_match.reportedField,
      );
      if (option_value === undefined) return false;
      await control.selectOption({ value: option_value });
    } else {
      await control.fill(field_match.value);
    }

    filled_kinds.add(field_match.uniqueKind);
    populated_fields.add(field_match.reportedField);
    const after = await read_control_debug_state(control);
    deep_debug?.record({
      stage: "population",
      substage: "field-fill",
      operation: "fill-matched-control",
      outcome: "succeeded",
      correlationId: `field-${index}-${field_match.uniqueKind}`,
      durationMs: performance.now() - started_at,
      data: {
        index,
        matchedField: field_match.reportedField,
        uniqueKind: field_match.uniqueKind,
        before,
        after,
        valueMatchesExpected: after.valueLength === field_match.value.length &&
          (await control.inputValue().catch(() => "")) === field_match.value,
      },
    });
    return true;
  } catch (error) {
    deep_debug?.record({
      stage: "population",
      substage: "field-fill",
      operation: "fill-matched-control",
      outcome: "failed",
      correlationId: `field-${index}-${field_match.uniqueKind}`,
      durationMs: performance.now() - started_at,
      reason: error_to_message(error),
      data: {
        index,
        metadata,
        matchedField: field_match.reportedField,
        uniqueKind: field_match.uniqueKind,
        before,
        after: await read_control_debug_state(control),
      },
    });
    return false;
  }
}

async function read_control_debug_state(control: Locator): Promise<{
  connected: boolean;
  visible: boolean;
  enabled: boolean;
  editable: boolean;
  tag: string;
  type: string;
  valuePresent: boolean;
  valueLength: number;
  valid: boolean | null;
  validationMessage: string;
}> {
  const dom = await control
    .evaluate((element) => {
      const candidate = element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
      const value = "value" in candidate ? String(candidate.value ?? "") : "";
      return {
        connected: element.isConnected,
        tag: element.tagName.toLowerCase(),
        type: element.getAttribute("type") ?? "",
        valuePresent: value.length > 0,
        valueLength: value.length,
        valid: "validity" in candidate ? candidate.validity.valid : null,
        validationMessage:
          "validationMessage" in candidate ? candidate.validationMessage : "",
      };
    })
    .catch(() => ({
      connected: false,
      tag: "",
      type: "",
      valuePresent: false,
      valueLength: 0,
      valid: null,
      validationMessage: "",
    }));
  const [visible, enabled, editable] = await Promise.all([
    control.isVisible().catch(() => false),
    control.isEnabled().catch(() => false),
    control.isEditable().catch(() => false),
  ]);
  return { ...dom, visible, enabled, editable };
}

/*
 * ========================================================================
 * STEP_LEVEL_HELPER_FUNCTIONS
 * ========================================================================
 *
 * is_usable_control(...)    - Verify a control can be filled.
 * contact_field_match(...)  - Convert a contact field kind to its fill value.
 * first_contact_name(...)   - Extract first name from full name.
 * last_contact_name(...)    - Extract last name from full name.
 * error_to_message(...)     - Normalize unknown errors for reports.
 * ========================================================================
 */

export async function is_usable_control(control: Locator): Promise<boolean> {
  try {
    const tag = await control.evaluate((element) => element.tagName.toLowerCase());
    return (
      (await control.isVisible()) &&
      (await control.isEnabled()) &&
      (tag === "select" || (await control.isEditable()))
    );
  } catch {
    return false;
  }
}

export function contact_field_match(
  field_kind: Exclude<
    ContactFieldKind,
    "company" | "role" | "website" | "country"
  >,
  contact_request: ContactRequest,
): MatchedContactField;
export function contact_field_match(
  field_kind: ContactFieldKind,
  contact_request: ContactRequest,
): MatchedContactField | undefined;
export function contact_field_match(
  field_kind: ContactFieldKind,
  contact_request: ContactRequest,
): MatchedContactField | undefined {
  switch (field_kind) {
    case "firstName":
      return {
        value: first_contact_name(contact_request.name),
        uniqueKind: "firstName",
        reportedField: "name",
      };
    case "lastName":
      return {
        value: last_contact_name(contact_request.name),
        uniqueKind: "lastName",
        reportedField: "name",
      };
    case "email":
      return {
        value: contact_request.email,
        uniqueKind: "email",
        reportedField: "email",
      };
    case "phone":
      return {
        value: contact_request.phone,
        uniqueKind: "phone",
        reportedField: "phone",
      };
    case "message":
      return {
        value: contact_request.message,
        uniqueKind: "message",
        reportedField: "message",
      };
    case "name":
      return {
        value: contact_request.name,
        uniqueKind: "fullName",
        reportedField: "name",
      };
    case "company":
    case "role":
    case "website":
    case "country": {
      const value = contact_request[field_kind];
      return value
        ? {
            value,
            uniqueKind: field_kind,
            reportedField: field_kind,
          }
        : undefined;
    }
  }
}

async function matching_select_option_value(
  select: Locator,
  desired_value: string,
  field: PopulatedField,
): Promise<string | undefined> {
  const options = await select
    .locator("option")
    .evaluateAll((elements) =>
      elements.map((element) => {
        const option = element as HTMLOptionElement;
        return {
          value: option.value,
          text: option.textContent?.trim() ?? "",
          disabled: option.disabled,
          hidden: option.hidden,
        };
      }),
    )
    .catch(() => []);
  const desired_aliases = option_aliases(desired_value, field);
  const match = options.find(
    (option) =>
      !option.disabled &&
      !option.hidden &&
      [
        ...option_aliases(option.text, field),
        ...option_aliases(option.value, field),
      ].some((alias) => desired_aliases.has(alias)),
  );
  return match?.value;
}

function option_aliases(value: string, field: PopulatedField): Set<string> {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const aliases = new Set([normalized]);
  if (field !== "country") return aliases;
  if (["usa", "us", "unitedstates", "unitedstatesofamerica"].includes(normalized)) {
    return new Set(["usa", "us", "unitedstates", "unitedstatesofamerica"]);
  }
  if (["uk", "gb", "greatbritain", "unitedkingdom"].includes(normalized)) {
    return new Set(["uk", "gb", "greatbritain", "unitedkingdom"]);
  }
  if (["uae", "unitedarabemirates"].includes(normalized)) {
    return new Set(["uae", "unitedarabemirates"]);
  }
  return aliases;
}

function first_contact_name(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

function last_contact_name(name: string): string {
  const name_parts = name.trim().split(/\s+/);
  return name_parts.length > 1
    ? name_parts.slice(1).join(" ")
    : first_contact_name(name);
}

export function error_to_message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
