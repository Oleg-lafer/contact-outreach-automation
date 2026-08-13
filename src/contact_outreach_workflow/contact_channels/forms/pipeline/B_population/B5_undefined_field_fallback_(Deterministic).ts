import type { Locator } from "playwright";
import type {
  ContactRequest,
  MissingFieldAction,
  MissingFieldReportEntry,
  MissingFieldsReport,
} from "../../shared_files_forms/forms_types_(Support).js";
import {
  assess_required_control_inventory,
  REQUIRED_CONTROL_INVENTORY_SELECTOR,
  type RequiredControlAssessment,
} from "../../shared_files_forms/required_control_inventory_(Deterministic).js";
import { matches_form_semantic } from "../../shared_files_forms/form_semantics_(Deterministic).js";

const UNKNOWN_TEXT_FALLBACK_VALUE = "Hello";
const REMAINING_CONTROL_SELECTOR = REQUIRED_CONTROL_INVENTORY_SELECTOR;
const PLACEHOLDER_OPTION_TEXT_PATTERN =
  /^(-+|choose(?:\s+.*)?|select(?:\s+.*)?|please\s+(?:choose|select)(?:\s+.*)?|pick one|topic|בחר(?:ו)?(?:\s+.*)?|נא לבחור(?:\s+.*)?|יש לבחור(?:\s+.*)?|בחירה)$/u;
const FIRST_OPTION_PLACEHOLDER_VALUE_PATTERN = /^$|^0$|^-1$|^none$|^null$/;
const STYLED_DROPDOWN_OPENER_SELECTOR = [
  ".styledSelect",
  '[role="combobox"]',
  '[aria-haspopup="listbox"]',
  "button",
  "[tabindex]:not(select)",
].join(", ");
const STYLED_DROPDOWN_OPTION_SELECTOR = [
  ".options li",
  '[role="option"]',
  "ul li",
  "ol li",
].join(", ");

type MissingFieldsReportDraft = Omit<MissingFieldsReport, "generatedAt">;

interface RemainingControlState {
  index: number;
  tag: string;
  type: string;
  role: string;
  name: string;
  id: string;
  placeholder: string;
  ariaLabel: string;
  autocomplete: string;
  labelText: string;
  choiceText: string;
  groupKey: string;
  visible: boolean;
  required: boolean;
  value: string;
  checked: boolean;
  selectedOptionIndex: number;
  selectedOptionText: string;
  selectedOptionValue: string;
  selectedOptionDisabled: boolean;
  selectedOptionHidden: boolean;
  minLength: number;
  maxLength: number;
  pattern: string;
  multiple: boolean;
  assessment?: RequiredControlAssessment;
}

interface SelectOptionChoice {
  value: string;
  text: string;
}

type StyledDropdownSelectionResult =
  | { selected: true; valueAfter: string }
  | { selected: false; reason: string };

/*
 * TOP LEVEL WORKFLOW:
 *
 * satisfy_undefined_field_fallback(form)
 *        |
 *        v
 * collect remaining visible controls and required hidden native dropdowns
 *        |
 *        v
 * decide fallback action
 *        |
 *        v
 * execute safe fallback action
 *        |
 *        v
 * return missing-fields report draft
 */

/*
 * ========================================================================
 * TOP_LEVEL_WORKFLOW_FUNCTIONS
 * ========================================================================
 */

/*
 * ========================================================================
 * UNDEFINED FIELD FALLBACK - satisfy_undefined_field_fallback(...)
 * ========================================================================
 * Input:  The selected contact form/container after normal population.
 * Output: A missing-fields report draft with actions taken and unresolved fields.
 *
 * Responsibility: Keep runs moving by filling safe undefined text fields,
 * selecting native dropdowns and Yes/No checkbox choices, and recording
 * anything still unsafe or unsupported for future debugging or LLM upgrades.
 * ========================================================================
 */
export async function satisfy_undefined_field_fallback(
  form: Locator,
  contact_request?: ContactRequest,
): Promise<MissingFieldsReportDraft> {
  const records: MissingFieldReportEntry[] = [];
  const controls = form.locator(REMAINING_CONTROL_SELECTOR);
  const selected_checkbox_groups = new Set<string>();
  const selected_radio_groups = new Set<string>();
  const required_inventory = await assess_required_control_inventory(form);
  const required_by_index = new Map(
    required_inventory.controls.map((control) => [control.index, control]),
  );

  for (let index = 0; index < (await controls.count()); index += 1) {
    const control = controls.nth(index);
    const state = await read_remaining_control_state(
      control,
      index,
      required_by_index.get(index),
    );
    if (!state) {
      continue;
    }

    const record = await decide_and_execute_undefined_field_action(
      control,
      state,
      selected_checkbox_groups,
      selected_radio_groups,
      contact_request,
    );
    if (record) {
      records.push(record);
    }
  }

  return {
    version: 1,
    summary: summarize_missing_fields(records),
    records,
  };
}

