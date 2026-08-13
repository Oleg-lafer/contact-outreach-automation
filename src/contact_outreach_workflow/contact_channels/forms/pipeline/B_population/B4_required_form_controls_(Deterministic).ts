import type { Locator } from "playwright";
import type { ContactFormCandidate } from "../../shared_files_forms/forms_types_(Support).js";
import { page_contains_captcha } from "../../shared_files_forms/captcha_detection_(Deterministic).js";
import { matches_form_semantic } from "../../shared_files_forms/form_semantics_(Deterministic).js";

/*
 * TOP LEVEL WORKFLOW:
 *
 * contains_captcha(candidate)
 *        |
 *        v
 * satisfy_required_choice_controls(form)
 *        |
 *        v
 * check_required_privacy_consent(form)
 */

/*
 * ========================================================================
 * TOP_LEVEL_WORKFLOW_FUNCTIONS
 * ========================================================================
 */

/*
 * ========================================================================
 * CAPTCHA DETECTION - contains_captcha(...)
 * ========================================================================
 * Input:  The selected contact form candidate.
 * Output: Whether CAPTCHA markup is present.
 *
 * Responsibility: Stop unsupported CAPTCHA flows before population/submission.
 * ========================================================================
 */
export async function contains_captcha(
  candidate: ContactFormCandidate,
): Promise<boolean> {
  return page_contains_captcha(candidate.frame.page());
}

/*
 * ========================================================================
 * REQUIRED CHOICE SATISFACTION - satisfy_required_choice_controls(...)
 * ========================================================================
 * Input:  The selected contact form/container.
 * Output: Whether any required radio control was satisfied.
 *
 * Responsibility: Safely choose required radio options so form submission can
 * proceed without inventing domain-specific answers. Undefined-field fallback
 * handles native dropdowns so they can be reported in missing-fields.json.
 * ========================================================================
 */
export async function satisfy_required_choice_controls(
  form: Locator,
): Promise<boolean> {
  return check_required_radio_groups(form);
}

/*
 * ========================================================================
 * PRIVACY CONSENT CHECKING - check_required_privacy_consent(...)
 * ========================================================================
 * Input:  The selected contact form/container.
 * Output: Whether a required privacy/terms checkbox was checked.
 *
 * Responsibility: Accept required privacy/terms consent while avoiding
 * optional marketing/newsletter consent.
 * ========================================================================
 */
export async function check_required_privacy_consent(
  form: Locator,
): Promise<boolean> {
  const checkboxes = form.locator('input[type="checkbox"][required]');
  let checked_any = false;

  for (let index = 0; index < (await checkboxes.count()); index += 1) {
    const checkbox = checkboxes.nth(index);
    const metadata = await checkbox.evaluate((element) => {
      const field = element as HTMLInputElement;
      return [
        field.name,
        field.id,
        field.getAttribute("aria-label"),
        ...Array.from(field.labels ?? []).map((label) => label.textContent ?? ""),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
    });

    const is_privacy_consent = matches_form_semantic("privacy", metadata);
    const is_marketing_consent = matches_form_semantic("marketing", metadata);
    if (is_privacy_consent && !is_marketing_consent && (await checkbox.isEnabled())) {
      await checkbox.check();
      checked_any = true;
    }
  }

  return checked_any;
}

/*
 * ========================================================================
 * STEP_LEVEL_HELPER_FUNCTIONS
 * ========================================================================
 *
 * check_required_radio_groups(...) - Check one enabled radio per group.
 * first_enabled_radio(...)         - Find the first usable radio option.
 * css_escape(...)                  - Escape radio group names for selectors.
 * ========================================================================
 */

async function check_required_radio_groups(form: Locator): Promise<boolean> {
  const radios = form.locator('input[type="radio"][required]');
  const handled_group_names = new Set<string>();
  let checked_any = false;

  for (let index = 0; index < (await radios.count()); index += 1) {
    const radio = radios.nth(index);
    const group_name = await radio.evaluate((element, fallback_index) => {
      const field = element as HTMLInputElement;
      return field.name || `__radio_${fallback_index}`;
    }, index);

    if (handled_group_names.has(group_name)) {
      continue;
    }
    handled_group_names.add(group_name);

    const group = group_name.startsWith("__radio_")
      ? radio
      : form.locator(`input[type="radio"][name="${css_escape(group_name)}"]`);
    const enabled_option = await first_enabled_radio(group);
    if (!enabled_option) {
      continue;
    }

    try {
      await enabled_option.check();
      checked_any = true;
    } catch {
      // Ignore non-standard radio widgets and continue with other groups.
    }
  }

  return checked_any;
}

async function first_enabled_radio(group: Locator): Promise<Locator | undefined> {
  for (let index = 0; index < (await group.count()); index += 1) {
    const option = group.nth(index);
    if ((await option.isVisible()) && (await option.isEnabled())) {
      return option;
    }
  }

  return undefined;
}

function css_escape(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}
