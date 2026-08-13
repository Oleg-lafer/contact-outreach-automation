import type { Locator, Page } from "playwright";
import {
  ACTION_TIMEOUT_MS,
  CONFIRMATION_TIMEOUT_MS,
} from "../../../../shared_files_orchestrator/outreach_constants_(Support).js";
import { describe_error } from "../../../../shared_files_orchestrator/outreach_errors_(Support).js";
import type {
  SubmissionRejectionEvidence,
} from "../../shared_files_forms/forms_types_(Support).js";
import type {
  ButtonClickAuditEvent,
  EffectivePreSubmitValidationResult,
  InvalidControlDebugInfo,
  MessageCandidateDebugInfo,
  SubmissionVisibleEvidence,
  SubmitControlSearchResult,
} from "./C2_submission_types_(Support).js";
import {
  normalize_bilingual_text,
  safely_decode_url_text,
} from "../../../../shared_files_orchestrator/bilingual_text_(Deterministic).js";
import { collect_visible_message_candidates } from "./C5_submission_observability_(Support).js";
import {
  create_button_click_audit_event,
  mark_button_click_failed,
  mark_button_click_succeeded,
} from "./C4_button_click_audit_(Support).js";

/*
 * TOP LEVEL WORKFLOW:
 *
 * collect_invalid_controls(form)
 *        |
 *        v
 * click_confirmation_control_if_present(page, audit_events)
 *        |
 *        v
 * wait_for_submission_confirmation(page, url_before, ...)
 */

/*
 * ========================================================================
 * TOP_LEVEL_WORKFLOW_FUNCTIONS
 * ========================================================================
 */

/*
 * ========================================================================
 * INVALID CONTROL COLLECTION - collect_invalid_controls(...)
 * ========================================================================
 * Input:  The submitted form/container.
 * Output: Native browser-invalid controls with validation details.
 *
 * Responsibility: Distinguish failed validation from unconfirmed submission.
 * ========================================================================
 */