/*
 * ========================================================================
 * STEP_LEVEL_HELPER_FUNCTIONS
 * ========================================================================
 *
 * read_remaining_control_state(...)              - Describe a remaining control.
 * decide_and_execute_undefined_field_action(...) - Choose and run fallback action.
 * select_remaining_native_dropdown(...)          - Select/report native dropdowns.
 * handle_unknown_checkbox_choice(...)            - Select/report safe checkbox choices.
 * fill_unknown_text_control(...)                 - Fill safe unknown text controls.
 * first_selectable_option_value(...)             - Pick non-placeholder option.
 * error_to_message(...)                          - Normalize unknown errors for logs.
 * ========================================================================
 */

async function read_remaining_control_state(
  control: Locator,
  index: number,
  assessment?: RequiredControlAssessment,
): Promise<RemainingControlState | undefined> {
  try {
    const visible = await control.isVisible();
    const enabled = await control.isEnabled();
    const tag = await control.evaluate((element) =>
      element.tagName.toLowerCase(),
    );

    if (!enabled && !assessment) {
      return undefined;
    }

    const state = await control.evaluate<
      RemainingControlState,
      { control_index: number; visible: boolean }
    >(
      (element, metadata) => {
        const html_element = element as HTMLElement;
        const input = element as HTMLInputElement;
        const select = element as HTMLSelectElement;
        const labels =
          "labels" in input && input.labels
            ? Array.from(input.labels).map((label) => label.textContent ?? "")
            : [];
        const closest_label_text = html_element.closest("label")?.textContent ?? "";
        const fieldset = html_element.closest("fieldset");
        const legend_text =
          fieldset?.querySelector("legend")?.textContent?.trim() ?? "";
        const choice_text = (
          labels[0] ??
          closest_label_text ??
          html_element.getAttribute("aria-label") ??
          ""
        )
          .trim()
          .replace(/\s+/g, " ");
        const selected_option =
          html_element.tagName.toLowerCase() === "select"
            ? Array.from(select.options).find((option) => option.selected)
            : undefined;
        const selected_option_index =
          html_element.tagName.toLowerCase() === "select"
            ? select.selectedIndex
            : -1;
        const value =
          html_element.tagName.toLowerCase() === "input" ||
          html_element.tagName.toLowerCase() === "textarea" ||
          html_element.tagName.toLowerCase() === "select"
            ? input.value
            : html_element.textContent ?? "";

        return {
          index: metadata.control_index,
          tag: html_element.tagName.toLowerCase(),
          type: input.getAttribute("type")?.toLowerCase() ?? "",
          role: html_element.getAttribute("role")?.toLowerCase() ?? "",
          name: input.getAttribute("name") ?? "",
          id: html_element.id,
          placeholder: input.getAttribute("placeholder") ?? "",
          ariaLabel: html_element.getAttribute("aria-label") ?? "",
          autocomplete: input.getAttribute("autocomplete") ?? "",
          labelText: [...labels, closest_label_text]
            .filter(Boolean)
            .join(" ")
            .trim()
            .replace(/\s+/g, " "),
          choiceText: choice_text,
          groupKey:
            legend_text ||
            input.getAttribute("name") ||
            html_element.closest("[role='group']")?.textContent?.trim() ||
            "__unknown_checkbox_choice__",
          visible: metadata.visible,
          required:
            Boolean(input.required) ||
            html_element.hasAttribute("required") ||
            html_element.getAttribute("aria-required")?.toLowerCase() === "true",
          value: value.trim(),
          checked:
            html_element.tagName.toLowerCase() === "input" &&
            (input.type === "checkbox" || input.type === "radio") &&
            input.checked,
          selectedOptionIndex: selected_option_index,
          selectedOptionText: selected_option?.textContent?.trim() ?? "",
          selectedOptionValue: selected_option?.value ?? "",
          selectedOptionDisabled: selected_option?.disabled ?? false,
          selectedOptionHidden: selected_option?.hidden ?? false,
          minLength: "minLength" in input ? input.minLength : -1,
          maxLength: "maxLength" in input ? input.maxLength : -1,
          pattern: input.getAttribute("pattern") ?? "",
          multiple:
            html_element.tagName.toLowerCase() === "select"
              ? select.multiple
              : false,
        };
      },
      { control_index: index, visible },
    );

    state.required = state.required || Boolean(assessment?.required);
    state.groupKey = assessment?.groupKey || state.groupKey;
    if (assessment) {
      state.assessment = assessment;
    }

    if (
      !state.visible &&
      state.tag === "select" &&
      !state.required &&
      assessment?.classification !== "activeCustomBacked"
    ) {
      return undefined;
    }

    return state;
  } catch {
    return undefined;
  }
}

