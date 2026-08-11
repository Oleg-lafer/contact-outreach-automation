import type { ElementHandle, Locator } from "playwright";

export const REQUIRED_CONTROL_INVENTORY_SELECTOR = [
  "input",
  "textarea",
  "select",
  '[role="combobox"]',
  '[role="listbox"]',
  '[role="radiogroup"]',
  '[role="checkbox"]',
  '[data-required="true"]',
].join(", ");

export type RequiredControlClassification =
  | "alreadySatisfied"
  | "activeNative"
  | "activeCustomBacked"
  | "inactiveHiddenConditional"
  | "unsupportedUnsafe";

export type RequiredControlKind =
  | "text"
  | "textarea"
  | "select"
  | "checkbox"
  | "radio"
  | "customCombobox"
  | "customListbox"
  | "customRadioGroup"
  | "customCheckbox"
  | "unsupported";

export interface RequiredControlAssessment {
  index: number;
  tag: string;
  type: string;
  role: string;
  name: string;
  id: string;
  autocomplete: string;
  labelText: string;
  placeholder: string;
  groupKey: string;
  kind: RequiredControlKind;
  required: boolean;
  requiredSources: string[];
  classification: RequiredControlClassification;
  classificationReason: string;
  hiddenReasons: string[];
  visible: boolean;
  enabled: boolean;
  readOnly: boolean;
  hasVisibleCompanion: boolean;
  satisfied: boolean;
  checked: boolean | null;
  valuePresent: boolean;
  valueLength: number;
  minLength: number;
  maxLength: number;
  pattern: string;
  multiple: boolean;
  unsafeReason?: string;
}

export interface RequiredControlInventory {
  controls: RequiredControlAssessment[];
  counts: {
    required: number;
    alreadySatisfied: number;
    activeNative: number;
    activeCustomBacked: number;
    inactiveHiddenConditional: number;
    unsupportedUnsafe: number;
  };
}

export interface TemporarilyDisabledRequiredControl {
  index: number;
  tag: string;
  type: string;
  name: string;
  id: string;
  groupKey: string;
  hiddenReasons: string[];
  requiredSources: string[];
}

export interface RequiredControlRestorationResult {
  attempted: number;
  restored: number;
  detached: number;
  failed: number;
}

export interface InactiveRequiredControlLease {
  inventory: RequiredControlInventory;
  disabledControls: TemporarilyDisabledRequiredControl[];
  restore: () => Promise<RequiredControlRestorationResult>;
}

interface DisabledControlHandle {
  handle: ElementHandle<HTMLElement>;
  evidence: TemporarilyDisabledRequiredControl;
  originallyDisabled: boolean;
  originallyHadDisabledAttribute: boolean;
}

function execute_required_control_inventory_evaluator(
  elements: Array<SVGElement | HTMLElement>,
  source: string,
): RequiredControlAssessment[] {
  const evaluator = eval(`(${source})`) as (
    candidates: Array<SVGElement | HTMLElement>,
  ) => RequiredControlAssessment[];
  return evaluator(elements);
}