export async function assess_effective_pre_submit_validity(
  form: Locator,
  submit_control: Locator,
): Promise<EffectivePreSubmitValidationResult> {
  const submitter_handle = await submit_control.elementHandle().catch(() => null);
  if (!submitter_handle) {
    return {
      applicability: "inspectionFailed",
      valid: null,
      reason: "the selected submit control was no longer attached",
      inspectionFailure: "submitControlDetached",
      invalidControls: [],
    };
  }

  try {
    return await form.evaluate((form_element, submitter_element) => {
      if (!(form_element instanceof HTMLFormElement)) {
        return {
          applicability: "notApplicable" as const,
          valid: null,
          reason:
            "native constraint validation does not apply because the selected contact container is not a form",
          bypassReason: "selectedContainerIsNotForm" as const,
          invalidControls: [],
        };
      }

      const native_submitter =
        (submitter_element instanceof HTMLButtonElement &&
          submitter_element.type === "submit") ||
        (submitter_element instanceof HTMLInputElement &&
          ["submit", "image"].includes(submitter_element.type));
      if (!native_submitter) {
        return {
          applicability: "notApplicable" as const,
          valid: null,
          reason:
            "native constraint validation does not apply because activation uses a custom or non-submit control",
          bypassReason: "controlIsNotNativeSubmitter" as const,
          invalidControls: [],
        };
      }

      if (submitter_element.form !== form_element) {
        return {
          applicability: "inspectionFailed" as const,
          valid: null,
          reason:
            "the selected native submitter targets a different form",
          inspectionFailure: "submitterTargetsDifferentForm",
          invalidControls: [],
        };
      }

      if (form_element.noValidate) {
        return {
          applicability: "notApplicable" as const,
          valid: null,
          reason: "native constraint validation is bypassed by novalidate",
          bypassReason: "formNoValidate" as const,
          invalidControls: [],
        };
      }

      if (submitter_element.formNoValidate) {
        return {
          applicability: "notApplicable" as const,
          valid: null,
          reason: "native constraint validation is bypassed by formnovalidate",
          bypassReason: "submitterFormNoValidate" as const,
          invalidControls: [],
        };
      }

      const invalid_controls = Array.from(form_element.elements)
        .filter(
          (
            element,
          ): element is
            | HTMLInputElement
            | HTMLTextAreaElement
            | HTMLSelectElement =>
            element instanceof HTMLInputElement ||
            element instanceof HTMLTextAreaElement ||
            element instanceof HTMLSelectElement,
        )
        .filter((field) => field.willValidate && !field.validity.valid)
        .map((field) => {
          const value = field.value;
          const validation_message =
            value.length > 0
              ? field.validationMessage.replaceAll(value, "[redacted value]")
              : field.validationMessage;
          return {
            tag: field.tagName.toLowerCase(),
            type: field.getAttribute("type") ?? field.tagName.toLowerCase(),
            name: field.getAttribute("name") ?? "",
            id: field.id,
            autocomplete: field.getAttribute("autocomplete") ?? "",
            required: field.required,
            disabled: field.disabled,
            readOnly: "readOnly" in field ? field.readOnly : false,
            checked: field instanceof HTMLInputElement ? field.checked : null,
            valuePresent: value.length > 0,
            valueLength: value.length,
            willValidate: field.willValidate,
            validity: {
              badInput: field.validity.badInput,
              customError: field.validity.customError,
              patternMismatch: field.validity.patternMismatch,
              rangeOverflow: field.validity.rangeOverflow,
              rangeUnderflow: field.validity.rangeUnderflow,
              stepMismatch: field.validity.stepMismatch,
              tooLong: field.validity.tooLong,
              tooShort: field.validity.tooShort,
              typeMismatch: field.validity.typeMismatch,
              valueMissing: field.validity.valueMissing,
              valid: field.validity.valid,
            },
            validationMessage: validation_message,
            labels: Array.from(field.labels ?? [])
              .map((label) => label.textContent?.trim() ?? "")
              .filter((label) => label.length > 0),
          };
        });

      return {
        applicability: "applicable" as const,
        valid: invalid_controls.length === 0,
        reason:
          invalid_controls.length === 0
            ? "all native constraints in the selected form are valid"
            : `${invalid_controls.length} native constraint control(s) in the selected form are invalid`,
        invalidControls: invalid_controls,
      };
    }, submitter_handle);
  } catch (error) {
    const failure = describe_error(error);
    return {
      applicability: "inspectionFailed",
      valid: null,
      reason: `native constraint validation could not be inspected: ${failure}`,
      inspectionFailure: failure,
      invalidControls: [],
    };
  } finally {
    await submitter_handle.dispose().catch(() => undefined);
  }
}

export async function collect_invalid_controls(
  form: Locator,
): Promise<InvalidControlDebugInfo[]> {
  try {
    return form
      .locator("input:invalid, textarea:invalid, select:invalid")
      .evaluateAll((elements) =>
        elements.map((element) => {
          const field = element as
            | HTMLInputElement
            | HTMLTextAreaElement
            | HTMLSelectElement;
          const labels =
            "labels" in field
              ? Array.from(field.labels ?? []).map((label) =>
                  label.textContent?.trim() ?? "",
                )
              : [];
          const value = field.value;
          const validation_message =
            value.length > 0
              ? field.validationMessage.replaceAll(value, "[redacted value]")
              : field.validationMessage;

          return {
            tag: field.tagName.toLowerCase(),
            type: field.getAttribute("type") ?? field.tagName.toLowerCase(),
            name: field.getAttribute("name") ?? "",
            id: field.id,
            autocomplete: field.getAttribute("autocomplete") ?? "",
            required: field.required,
            disabled: field.disabled,
            readOnly: "readOnly" in field ? field.readOnly : false,
            checked: field instanceof HTMLInputElement ? field.checked : null,
            valuePresent: value.length > 0,
            valueLength: value.length,
            willValidate: field.willValidate,
            validity: {
              badInput: field.validity.badInput,
              customError: field.validity.customError,
              patternMismatch: field.validity.patternMismatch,
              rangeOverflow: field.validity.rangeOverflow,
              rangeUnderflow: field.validity.rangeUnderflow,
              stepMismatch: field.validity.stepMismatch,
              tooLong: field.validity.tooLong,
              tooShort: field.validity.tooShort,
              typeMismatch: field.validity.typeMismatch,
              valueMissing: field.validity.valueMissing,
              valid: field.validity.valid,
            },
            validationMessage: validation_message,
            labels: labels.filter((label) => label.length > 0),
          };
        }),
      );
  } catch {
    return [];
  }
}