async function decide_and_execute_undefined_field_action(
  control: Locator,
  state: RemainingControlState,
  selected_checkbox_groups: Set<string>,
  selected_radio_groups: Set<string>,
  contact_request?: ContactRequest,
): Promise<MissingFieldReportEntry | undefined> {
  if (state.assessment?.classification === "inactiveHiddenConditional") {
    return missing_field_record(
      state,
      "ignoredInactiveConditional",
      "confidently inactive hidden conditional control was left untouched during population",
    );
  }

  if (state.assessment?.classification === "unsupportedUnsafe") {
    return state.required
      ? missing_field_record(
          state,
          "skippedUnsafe",
          state.assessment.unsafeReason ??
            state.assessment.classificationReason,
        )
      : undefined;
  }

  if (state.assessment?.classification === "alreadySatisfied") {
    return undefined;
  }

  if (
    contact_request &&
    state.required &&
    !has_meaningful_value(state) &&
    !state.checked
  ) {
    const contact_value = required_contact_value(state, contact_request);
    if (contact_value) {
      return fill_required_contact_control(control, state, contact_value);
    }
  }

  if (state.tag === "select") {
    return select_remaining_native_dropdown(control, state);
  }

  if (is_radio_control(state)) {
    return handle_required_radio_choice(
      control,
      state,
      selected_radio_groups,
    );
  }

  if (is_checkbox_control(state)) {
    return handle_unknown_checkbox_choice(
      control,
      state,
      selected_checkbox_groups,
    );
  }

  if (is_simple_aria_choice(state)) {
    return handle_simple_aria_choice(control, state);
  }

  if (!state.required || has_meaningful_value(state) || state.checked) {
    return undefined;
  }

  if (is_unknown_text_compatible_control(state)) {
    return fill_unknown_text_control(control, state);
  }

  if (is_unsafe_unknown_control(state)) {
    return missing_field_record(
      state,
      "skippedUnsafe",
      `required ${state.tag}${state.type ? `[type=${state.type}]` : ""} is not safe for generic fallback`,
    );
  }

  return missing_field_record(
    state,
    "unhandledRequired",
    "required control could not be handled by generic fallback",
  );
}

async function select_remaining_native_dropdown(
  select: Locator,
  state: RemainingControlState,
): Promise<MissingFieldReportEntry | undefined> {
  if (has_valid_selected_option(state)) {
    return undefined;
  }

  const option = await first_selectable_option_value(select);
  if (!option) {
    return state.required
      ? missing_field_record(
          state,
          "unhandledRequired",
          "required native dropdown has no valid non-placeholder option",
        )
      : undefined;
  }

  if (!state.visible) {
    const styled_selection = await select_hidden_native_dropdown_via_companion(
      select,
      option,
    );

    if (styled_selection.selected) {
      return missing_field_record(
        state,
        "selectedDropdown",
        "selected first valid styled dropdown option backed by hidden native select",
        {
          valueAfter: styled_selection.valueAfter,
          selectedOptionText: option.text,
          selectedOptionValue: option.value,
        },
      );
    }

    return missing_field_record(
      state,
      state.required ? "unhandledRequired" : "skippedUnsafe",
      `hidden native dropdown could not be selected by generic styled-select fallback: ${styled_selection.reason}`,
    );
  }

  try {
    await select.selectOption({ value: option.value });
    const value_after = await select.inputValue().catch(() => option.value);
    return missing_field_record(
      state,
      "selectedDropdown",
      "selected first valid native dropdown option",
      {
        valueAfter: value_after,
        selectedOptionText: option.text,
        selectedOptionValue: option.value,
      },
    );
  } catch (error) {
    return missing_field_record(
      state,
      state.required ? "unhandledRequired" : "skippedUnsafe",
      `native dropdown could not be selected: ${error_to_message(error)}`,
    );
  }
}