export async function assess_required_control_inventory(
  scope: Locator,
): Promise<RequiredControlInventory> {
  const controls = scope.locator(REQUIRED_CONTROL_INVENTORY_SELECTOR);
  const evaluate_inventory = (
    elements: Array<SVGElement | HTMLElement>,
  ): RequiredControlAssessment[] => {
      const placeholder_pattern =
        /^(-+|choose(?:\s+.*)?|select(?:\s+.*)?|please\s+(?:choose|select)(?:\s+.*)?|pick one|topic)$/i;
      function is_rendered(element: Element): boolean {
        if (!(element instanceof HTMLElement) || !element.isConnected) {
          return false;
        }
        let current: HTMLElement | null = element;
        while (current) {
          const style = getComputedStyle(current);
          if (
            current.hidden ||
            current.hasAttribute("inert") ||
            current.getAttribute("aria-hidden")?.toLowerCase() === "true" ||
            style.display === "none" ||
            style.visibility === "hidden" ||
            style.contentVisibility === "hidden"
          ) {
            return false;
          }
          current = current.parentElement;
        }
        return element.getClientRects().length > 0;
      }
      function hidden_reasons(element: Element): string[] {
        const reasons = new Set<string>();
        let current: HTMLElement | null =
          element instanceof HTMLElement ? element : null;
        while (current) {
          const style = getComputedStyle(current);
          const prefix = current === element ? "self" : "ancestor";
          if (current.hidden) reasons.add(`${prefix}:hidden`);
          if (current.hasAttribute("inert")) reasons.add(`${prefix}:inert`);
          if (current.getAttribute("aria-hidden")?.toLowerCase() === "true") {
            reasons.add(`${prefix}:aria-hidden`);
          }
          if (style.display === "none") reasons.add(`${prefix}:display-none`);
          if (style.visibility === "hidden") {
            reasons.add(`${prefix}:visibility-hidden`);
          }
          if (style.contentVisibility === "hidden") {
            reasons.add(`${prefix}:content-visibility-hidden`);
          }
          current = current.parentElement;
        }
        return [...reasons];
      }
      function visible_companion(
        element: Element,
        tag: string,
        type: string,
      ): boolean {
        const input = element as HTMLInputElement;
        if (Array.from(input.labels ?? []).some((label) => is_rendered(label))) {
          return true;
        }
        const parent = element.parentElement;
        if (!parent) return false;
        const selectors =
          tag === "select"
            ? [
                '[role="combobox"]',
                '[aria-haspopup="listbox"]',
                ".styledSelect",
                "button",
                "[tabindex]:not(select)",
              ]
            : type === "checkbox" || type === "radio"
              ? ["label", '[role="checkbox"]', '[role="radio"]', "button"]
              : [];
        return selectors.some((selector) =>
          Array.from(parent.querySelectorAll(selector)).some(
            (candidate) => candidate !== element && is_rendered(candidate),
          ),
        );
      }
      function normalize(value: string | null | undefined): string {
        return (value ?? "").trim().replace(/\s+/g, " ");
      }
      function group_for(element: Element): Element | null {
        return element.closest(
          '[role="radiogroup"], [role="group"], fieldset, [data-required="true"]',
        );
      }
      function labels_for(element: Element): string[] {
        const input = element as HTMLInputElement;
        const labels =
          "labels" in input && input.labels
            ? Array.from(input.labels).map((label) => label.textContent ?? "")
            : [];
        const closest_label = element.closest("label")?.textContent ?? "";
        const group = group_for(element);
        const legend = group?.querySelector("legend")?.textContent ?? "";
        return [...labels, closest_label, legend]
          .map(normalize)
          .filter(Boolean);
      }
      function required_sources_for(
        element: Element,
        type: string,
      ): string[] {
        const sources = new Set<string>();
        const field = element as HTMLInputElement;
        if ("required" in field && field.required) sources.add("native-required");
        if (element.getAttribute("aria-required")?.toLowerCase() === "true") {
          sources.add("aria-required");
        }
        if (element.getAttribute("data-required")?.toLowerCase() === "true") {
          sources.add("data-required");
        }
        const group = group_for(element);
        if (group && group !== element) {
          if (group.getAttribute("aria-required")?.toLowerCase() === "true") {
            sources.add("group-aria-required");
          }
          if (group.getAttribute("data-required")?.toLowerCase() === "true") {
            sources.add("group-data-required");
          }
        }
        if ((type === "radio" || type === "checkbox") && field.name) {
          const matching = elements.filter((candidate) => {
            const other = candidate as HTMLInputElement;
            return (
              candidate instanceof HTMLInputElement &&
              other.type === type &&
              other.name === field.name
            );
          });
          if (matching.some((candidate) => (candidate as HTMLInputElement).required)) {
            sources.add("group-native-required");
          }
          if (
            matching.some(
              (candidate) =>
                candidate.getAttribute("aria-required")?.toLowerCase() === "true",
            )
          ) {
            sources.add("group-aria-required");
          }
        }
        return [...sources];
      }
      function kind_for(
        tag: string,
        type: string,
        role: string,
      ): RequiredControlKind {
        if (tag === "textarea") return "textarea";
        if (tag === "select") return "select";
        if (tag === "input" && type === "checkbox") return "checkbox";
        if (tag === "input" && type === "radio") return "radio";
        if (
          tag === "input" &&
          ["", "text", "search", "email", "tel", "url"].includes(type)
        ) {
          return "text";
        }
        if (role === "combobox") return "customCombobox";
        if (role === "listbox") return "customListbox";
        if (role === "radiogroup") return "customRadioGroup";
        if (role === "checkbox") return "customCheckbox";
        return "unsupported";
      }

        return elements.map((element, index) => {
        const html = element as HTMLElement;
        const input = element as HTMLInputElement;
        const select = element as HTMLSelectElement;
        const tag = element.tagName.toLowerCase();
        const type =
          tag === "input"
            ? (input.getAttribute("type")?.toLowerCase() ?? "text")
            : tag;
        const role = element.getAttribute("role")?.toLowerCase() ?? "";
        const labels = labels_for(element);
        const group = group_for(element);
        const group_key = normalize(
          group?.getAttribute("aria-label") ??
            group?.querySelector("legend")?.textContent ??
            input.name ??
            html.id ??
            `required-control-${index}`,
        );
        const required_sources = required_sources_for(element, type);
        const required = required_sources.length > 0;
        const visible = is_rendered(element);
        const reasons = hidden_reasons(element);
        const companion = !visible && visible_companion(element, tag, type);
        const enabled =
          !("disabled" in input) ||
          (!input.disabled &&
            element.getAttribute("aria-disabled")?.toLowerCase() !== "true");
        const read_only = "readOnly" in input ? input.readOnly : false;
        const value =
          "value" in input
            ? String(input.value ?? "")
            : normalize(element.textContent);
        const metadata = [
          input.name,
          html.id,
          input.getAttribute("autocomplete"),
          input.getAttribute("placeholder"),
          input.getAttribute("aria-label"),
          ...labels,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        const unsafe_reason =
          /captcha|recaptcha|hcaptcha|turnstile|robot|honeypot|website[_ -]?url[_ -]?check|quiz|security question|password|payment|credit card|card number|cvv|cvc/.test(
            metadata,
          )
            ? "control metadata indicates CAPTCHA, honeypot, security, password, or payment input"
            : tag === "input" &&
                [
                  "hidden",
                  "file",
                  "password",
                  "number",
                  "date",
                  "datetime-local",
                  "month",
                  "week",
                  "time",
                  "color",
                  "range",
                ].includes(type)
              ? `input type ${type} is outside deterministic required-field completion`
              : undefined;
        const kind = kind_for(tag, type, role);
        let satisfied = !required || !enabled || read_only;
        let checked: boolean | null = null;
        if (required && enabled && !read_only) {
          if (type === "radio" || type === "checkbox") {
            const matching = input.name
              ? elements.filter((candidate) => {
                  const other = candidate as HTMLInputElement;
                  return (
                    candidate instanceof HTMLInputElement &&
                    other.type === type &&
                    other.name === input.name
                  );
                })
              : [element];
            checked = input.checked;
            satisfied = matching.some(
              (candidate) => (candidate as HTMLInputElement).checked,
            );
          } else if (tag === "select") {
            const selected = Array.from(select.selectedOptions).filter(
              (option) =>
                !option.disabled &&
                !option.hidden &&
                Boolean(option.value.trim()) &&
                !placeholder_pattern.test(normalize(option.textContent)),
            );
            satisfied = selected.length > 0 && select.validity.valid;
          } else if (
            role === "checkbox" ||
            role === "radiogroup" ||
            role === "listbox"
          ) {
            satisfied =
              element.getAttribute("aria-checked")?.toLowerCase() === "true" ||
              Boolean(
                element.querySelector(
                  '[aria-checked="true"], [aria-selected="true"]',
                ),
              );
          } else if (role === "combobox") {
            const text = normalize(
              element.getAttribute("value") ?? element.textContent,
            );
            satisfied = Boolean(text) && !placeholder_pattern.test(text);
          } else if ("validity" in input) {
            satisfied = Boolean(value.trim()) && input.validity.valid;
          }
        }

        let classification: RequiredControlClassification;
        let classification_reason: string;
        if (satisfied) {
          classification = "alreadySatisfied";
          classification_reason =
            required && (!enabled || read_only)
              ? "required control is disabled or readonly and is not an active requirement"
              : "required control is already satisfied";
        } else if (unsafe_reason || kind === "unsupported") {
          classification = "unsupportedUnsafe";
          classification_reason =
            unsafe_reason ?? "required control kind is unsupported";
        } else if (reasons.length > 0 && !companion) {
          classification = "inactiveHiddenConditional";
          classification_reason =
            "required control is strongly hidden with no visible associated control";
        } else if (!visible && companion) {
          classification = "activeCustomBacked";
          classification_reason =
            "hidden native control has a visible associated interaction control";
        } else if (visible && tag !== "input" && tag !== "textarea" && tag !== "select") {
          classification = "activeCustomBacked";
          classification_reason = "visible required ARIA widget is active";
        } else if (visible) {
          classification = "activeNative";
          classification_reason = "visible enabled required native control is active";
        } else {
          classification = "unsupportedUnsafe";
          classification_reason =
            "required control is neither visibly active nor confidently inactive";
        }

        return {
          index,
          tag,
          type,
          role,
          name: input.getAttribute("name") ?? "",
          id: html.id,
          autocomplete: input.getAttribute("autocomplete") ?? "",
          labelText: labels.join(" "),
          placeholder: input.getAttribute("placeholder") ?? "",
          groupKey: group_key,
          kind,
          required,
          requiredSources: required_sources,
          classification,
          classificationReason: classification_reason,
          hiddenReasons: reasons,
          visible,
          enabled,
          readOnly: read_only,
          hasVisibleCompanion: companion,
          satisfied,
          checked,
          valuePresent: value.length > 0,
          valueLength: value.length,
          minLength: "minLength" in input ? input.minLength : -1,
          maxLength: "maxLength" in input ? input.maxLength : -1,
          pattern: input.getAttribute("pattern") ?? "",
          multiple: tag === "select" ? select.multiple : false,
          ...(unsafe_reason ? { unsafeReason: unsafe_reason } : {}),
        };
        });
  };
  const evaluator_source = evaluate_inventory
    .toString()
    .replace("{", "{const __name=(target)=>target;");
  const assessments = await controls.evaluateAll<
    RequiredControlAssessment[],
    string
  >(
    execute_required_control_inventory_evaluator,
    evaluator_source,
  );
  const required_controls = assessments.filter((control) => control.required);
  return {
    controls: required_controls,
    counts: {
      required: required_controls.length,
      alreadySatisfied: count_classification(required_controls, "alreadySatisfied"),
      activeNative: count_classification(required_controls, "activeNative"),
      activeCustomBacked: count_classification(
        required_controls,
        "activeCustomBacked",
      ),
      inactiveHiddenConditional: count_classification(
        required_controls,
        "inactiveHiddenConditional",
      ),
      unsupportedUnsafe: count_classification(
        required_controls,
        "unsupportedUnsafe",
      ),
    },
  };
}

export async function temporarily_disable_inactive_required_controls(
  scope: Locator,
): Promise<InactiveRequiredControlLease> {
  const inventory = await assess_required_control_inventory(scope);
  const controls = scope.locator(REQUIRED_CONTROL_INVENTORY_SELECTOR);
  const disabled_handles: DisabledControlHandle[] = [];

  for (const assessment of inventory.controls) {
    if (assessment.classification !== "inactiveHiddenConditional") {
      continue;
    }
    const control = controls.nth(assessment.index);
    const handle = await control.elementHandle().catch(() => null);
    if (!handle) continue;
    const original = await handle
      .evaluate((element) => {
        if (
          !(
            element instanceof HTMLInputElement ||
            element instanceof HTMLTextAreaElement ||
            element instanceof HTMLSelectElement
          )
        ) {
          return undefined;
        }
        const state = {
          disabled: element.disabled,
          hadDisabledAttribute: element.hasAttribute("disabled"),
        };
        if (!element.disabled) element.disabled = true;
        return state;
      })
      .catch(() => undefined);
    if (!original || original.disabled) {
      await handle.dispose().catch(() => undefined);
      continue;
    }
    disabled_handles.push({
      handle: handle as ElementHandle<HTMLElement>,
      evidence: {
        index: assessment.index,
        tag: assessment.tag,
        type: assessment.type,
        name: assessment.name,
        id: assessment.id,
        groupKey: assessment.groupKey,
        hiddenReasons: assessment.hiddenReasons,
        requiredSources: assessment.requiredSources,
      },
      originallyDisabled: original.disabled,
      originallyHadDisabledAttribute: original.hadDisabledAttribute,
    });
  }

  let restored = false;
  return {
    inventory,
    disabledControls: disabled_handles.map((entry) => entry.evidence),
    restore: async () => {
      if (restored) {
        return {
          attempted: disabled_handles.length,
          restored: disabled_handles.length,
          detached: 0,
          failed: 0,
        };
      }
      restored = true;
      let restored_count = 0;
      let detached = 0;
      let failed = 0;
      for (const entry of disabled_handles) {
        try {
          const result = await entry.handle.evaluate(
            (element, state) => {
              if (!element.isConnected) return "detached";
              if (
                !(
                  element instanceof HTMLInputElement ||
                  element instanceof HTMLTextAreaElement ||
                  element instanceof HTMLSelectElement
                )
              ) {
                return "failed";
              }
              element.disabled = state.disabled;
              if (!state.hadDisabledAttribute) {
                element.removeAttribute("disabled");
              }
              return "restored";
            },
            {
              disabled: entry.originallyDisabled,
              hadDisabledAttribute: entry.originallyHadDisabledAttribute,
            },
          );
          if (result === "restored") restored_count += 1;
          else if (result === "detached") detached += 1;
          else failed += 1;
        } catch {
          failed += 1;
        } finally {
          await entry.handle.dispose().catch(() => undefined);
        }
      }
      return {
        attempted: disabled_handles.length,
        restored: restored_count,
        detached,
        failed,
      };
    },
  };
}

function count_classification(
  controls: RequiredControlAssessment[],
  classification: RequiredControlClassification,
): number {
  return controls.filter((control) => control.classification === classification)
    .length;
}