/*
 * ========================================================================
 * INTERMEDIATE CONFIRMATION CLICK - click_confirmation_control_if_present(...)
 * ========================================================================
 * Input:  Page after first submit click and ordered button audit events.
 * Output: Whether an intermediate confirmation control was clicked.
 *
 * Responsibility: Continue known confirm/review screens while preserving
 * button-click audit evidence.
 * ========================================================================
 */
export async function click_confirmation_control_if_present(
  page: Page,
  button_audit_events: ButtonClickAuditEvent[],
): Promise<boolean> {
  const deadline = Date.now() + CONFIRMATION_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const confirmation_control = await find_visible_confirmation_control(page);
    if (confirmation_control?.control) {
      const audit_event = await create_button_click_audit_event(
        page,
        "intermediateConfirmation",
        confirmation_control.control,
        confirmation_control,
        button_audit_events.length + 1,
      );
      button_audit_events.push(audit_event);

      try {
        await confirmation_control.control.click({ timeout: ACTION_TIMEOUT_MS });
        mark_button_click_succeeded(audit_event);
        return true;
      } catch (error) {
        mark_button_click_failed(audit_event, describe_error(error));
        return false;
      }
    }

    await page.waitForTimeout(250);
  }

  return false;
}

/*
 * ========================================================================
 * SUBMISSION CONFIRMATION WAIT - wait_for_submission_confirmation(...)
 * ========================================================================
 * Input:  Page state before and after the submit action.
 * Output: Whether explicit confirmation evidence appeared.
 *
 * Responsibility: Confirm only URL or visible text evidence, not a successful
 * click by itself.
 * ========================================================================
 */
export async function wait_for_submission_confirmation(
  page: Page,
  url_before_submission: string,
  confirmation_visible_before: boolean,
  messages_before_submission: MessageCandidateDebugInfo[],
  redaction_values: string[] = [],
): Promise<SubmissionVisibleEvidence> {
  const deadline = Date.now() + CONFIRMATION_TIMEOUT_MS;
  let confirmation_evidence: SubmissionVisibleEvidence["confirmationEvidence"] =
    "none";
  let new_messages: MessageCandidateDebugInfo[] = [];

  while (Date.now() < deadline) {
    const current_url = page.url();
    if (
      current_url !== url_before_submission &&
      /thank|success|confirm|submitted|complete|תודה|הצלחה|אישור|נשלח/iu.test(
        safely_decode_url_text(new URL(current_url).pathname),
      )
    ) {
      confirmation_evidence = "successUrl";
    }

    const current_messages = await collect_visible_message_candidates(page);
    new_messages = merge_message_candidates(
      new_messages,
      find_new_message_candidates(
        messages_before_submission,
        current_messages,
      ),
    );
    if (
      confirmation_evidence === "none" &&
      !confirmation_visible_before &&
      ((await has_visible_success_message(page)) ||
        new_messages.some((message) =>
          visible_success_message_matches(message.text),
        ))
    ) {
      confirmation_evidence = "successText";
    }

    await page.waitForTimeout(250);
  }

  return {
    confirmationEvidence: confirmation_evidence,
    rejectionEvidence: classify_new_submission_messages(
      new_messages,
      redaction_values,
    ),
    newMessages: new_messages,
  };
}