async function select_hidden_native_dropdown_via_companion(
  select: Locator,
  option: SelectOptionChoice,
): Promise<StyledDropdownSelectionResult> {
  const wrapper = select.locator("xpath=parent::*[not(self::form)]");
  if ((await wrapper.count()) === 0) {
    return {
      selected: false,
      reason: "no safe non-form wrapper found around hidden select",
    };
  }

  const opener = await first_visible_enabled_locator(
    wrapper.locator(STYLED_DROPDOWN_OPENER_SELECTOR),
  );
  if (!opener) {
    return {
      selected: false,
      reason: "no visible styled dropdown opener found near hidden select",
    };
  }

  await opener.click();

  const visible_option = await matching_visible_styled_dropdown_option(
    wrapper,
    option,
  );
  if (!visible_option) {
    return {
      selected: false,
      reason: "no visible styled dropdown option matched the native option",
    };
  }

  await visible_option.click();

  const value_after = await select.inputValue().catch(() => "");
  if (value_after !== option.value) {
    return {
      selected: false,
      reason: `styled dropdown click did not update hidden select value to ${option.value}`,
    };
  }

  return { selected: true, valueAfter: value_after };
}

async function handle_unknown_checkbox_choice(
  checkbox: Locator,
  state: RemainingControlState,
  selected_checkbox_groups: Set<string>,
): Promise<MissingFieldReportEntry | undefined> {
  if (state.checked) {
    return undefined;
  }

  if (is_unsafe_checkbox_choice(state)) {
    return state.required
      ? missing_field_record(
          state,
          "skippedUnsafe",
          "required checkbox looks unsafe for generic fallback",
        )
      : undefined;
  }

  if (!state.required && !is_yes_no_checkbox_option(state)) {
    return undefined;
  }

  if (selected_checkbox_groups.has(state.groupKey)) {
    return undefined;
  }

  try {
    await checkbox.check();
    selected_checkbox_groups.add(state.groupKey);
    return missing_field_record(
      state,
      "selectedCheckbox",
      state.required
        ? "selected first safe required checkbox option"
        : "selected first Yes/No checkbox option",
      {
        valueAfter: "checked",
        selectedChoiceText: state.choiceText,
        selectedChoiceValue: state.value,
      },
    );
  } catch (error) {
    return missing_field_record(
      state,
      state.required ? "unhandledRequired" : "skippedUnsafe",
      `checkbox choice could not be selected: ${error_to_message(error)}`,
    );
  }
}

async function handle_required_radio_choice(
  radio: Locator,
  state: RemainingControlState,
  selected_radio_groups: Set<string>,
): Promise<MissingFieldReportEntry | undefined> {
  if (!state.required || state.checked) {
    return undefined;
  }
  if (selected_radio_groups.has(state.groupKey)) {
    return undefined;
  }

  try {
    if (state.visible) {
      await radio.check();
    } else {
      const labels = radio.locator("xpath=ancestor-or-self::label[1]");
      const associated_label =
        (await labels.count()) > 0
          ? labels.first()
          : state.id
            ? radio.locator(
                `xpath=ancestor::*[self::form or @role='form'][1]//label[@for=${xpath_literal(state.id)}]`,
              )
            : undefined;
      if (!associated_label || !(await associated_label.isVisible())) {
        return missing_field_record(
          state,
          "unhandledRequired",
          "required hidden radio has no visible associated label",
        );
      }
      await associated_label.click();
    }
    const checked = await radio.isChecked().catch(() => false);
    if (!checked) {
      return missing_field_record(
        state,
        "unhandledRequired",
        "radio interaction did not produce a checked state",
      );
    }
    selected_radio_groups.add(state.groupKey);
    return missing_field_record(
      state,
      "selectedRadio",
      "selected the first enabled required radio choice",
      {
        valueAfter: "checked",
        selectedChoiceText: state.choiceText,
        selectedChoiceValue: state.value,
      },
      true,
    );
  } catch (error) {
    return missing_field_record(
      state,
      "unhandledRequired",
      `required radio choice could not be selected: ${error_to_message(error)}`,
    );
  }
}

async function handle_simple_aria_choice(
  control: Locator,
  state: RemainingControlState,
): Promise<MissingFieldReportEntry | undefined> {
  if (!state.required || !state.visible) {
    return state.required
      ? missing_field_record(
          state,
          "unhandledRequired",
          "required ARIA widget was not visibly actionable",
        )
      : undefined;
  }

  try {
    if (state.role === "checkbox") {
      await control.click();
      const checked =
        (await control.getAttribute("aria-checked"))?.toLowerCase() === "true";
      return checked
        ? missing_field_record(
            state,
            "selectedCustomChoice",
            "checked a required ARIA checkbox and verified aria-checked",
            {
              selectedChoiceText: state.choiceText,
              selectedChoiceValue: "checked",
            },
            true,
          )
        : missing_field_record(
            state,
            "unhandledRequired",
            "ARIA checkbox click did not set aria-checked=true",
          );
    }

    if (state.role === "radiogroup") {
      const radios = control.locator('[role="radio"]');
      const option = await first_visible_enabled_non_placeholder(radios);
      if (!option) {
        return missing_field_record(
          state,
          "unhandledRequired",
          "required ARIA radiogroup had no enabled non-placeholder radio",
        );
      }
      const option_text = normalize_choice_text(
        (await option.textContent().catch(() => "")) ?? "",
      );
      await option.click();
      const checked =
        (await option.getAttribute("aria-checked"))?.toLowerCase() === "true";
      return checked
        ? missing_field_record(
            state,
            "selectedCustomChoice",
            "selected the first required ARIA radio and verified aria-checked",
            {
              selectedChoiceText: option_text,
              selectedChoiceValue: option_text,
            },
            true,
          )
        : missing_field_record(
            state,
            "unhandledRequired",
            "ARIA radio click did not set aria-checked=true",
          );
    }

    if (state.role === "combobox") {
      await control.click();
    }
    const option_scope = await resolve_simple_aria_option_scope(control);
    if (!option_scope) {
      return missing_field_record(
        state,
        "unhandledRequired",
        "required custom dropdown had no uniquely scoped ARIA option container",
      );
    }
    const option = await first_visible_enabled_non_placeholder(
      option_scope.locator('[role="option"]'),
    );
    if (!option) {
      return missing_field_record(
        state,
        "unhandledRequired",
        "required custom dropdown had no enabled non-placeholder ARIA option",
      );
    }
    const option_text = normalize_choice_text(
      (await option.textContent().catch(() => "")) ?? "",
    );
    await option.click();
    const option_selected =
      (await option.getAttribute("aria-selected"))?.toLowerCase() === "true";
    const control_text = normalize_choice_text(
      ((await control.getAttribute("value").catch(() => null)) ??
        (await control.textContent().catch(() => "")) ??
        ""),
    );
    const verified =
      option_selected ||
      (Boolean(option_text) &&
        (control_text === option_text || control_text.includes(option_text)));
    return verified
      ? missing_field_record(
          state,
          "selectedCustomChoice",
          "selected the first required ARIA option and verified widget state",
          {
            selectedOptionText: option_text,
            selectedOptionValue: option_text,
          },
          true,
        )
      : missing_field_record(
          state,
          "unhandledRequired",
          "ARIA option click did not produce a verifiable selected state",
        );
  } catch (error) {
    return missing_field_record(
      state,
      "unhandledRequired",
      `required ARIA widget could not be completed: ${error_to_message(error)}`,
    );
  }
}

async function resolve_simple_aria_option_scope(
  control: Locator,
): Promise<Locator | undefined> {
  const controls_id = await control.getAttribute("aria-controls");
  if (controls_id) {
    const page = control.page();
    const controlled = page.locator(`[id="${css_escape(controls_id)}"]`);
    if ((await controlled.count()) === 1) {
      return controlled;
    }
    return undefined;
  }
  const parent = control.locator("xpath=parent::*[not(self::form)]");
  if ((await parent.count()) !== 1) {
    return undefined;
  }
  const option_count = await parent.locator('[role="option"]').count();
  return option_count > 0 ? parent : undefined;
}

async function first_visible_enabled_non_placeholder(
  options: Locator,
): Promise<Locator | undefined> {
  for (let index = 0; index < (await options.count()); index += 1) {
    const option = options.nth(index);
    const [visible, enabled, aria_disabled, text] = await Promise.all([
      option.isVisible().catch(() => false),
      option.isEnabled().catch(() => false),
      option.getAttribute("aria-disabled").catch(() => null),
      option.textContent().catch(() => ""),
    ]);
    if (
      visible &&
      enabled &&
      aria_disabled?.toLowerCase() !== "true" &&
      text &&
      !PLACEHOLDER_OPTION_TEXT_PATTERN.test(text.trim())
    ) {
      return option;
    }
  }
  return undefined;
}