/*
 * ========================================================================
 * SUCCESS MESSAGE DETECTION - has_visible_success_message(...)
 * ========================================================================
 * Input:  The page after submission.
 * Output: Whether visible body text contains success evidence.
 *
 * Responsibility: Scan active frames for explicit confirmation text while
 * tolerating detached/cross-navigation frames.
 * ========================================================================
 */
export async function has_visible_success_message(
  page: Page,
): Promise<boolean> {
  for (const frame of page.frames()) {
    try {
      const body_text = await frame.locator("body").innerText({ timeout: 500 });
      if (visible_success_message_matches(body_text)) {
        return true;
      }
    } catch {
      // Detached or cross-navigation frames are ignored during confirmation.
    }
  }

  return false;
}

export function classify_new_submission_messages(
  messages: MessageCandidateDebugInfo[],
  redaction_values: string[] = [],
): SubmissionRejectionEvidence[] {
  const evidence: SubmissionRejectionEvidence[] = [];
  const seen = new Set<string>();

  for (const message of messages) {
    const normalized = normalize_message_text(message.text);
    const classified = classify_rejection_text(normalized);
    if (!classified) {
      continue;
    }
    const key = `${classified.patternId}\n${message.frameUrl}\n${normalized}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    evidence.push({
      source: "visibleMessage",
      category: classified.category,
      patternId: classified.patternId,
      confidence: "strong",
      selector: message.selector,
      frameUrl: message.frameUrl,
      excerpt: redact_message_excerpt(message.text, redaction_values),
    });
  }

  return evidence;
}

/*
 * ========================================================================
 * STEP_LEVEL_HELPER_FUNCTIONS
 * ========================================================================
 *
 * find_visible_confirmation_control(...) - Find confirm/continue controls.
 * ========================================================================
 */

function find_new_message_candidates(
  before: MessageCandidateDebugInfo[],
  after: MessageCandidateDebugInfo[],
): MessageCandidateDebugInfo[] {
  const before_keys = new Set(
    before.map(
      (message) =>
        `${message.frameUrl}\n${normalize_message_text(message.text)}`,
    ),
  );
  const seen = new Set<string>();
  return after.filter((message) => {
    const key = `${message.frameUrl}\n${normalize_message_text(message.text)}`;
    if (before_keys.has(key) || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function merge_message_candidates(
  ...groups: MessageCandidateDebugInfo[][]
): MessageCandidateDebugInfo[] {
  const seen = new Set<string>();
  return groups.flat().filter((message) => {
    const key = `${message.frameUrl}\n${normalize_message_text(message.text)}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function visible_success_message_matches(
  value: string,
): boolean {
  const normalized = normalize_message_text(value);
  return (
    /thank you|thanks for|message (?:has been )?(?:sent|received)|successfully submitted|we(?:'ll| will) (?:be )?in touch/.test(
      normalized,
    ) ||
    /תודה על פנייתך|תודה שפנית|תודה שיצרת קשר|פנייתך התקבלה|הפנייה התקבלה|הפניה התקבלה|הודעתך נשלחה בהצלחה|ההודעה נשלחה בהצלחה|הטופס נשלח בהצלחה|הפרטים נשלחו בהצלחה|ניצור (?:איתך|עמך) קשר|נחזור אלי(?:ך|יך) בהקדם/u.test(
      normalized,
    ) ||
    /l['’]enregistrement a [ée]t[ée] effectu[ée] avec succ[èe]s/.test(
      normalized,
    )
  );
}

function classify_rejection_text(
  normalized: string,
):
  | {
      category: SubmissionRejectionEvidence["category"];
      patternId: string;
    }
  | undefined {
  if (
    /(?:captcha|recaptcha|hcaptcha|turnstile|not a robot|verify that you are not a robot).*(?:required|complete|verify|before submitting)|(?:required|complete|verify).*(?:captcha|recaptcha|hcaptcha|turnstile|robot)|(?:אימות|קאפצ['׳]?ה|רובוט).*(?:חובה|נדרש|יש להשלים|יש לאמת)|(?:יש להשלים|יש לאמת).*(?:אימות|רובוט)/u.test(
      normalized,
    )
  ) {
    return { category: "captcha", patternId: "captcha-verification-required" };
  }
  if (/email addresses? do not match|emails? (?:do not|don['’]t) match/.test(normalized)) {
    return { category: "validation", patternId: "email-values-mismatch" };
  }
  if (/כתובת (?:ה)?(?:אימייל|דוא["״']?ל) (?:אינה|לא) תקינה|(?:אימייל|דוא["״']?ל) לא תקין/u.test(normalized)) {
    return { category: "validation", patternId: "invalid-email-value" };
  }
  if (/enter only numbers|only numbers (?:are )?allowed/.test(normalized)) {
    return { category: "validation", patternId: "numeric-value-required" };
  }
  if (
    /required|mandatory|obligatoire|requis|campo obligatorio|seleccione una opci[oó]n|please complete|need to be completed|must accept (?:the )?(?:privacy|terms)|privacy terms|found errors in form|ne peut pas [êe]tre vide|не може да бъде празно|задължително|plot[ëe]soni|verplicht|obrigat[oó]rio|שדה חובה|חובה למלא|נא למלא|אנא מלא|אנא מלאו|יש למלא|נדרש למלא|יש לבחור|נא לבחור|יש לאשר (?:את )?(?:מדיניות הפרטיות|התנאים)/u.test(
      normalized,
    )
  ) {
    return { category: "validation", patternId: "post-submit-validation" };
  }
  if (
    /please try again|unable to (?:send|submit)|could not (?:send|submit)|submission failed|message was not sent|an error occurred|^error(?:\s|:)|אירעה שגיאה|ארעה שגיאה|לא ניתן לשלוח|השליחה נכשלה|ההודעה לא נשלחה|נסה שוב|נסו שוב/u.test(
      normalized,
    )
  ) {
    return { category: "generic", patternId: "explicit-submit-error" };
  }
  return undefined;
}

function normalize_message_text(value: string): string {
  return normalize_bilingual_text(value);
}

function redact_message_excerpt(
  value: string,
  redaction_values: string[],
): string {
  let result = value;
  for (const secret of [...redaction_values].sort(
    (left, right) => right.length - left.length,
  )) {
    if (secret.trim().length < 2) {
      continue;
    }
    result = result.replace(
      new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"),
      "[redacted-contact-value]",
    );
  }
  return result
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .replace(
      /(?:\+\d[\d\s().-]{6,}\d|\(\d{2,4}\)[\d\s.-]{4,}\d|\d{2,4}[ -]\d{3,4}[ -]\d{3,4})/g,
      "[redacted-phone]",
    )
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 200);
}

async function find_visible_confirmation_control(
  page: Page,
): Promise<SubmitControlSearchResult | undefined> {
  const selector = [
    'button[type="submit"]',
    'input[type="submit"]',
    'button:not([type])',
  ].join(", ");

  for (const frame of page.frames()) {
    const controls = frame.locator(selector);
    for (let index = 0; index < (await controls.count()); index += 1) {
      const control = controls.nth(index);
      if (!(await control.isVisible()) || !(await control.isEnabled())) {
        continue;
      }

      const metadata = (
        `${(await control.textContent()) ?? ""} ${(await control.getAttribute("value")) ?? ""} ${(await control.getAttribute("name")) ?? ""}`
      ).toLowerCase();
      if (/confirm|continue|approve|review and send|אשר|אישור|המשך|שלח סופית|שליחה סופית/u.test(metadata)) {
        return {
          control,
          reason: "",
          strategy: "intermediateConfirmationControl",
          selector,
          selectedIndex: index,
          score: 2,
        };
      }
    }
  }

  return undefined;
}