function required_contact_value(
  state: RemainingControlState,
  contact_request: ContactRequest,
): string | undefined {
  const metadata = [
    state.name,
    state.id,
    state.placeholder,
    state.ariaLabel,
    state.autocomplete,
    state.labelText,
  ]
    .join(" ")
    .toLowerCase();
  if (state.type === "email" || matches_form_semantic("email", metadata)) {
    return contact_request.email;
  }
  if (state.type === "tel" || matches_form_semantic("phone", metadata)) {
    return contact_request.phone;
  }
  if (
    state.type === "url" ||
    matches_form_semantic("website", metadata)
  ) {
    return contact_request.website;
  }
  if (matches_form_semantic("company", metadata)) {
    return contact_request.company;
  }
  if (matches_form_semantic("fullName", metadata)) {
    return contact_request.name;
  }
  if (matches_form_semantic("role", metadata)) {
    return contact_request.role;
  }
  if (matches_form_semantic("country", metadata)) {
    return contact_request.country;
  }
  return undefined;
}

async function fill_required_contact_control(
  control: Locator,
  state: RemainingControlState,
  expected_value: string,
): Promise<MissingFieldReportEntry> {
  try {
    await control.fill(expected_value);
    const verification = await control
      .evaluate(
        (element, expected) => {
          const field = element as HTMLInputElement | HTMLTextAreaElement;
          return {
            matches: field.value === expected,
            valid: field.validity.valid,
            length: field.value.length,
          };
        },
        expected_value,
      )
      .catch(() => ({ matches: false, valid: false, length: 0 }));
    if (!verification.matches || !verification.valid) {
      return {
        ...missing_field_record(
          state,
          "unhandledRequired",
          "supplied contact value did not satisfy the required control constraints",
        ),
        expectedValuePresent: expected_value.length > 0,
        expectedValueLength: expected_value.length,
        valueMatchesExpected: verification.matches,
        verificationSucceeded: false,
      };
    }
    return {
      ...missing_field_record(
        state,
        "filledContactDuplicate",
        "filled an additional required contact field with its corresponding supplied value",
      ),
      expectedValuePresent: expected_value.length > 0,
      expectedValueLength: expected_value.length,
      valueMatchesExpected: true,
      verificationSucceeded: true,
    };
  } catch (error) {
    return missing_field_record(
      state,
      "unhandledRequired",
      `additional required contact field could not be filled: ${error_to_message(error)}`,
    );
  }
}

async function fill_unknown_text_control(
  control: Locator,
  state: RemainingControlState,
): Promise<MissingFieldReportEntry> {
  const fallback_value = constraint_aware_text_fallback(state);
  if (!fallback_value) {
    return missing_field_record(
      state,
      "unhandledRequired",
      "required text constraints could not be satisfied by the neutral fallback",
    );
  }
  try {
    const value_before = await control.inputValue().catch(() => "");
    await control.fill(fallback_value);
    const valid = await control
      .evaluate((element) => {
        const field = element as HTMLInputElement | HTMLTextAreaElement;
        return field.validity.valid;
      })
      .catch(() => false);
    if (!valid) {
      await control.fill(value_before).catch(() => undefined);
      return missing_field_record(
        state,
        "unhandledRequired",
        "neutral fallback did not satisfy the required text control constraints",
      );
    }
    return missing_field_record(
      state,
      "filledUnknownText",
      "filled unknown required text-like field with a constraint-aware neutral fallback",
      {
        fillValue: fallback_value,
        valueAfter: fallback_value,
      },
      true,
    );
  } catch (error) {
    return missing_field_record(
      state,
      "unhandledRequired",
      `unknown required text-like field could not be filled: ${error_to_message(error)}`,
    );
  }
}

function constraint_aware_text_fallback(
  state: RemainingControlState,
): string | undefined {
  const minimum = Math.max(0, state.minLength);
  const maximum =
    state.maxLength >= 0 ? state.maxLength : Number.POSITIVE_INFINITY;
  if (maximum === 0 || minimum > maximum) {
    return undefined;
  }
  let value = UNKNOWN_TEXT_FALLBACK_VALUE;
  while (value.length < minimum) {
    value += UNKNOWN_TEXT_FALLBACK_VALUE;
  }
  if (Number.isFinite(maximum)) {
    value = value.slice(0, maximum);
  }
  if (value.length < minimum) {
    return undefined;
  }
  if (state.pattern) {
    try {
      const pattern = new RegExp(`^(?:${state.pattern})$`, "u");
      if (!pattern.test(value)) return undefined;
    } catch {
      return undefined;
    }
  }
  return value;
}

function missing_field_record(
  state: RemainingControlState,
  action: MissingFieldAction,
  reason: string,
  extra: Partial<
    Pick<
      MissingFieldReportEntry,
      | "valueAfter"
      | "fillValue"
      | "selectedOptionText"
      | "selectedOptionValue"
      | "selectedChoiceText"
      | "selectedChoiceValue"
    >
  > = {},
  verification_succeeded?: boolean,
): MissingFieldReportEntry {
  return {
    index: state.index,
    tag: state.tag,
    type: state.type,
    role: state.role,
    name: state.name,
    id: state.id,
    placeholder: state.placeholder,
    ariaLabel: state.ariaLabel,
    labelText: state.labelText,
    groupKey: state.groupKey,
    required: state.required,
    action,
    reason,
    ...(state.assessment
      ? {
          requiredSources: state.assessment.requiredSources,
          activityClassification: state.assessment.classification,
          hiddenReasons: state.assessment.hiddenReasons,
          controlKind: state.assessment.kind,
        }
      : {}),
    ...(verification_succeeded !== undefined
      ? { verificationSucceeded: verification_succeeded }
      : {}),
    ...(([
        "filledUnknownText",
        "selectedDropdown",
        "selectedCheckbox",
        "selectedRadio",
        "selectedCustomChoice",
      ] as MissingFieldAction[]).includes(action)
      ? { valueBefore: state.value }
      : {}),
    ...extra,
  };
}

function summarize_missing_fields(
  records: MissingFieldReportEntry[],
): MissingFieldsReportDraft["summary"] {
  return {
    reportPath: "",
    unknownTextFieldsFilled: records.filter(
      (record) => record.action === "filledUnknownText",
    ).length,
    dropdownsSelected: records.filter(
      (record) => record.action === "selectedDropdown",
    ).length,
    checkboxChoicesSelected: records.filter(
      (record) => record.action === "selectedCheckbox",
    ).length,
    radioChoicesSelected: records.filter(
      (record) => record.action === "selectedRadio",
    ).length,
    customChoicesSelected: records.filter(
      (record) => record.action === "selectedCustomChoice",
    ).length,
    duplicateContactFieldsFilled: records.filter(
      (record) => record.action === "filledContactDuplicate",
    ).length,
    inactiveConditionalControls: records.filter(
      (record) => record.action === "ignoredInactiveConditional",
    ).length,
    unresolvedActiveRequiredControls: records.filter(
      (record) =>
        record.required &&
        record.action !== "ignoredInactiveConditional" &&
        (record.action === "unhandledRequired" ||
          record.action === "skippedUnsafe"),
    ).length,
    unhandledRequiredFields: records.filter(
      (record) =>
        record.required &&
        record.action !== "ignoredInactiveConditional" &&
        (record.action === "unhandledRequired" ||
          record.action === "skippedUnsafe"),
    ).length,
    skippedUnsafeFields: records.filter(
      (record) => record.action === "skippedUnsafe",
    ).length,
  };
}

async function first_visible_enabled_locator(
  locator: Locator,
): Promise<Locator | undefined> {
  for (let index = 0; index < (await locator.count()); index += 1) {
    const candidate = locator.nth(index);
    if (await is_visible_enabled_click_target(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

async function matching_visible_styled_dropdown_option(
  wrapper: Locator,
  option: SelectOptionChoice,
): Promise<Locator | undefined> {
  const targets = new Set(
    [option.text, option.value]
      .map((value) => normalize_dropdown_option_text(value))
      .filter(Boolean),
  );
  const candidates = wrapper.locator(STYLED_DROPDOWN_OPTION_SELECTOR);

  for (let index = 0; index < (await candidates.count()); index += 1) {
    const candidate = candidates.nth(index);
    if (!(await is_visible_enabled_click_target(candidate))) {
      continue;
    }

    const metadata = await candidate
      .evaluate((element) => ({
        text: element.textContent ?? "",
        value:
          element.getAttribute("data-value") ??
          element.getAttribute("value") ??
          "",
      }))
      .catch(() => ({ text: "", value: "" }));
    const text = normalize_dropdown_option_text(metadata.text);
    const value = normalize_dropdown_option_text(metadata.value);

    if (targets.has(text) || targets.has(value)) {
      return candidate;
    }
  }

  return undefined;
}

async function is_visible_enabled_click_target(locator: Locator): Promise<boolean> {
  const visible = await locator.isVisible().catch(() => false);
  const enabled = await locator.isEnabled().catch(() => false);
  if (!visible || !enabled) {
    return false;
  }

  return locator
    .evaluate((element) => {
      const html_element = element as HTMLElement;
      return !(
        html_element.hasAttribute("disabled") ||
        html_element.getAttribute("aria-disabled")?.toLowerCase() === "true" ||
        html_element.classList.contains("disabled")
      );
    })
    .catch(() => false);
}

function normalize_dropdown_option_text(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function is_required_custom_dropdown(state: RemainingControlState): boolean {
  return (
    state.required &&
    (state.role === "combobox" ||
      state.role === "listbox" ||
      /listbox/i.test(state.ariaLabel) ||
      state.type === "combobox")
  );
}

function has_meaningful_value(state: RemainingControlState): boolean {
  const value = state.value.trim().toLowerCase();
  return Boolean(value) && !PLACEHOLDER_OPTION_TEXT_PATTERN.test(value);
}

function has_valid_selected_option(state: RemainingControlState): boolean {
  return !is_placeholder_select_option({
    index: state.selectedOptionIndex,
    text: state.selectedOptionText,
    value: state.selectedOptionValue,
    disabled: state.selectedOptionDisabled,
    hidden: state.selectedOptionHidden,
  });
}

function is_unknown_text_compatible_control(
  state: RemainingControlState,
): boolean {
  return (
    state.tag === "textarea" ||
    (state.tag === "input" &&
      (state.type === "" || state.type === "text" || state.type === "search"))
  );
}

function is_checkbox_control(state: RemainingControlState): boolean {
  return state.tag === "input" && state.type === "checkbox";
}

function is_radio_control(state: RemainingControlState): boolean {
  return state.tag === "input" && state.type === "radio";
}

function is_simple_aria_choice(state: RemainingControlState): boolean {
  return ["combobox", "listbox", "radiogroup", "checkbox"].includes(
    state.role,
  );
}

function is_yes_no_checkbox_option(state: RemainingControlState): boolean {
  const choice = normalize_choice_text(state.choiceText);
  return choice === "yes" || choice === "no";
}

function is_unsafe_checkbox_choice(state: RemainingControlState): boolean {
  const metadata = [
    state.name,
    state.id,
    state.ariaLabel,
    state.labelText,
    state.choiceText,
  ]
    .join(" ")
    .toLowerCase();
  return /captcha|robot/.test(metadata);
}

function normalize_choice_text(value: string): string {
  const words = value
    .toLowerCase()
    .replace(/[^a-z]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  return words.length > 0 && words.every((word) => word === words[0])
    ? words[0] ?? ""
    : words.join(" ");
}

function is_unsafe_unknown_control(state: RemainingControlState): boolean {
  return (
    state.tag === "input" &&
    [
      "hidden",
      "file",
      "password",
      "checkbox",
      "radio",
      "submit",
      "button",
      "reset",
      "number",
      "date",
      "datetime-local",
      "month",
      "week",
      "time",
      "color",
      "range",
      "email",
      "tel",
      "url",
    ].includes(state.type)
  );
}

async function first_selectable_option_value(
  select: Locator,
): Promise<SelectOptionChoice | undefined> {
  return select.evaluate((element) => {
    const select_element = element as HTMLSelectElement;
    const options = Array.from(select_element.options);
    const placeholder_text_pattern =
      /^(-+|choose(?:\s+.*)?|select(?:\s+.*)?|please\s+(?:choose|select)(?:\s+.*)?|pick one|topic)$/;
    const first_option_placeholder_value_pattern =
      /^$|^0$|^-1$|^none$|^null$/;

    const option = options.find((candidate, index) => {
      const value = candidate.value.trim().toLowerCase();
      const text = candidate.textContent?.trim().toLowerCase() ?? "";
      const is_placeholder =
        candidate.disabled ||
        candidate.hidden ||
        placeholder_text_pattern.test(text) ||
        (index === 0 && first_option_placeholder_value_pattern.test(value));
      return (
        candidate.value &&
        !is_placeholder
      );
    });

    return option
      ? {
          value: option.value,
          text: option.textContent?.trim() ?? "",
        }
      : undefined;
  });
}

function is_placeholder_select_option({
  index,
  text,
  value,
  disabled,
  hidden,
}: {
  index: number;
  text: string;
  value: string;
  disabled: boolean;
  hidden: boolean;
}): boolean {
  if (index < 0 || disabled || hidden) {
    return true;
  }

  const normalized_text = text.trim().toLowerCase();
  const normalized_value = value.trim().toLowerCase();
  return (
    !normalized_text ||
    !normalized_value ||
    PLACEHOLDER_OPTION_TEXT_PATTERN.test(normalized_text) ||
    (index === 0 &&
      FIRST_OPTION_PLACEHOLDER_VALUE_PATTERN.test(normalized_value))
  );
}

function error_to_message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function css_escape(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function xpath_literal(value: string): string {
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"')) return `"${value}"`;
  return `concat(${value
    .split("'")
    .map((part, index, parts) =>
      index < parts.length - 1 ? `'${part}', "'"` : `'${part}'`,
    )
    .join(", ")})`;
}
