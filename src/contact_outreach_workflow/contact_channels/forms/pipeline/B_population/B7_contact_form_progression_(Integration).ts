import type { Locator, Request } from "playwright";
import {
  AI_OBSERVE_TIMEOUT_MS,
  ACTION_TIMEOUT_MS,
} from "../../../../shared_files_orchestrator/outreach_constants_(Support).js";
import { describe_error } from "../../../../shared_files_orchestrator/outreach_errors_(Support).js";
import { create_ai_operation_evidence } from "../../../../shared_files_orchestrator/ai_observability_(Support).js";
import {
  CAPTCHA_SELECTOR,
  selector_targets_captcha,
} from "../../shared_files_forms/captcha_detection_(Deterministic).js";
import { assess_contact_form } from "../../shared_files_forms/contact_form_intent_(Deterministic).js";
import type {
  AiActionEvidence,
  ContactFormCandidate,
} from "../../shared_files_forms/forms_types_(Support).js";
import type {
  PageIntelligence,
  PageIntelligenceAction,
  PageIntelligenceObserveResult,
} from "../../../../shared_files_orchestrator/page_intelligence_(Integration).js";
import type { DeepDebugContext } from "../../shared_files_forms/deep_debug_types_(Support).js";
import {
  create_page_intelligence_scope,
  with_masked_page_values,
} from "../../../../shared_files_orchestrator/page_value_redaction_(Integration).js";

const PROGRESSION_CONTROL_SELECTOR = [
  'button[type="button"]',
  'input[type="button"]',
  '[role="button"]:not(button):not(input):not([href])',
].join(", ");
const PROGRESSION_LABEL =
  /^(?:next(?: step)?|continue|proceed|הבא|לשלב הבא|המשך|המשיכו|קדימה)(?:\s*(?:→|>|»))?$/iu;
const STATE_CHANGE_TIMEOUT_MS = 3_000;
const EXACT_PROGRESSION_LABEL =
  /^(?:next(?: step)?|continue|proceed|הבא|לשלב הבא|המשך|המשיכו|קדימה)$/iu;

export interface ContactFormProgressionResult {
  progressed: boolean;
  messageAvailable: boolean;
  reason: string;
  aiActions: AiActionEvidence[];
}

export interface AlternativeContactFormResult {
  found: boolean;
  reason: string;
  aiActions: AiActionEvidence[];
}

export async function find_stagehand_complete_alternative_form(options: {
  candidate: ContactFormCandidate;
  pageIntelligence: PageIntelligence;
  redactionValues: string[];
}): Promise<AlternativeContactFormResult> {
  const { candidate, pageIntelligence, redactionValues } = options;
  const instruction = [
    "Locate one visible message field inside a complete contact or inquiry form that is different from the currently selected incomplete form.",
    "Return one click action with no arguments as locator evidence only; it will not be clicked.",
    "Do not choose newsletter, search, login, route, booking, CAPTCHA, or submit controls.",
  ].join(" ");
  let observation: PageIntelligenceObserveResult;
  const started_at = Date.now();
  try {
    observation = await with_masked_page_values(
      candidate.frame.page(),
      redactionValues,
      () =>
        pageIntelligence.observe({
          stage: "population",
          page: candidate.frame.page(),
          instruction,
          ignoreSelectors: [CAPTCHA_SELECTOR],
          timeoutMs: AI_OBSERVE_TIMEOUT_MS,
        }),
    );
  } catch (error) {
    return {
      found: false,
      reason: `Stagehand alternative-form observation failed: ${describe_error(error)}`,
      aiActions: [
        create_ai_operation_evidence({
          stage: "population",
          placeholderInstruction: instruction,
          method: "observe",
          model: pageIntelligence.model,
          durationMs: Date.now() - started_at,
          acceptanceReason: "Stagehand alternative-form observation failed",
          result: "failed",
        }),
      ],
    };
  }

  if (observation.actions.length === 0) {
    return {
      found: false,
      reason: "Stagehand found no complete alternative contact form",
      aiActions: [
        create_ai_operation_evidence({
          stage: "population",
          placeholderInstruction: instruction,
          method: "observe",
          model: observation.model,
          durationMs: observation.durationMs,
          acceptanceReason: "Stagehand found no complete alternative contact form",
          result: "observed",
        }),
      ],
    };
  }

  const ai_actions: AiActionEvidence[] = [];
  for (const action of observation.actions) {
    let rejection_reason: string | undefined;
    let alternative: Locator | undefined;
    let alternative_frame = candidate.frame;
    if (action.method.trim().toLowerCase() !== "click") {
      rejection_reason = "alternative-form locator evidence must use a click action";
    } else if ((action.arguments?.length ?? 0) !== 0) {
      rejection_reason = "alternative-form locator evidence may not contain arguments";
    } else if (!action.selector.trim()) {
      rejection_reason = "alternative-form locator evidence had no selector";
    } else if (
      await selector_targets_captcha(candidate.frame.page(), action.selector)
    ) {
      rejection_reason = "alternative-form locator targeted CAPTCHA";
    } else {
      for (const frame of candidate.frame.page().frames()) {
        const observed = frame.locator(action.selector).first();
        if (!(await observed.isVisible().catch(() => false))) continue;
        const form = await normalize_to_form(observed);
        if (!form || (await locators_reference_same_element(candidate.form, form))) {
          continue;
        }
        const assessment = await assess_contact_form(form);
        if (assessment.classification !== "complete") {
          rejection_reason = "observed alternative did not normalize to a complete contact form";
          continue;
        }
        alternative = form;
        alternative_frame = frame;
        candidate.form = form;
        candidate.frame = frame;
        candidate.score = assessment.score;
        candidate.classification = "complete";
        candidate.messageDisposition = "unresolved";
        break;
      }
      if (!alternative && !rejection_reason) {
        rejection_reason = "alternative-form selector did not resolve to a different visible form";
      }
    }

    ai_actions.push({
      stage: "population",
      placeholderInstruction: instruction,
      selector: action.selector,
      method: action.method,
      acceptance: alternative ? "accepted" : "rejected",
      acceptanceReason:
        rejection_reason ??
        `retained complete alternative form locator in ${alternative_frame.url()}`,
      result: alternative ? "succeeded" : "notRun",
      model: observation.model,
      durationMs: observation.durationMs,
      argumentCount: action.arguments?.length ?? 0,
    });
    if (alternative) {
      return {
        found: true,
        reason: "Stagehand identified a complete alternative contact form",
        aiActions: ai_actions,
      };
    }
  }

  return {
    found: false,
    reason: "Stagehand returned only invalid alternative-form selectors",
    aiActions: ai_actions,
  };
}

export async function advance_contact_form_step(options: {
  candidate: ContactFormCandidate;
  pageIntelligence?: PageIntelligence | undefined;
  ensurePageIntelligence?: (() => Promise<PageIntelligence>) | undefined;
  redactionValues: string[];
  seenStateFingerprints?: Set<string> | undefined;
  deepDebug?: DeepDebugContext | undefined;
}): Promise<ContactFormProgressionResult> {
  const { candidate, redactionValues } = options;
  const deterministic_control = await find_safe_progression_control(
    candidate,
    candidate.form.locator(PROGRESSION_CONTROL_SELECTOR),
  );
  if (deterministic_control) {
    options.deepDebug?.record({
      stage: "population",
      substage: "progression-selection",
      operation: "deterministic-progression-control",
      outcome: "succeeded",
      data: await deterministic_control.evaluate((element) => ({
        tag: element.tagName.toLowerCase(),
        type: element.getAttribute("type") ?? "",
        role: element.getAttribute("role") ?? "",
        text: ((element as HTMLElement).innerText || element.textContent || "")
          .trim()
          .replace(/\s+/g, " "),
      })).catch(() => null),
    });
    return click_and_verify_progression(
      candidate,
      deterministic_control,
      [],
      options.seenStateFingerprints,
      options.deepDebug,
    );
  }

  const page_intelligence =
    options.pageIntelligence ??
    (await options.ensurePageIntelligence?.().catch(() => undefined));
  if (!page_intelligence) {
    return {
      progressed: false,
      messageAvailable: false,
      reason: "multi-step form had no safe non-submit progression control",
      aiActions: [],
    };
  }

  return observe_and_advance_with_page_intelligence(
    page_intelligence,
    candidate,
    redactionValues,
    options.seenStateFingerprints,
    options.deepDebug,
  );
}

async function observe_and_advance_with_page_intelligence(
  page_intelligence: PageIntelligence,
  candidate: ContactFormCandidate,
  redaction_values: string[],
  seen_state_fingerprints?: Set<string>,
  deep_debug?: DeepDebugContext,
): Promise<ContactFormProgressionResult> {
  const instruction = [
    "Locate one visible non-submit control inside the selected multi-step contact form whose exact purpose is Next, Continue, or Proceed. The visible interface may be in English, Hebrew, or a mixture of both languages.",
    "Return one click action with no arguments.",
    "Do not select Send, Submit, Request, Book, Finish, CAPTCHA, consent, navigation, or any control outside the selected form.",
  ].join(" ");
  const ai_actions: AiActionEvidence[] = [];
  let scope:
    | Awaited<ReturnType<typeof create_page_intelligence_scope>>
    | undefined;
  try {
    scope = await create_page_intelligence_scope(candidate.form);
    const scope_selector = scope.selector;
    let observation: PageIntelligenceObserveResult;
    const started_at = Date.now();
    try {
      observation = await with_masked_page_values(
        candidate.frame.page(),
        redaction_values,
        () =>
          page_intelligence.observe({
            stage: "population",
            page: candidate.frame.page(),
            instruction,
            selector: scope_selector,
            ignoreSelectors: [CAPTCHA_SELECTOR],
            timeoutMs: AI_OBSERVE_TIMEOUT_MS,
          }),
      );
    } catch (error) {
      ai_actions.push(
        create_ai_operation_evidence({
          stage: "population",
          placeholderInstruction: instruction,
          method: "observe",
          model: page_intelligence.model,
          durationMs: Date.now() - started_at,
          acceptanceReason: "Stagehand progression observation failed",
          result: "failed",
        }),
      );
      return {
        progressed: false,
        messageAvailable: false,
        reason: `Stagehand progression observation failed: ${describe_error(error)}`,
        aiActions: ai_actions,
      };
    }

    if (observation.actions.length === 0) {
      ai_actions.push(
        create_ai_operation_evidence({
          stage: "population",
          placeholderInstruction: instruction,
          method: "observe",
          model: observation.model,
          durationMs: observation.durationMs,
          acceptanceReason:
            "Stagehand returned no safe multi-step progression action",
          result: "observed",
        }),
      );
      return {
        progressed: false,
        messageAvailable: false,
        reason: "Stagehand returned no safe multi-step progression action",
        aiActions: ai_actions,
      };
    }

    for (const action of observation.actions) {
      const validation = await validate_progression_action(candidate, action);
      const evidence: AiActionEvidence = {
        stage: "population",
        placeholderInstruction: instruction,
        selector: action.selector,
        method: action.method,
        acceptance: validation.control ? "accepted" : "rejected",
        acceptanceReason:
          validation.reason ?? "approved non-submit progression control",
        result: validation.control ? "observed" : "notRun",
        model: observation.model,
        durationMs: observation.durationMs,
        argumentCount: action.arguments?.length ?? 0,
      };
      const evidence_index = ai_actions.push(evidence) - 1;
      if (!validation.control) {
        continue;
      }

      const result = await click_and_verify_progression(
        candidate,
        validation.control,
        ai_actions,
        seen_state_fingerprints,
        deep_debug,
      );
      ai_actions[evidence_index] = {
        ...ai_actions[evidence_index]!,
        result: result.progressed ? "succeeded" : "failed",
        ...(result.progressed ? {} : { resultMessage: result.reason }),
      };
      return { ...result, aiActions: ai_actions };
    }

    return {
      progressed: false,
      messageAvailable: false,
      reason: "Stagehand returned only invalid progression selectors",
      aiActions: ai_actions,
    };
  } finally {
    await scope?.close().catch(() => undefined);
  }
}

async function validate_progression_action(
  candidate: ContactFormCandidate,
  action: PageIntelligenceAction,
): Promise<{ control?: Locator; reason?: string }> {
  if (action.method.trim().toLowerCase() !== "click") {
    return { reason: "only click actions may advance a multi-step form" };
  }
  if ((action.arguments?.length ?? 0) !== 0) {
    return { reason: "multi-step progression clicks may not contain arguments" };
  }
  if (!action.selector.trim()) {
    return { reason: "the progression action had no selector" };
  }
  if (await selector_targets_captcha(candidate.frame.page(), action.selector)) {
    return { reason: "the progression selector targeted a CAPTCHA control" };
  }
  let candidates: Locator;
  try {
    candidates = candidate.frame.locator(action.selector);
  } catch {
    return { reason: "the progression selector was invalid" };
  }
  const control = await find_safe_progression_control(candidate, candidates);
  return control
    ? { control }
    : {
        reason:
          "selector did not resolve to a safe non-submit Next, Continue, or Proceed control inside the selected form",
      };
}

async function find_safe_progression_control(
  candidate: ContactFormCandidate,
  candidates: Locator,
): Promise<Locator | undefined> {
  const count = Math.min(await candidates.count().catch(() => 0), 20);
  for (let index = 0; index < count; index += 1) {
    const control = candidates.nth(index);
    const state = await control
      .evaluate((element) => {
        const html = element as HTMLElement;
        const input = element as HTMLInputElement;
        const tag = element.tagName.toLowerCase();
        return {
          tag,
          type: element.getAttribute("type")?.toLowerCase() ?? "",
          role: element.getAttribute("role")?.toLowerCase() ?? "",
          href: element.getAttribute("href") ?? "",
          disabled:
            input.disabled || element.getAttribute("aria-disabled") === "true",
          label: [
            html.innerText,
            input.value,
            element.getAttribute("aria-label"),
            element.getAttribute("title"),
          ]
            .filter(Boolean)
            .join(" ")
            .trim()
            .replace(/\s+/g, " "),
        };
      })
      .catch(() => undefined);
    if (
      !state ||
      state.disabled ||
      state.href ||
      !EXACT_PROGRESSION_LABEL.test(state.label)
    ) {
      continue;
    }
    const explicit_non_submit =
      (state.tag === "button" && state.type === "button") ||
      (state.tag === "input" && state.type === "button") ||
      (state.tag !== "button" && state.tag !== "input" && state.role === "button");
    if (!explicit_non_submit) {
      continue;
    }
    const safe =
      (await control.isVisible().catch(() => false)) &&
      (await control.isEnabled().catch(() => false)) &&
      (await locator_is_inside(candidate.form, control)) &&
      !(await control
        .evaluate(
          (element, selector) =>
            element.matches(selector) || Boolean(element.closest(selector)),
          CAPTCHA_SELECTOR,
        )
        .catch(() => true)) &&
      (await geometry_is_stable(control));
    if (safe) {
      return control;
    }
  }
  return undefined;
}

async function click_and_verify_progression(
  candidate: ContactFormCandidate,
  control: Locator,
  ai_actions: AiActionEvidence[],
  seen_state_fingerprints?: Set<string>,
  deep_debug?: DeepDebugContext,
): Promise<ContactFormProgressionResult> {
  const page = candidate.frame.page();
  const origin_before = safe_origin(page.url());
  const fingerprint_before = await form_state_fingerprint(candidate.form);
  deep_debug?.record({
    stage: "population",
    substage: "progression-click",
    operation: "click-and-verify-progression",
    outcome: "started",
    url: page.url(),
    frameUrl: candidate.frame.url(),
    data: {
      fingerprintLengthBefore: fingerprint_before.length,
      previouslySeen: seen_state_fingerprints?.has(fingerprint_before) ?? false,
    },
  });
  if (fingerprint_before) {
    seen_state_fingerprints?.add(fingerprint_before);
  }
  const non_get_requests: Request[] = [];
  const request_listener = (request: Request): void => {
    if (
      request.method() !== "GET" &&
      ["document", "fetch", "xhr"].includes(request.resourceType())
    ) {
      non_get_requests.push(request);
    }
  };
  page.on("request", request_listener);
  try {
    await control.click({ timeout: ACTION_TIMEOUT_MS });
    const fingerprint_after = await wait_for_changed_form_state(
      candidate.form,
      fingerprint_before,
    );
    if (safe_origin(page.url()) !== origin_before) {
      return progression_failure(
        "multi-step progression navigated outside the allowed origin",
        ai_actions,
      );
    }
    if (non_get_requests.length > 0) {
      return progression_failure(
        "multi-step progression triggered a network submission request",
        ai_actions,
      );
    }
    if (!fingerprint_after) {
      return progression_failure(
        "multi-step progression control produced no form-state change",
        ai_actions,
      );
    }
    if (seen_state_fingerprints?.has(fingerprint_after)) {
      return progression_failure(
        "multi-step progression repeated a previously observed form state",
        ai_actions,
      );
    }
    seen_state_fingerprints?.add(fingerprint_after);

    const assessment = await assess_contact_form(candidate.form);
    candidate.score = assessment.score;
    candidate.classification = assessment.classification === "rejected"
      ? "progression"
      : assessment.classification;
    candidate.messageDisposition = assessment.messageDisposition;
    deep_debug?.record({
      stage: "population",
      substage: "progression-click",
      operation: "click-and-verify-progression",
      outcome: "succeeded",
      url: page.url(),
      frameUrl: candidate.frame.url(),
      data: {
        fingerprintLengthBefore: fingerprint_before.length,
        fingerprintLengthAfter: fingerprint_after.length,
        stateChanged: fingerprint_after !== fingerprint_before,
        nonGetRequestCount: non_get_requests.length,
        assessment,
      },
    });
    return {
      progressed: true,
      messageAvailable: assessment.signals.hasMessage,
      reason: assessment.signals.hasMessage
        ? "multi-step progression revealed a message field"
        : "multi-step progression advanced to another incomplete step",
      aiActions: ai_actions,
    };
  } catch (error) {
    return progression_failure(
      `multi-step progression click failed: ${describe_error(error)}`,
      ai_actions,
    );
  } finally {
    page.off("request", request_listener);
  }
}

function progression_failure(
  reason: string,
  ai_actions: AiActionEvidence[],
): ContactFormProgressionResult {
  return {
    progressed: false,
    messageAvailable: false,
    reason,
    aiActions: ai_actions,
  };
}

async function geometry_is_stable(locator: Locator): Promise<boolean> {
  const first = await locator.boundingBox().catch(() => null);
  if (!first) return false;
  await locator.page().waitForTimeout(150);
  const second = await locator.boundingBox().catch(() => null);
  return Boolean(
    second &&
      Math.abs(first.x - second.x) < 1 &&
      Math.abs(first.y - second.y) < 1 &&
      Math.abs(first.width - second.width) < 1 &&
      Math.abs(first.height - second.height) < 1,
  );
}

async function form_state_fingerprint(form: Locator): Promise<string> {
  const form_metadata = await form
    .evaluate((element) =>
      [
        element.id,
        element.getAttribute("class"),
        element.getAttribute("data-step"),
        element.getAttribute("data-current-step"),
        element.getAttribute("aria-current"),
      ]
        .filter(Boolean)
        .join("|"),
    )
    .catch(() => "");
  const controls = form.locator([
    "input:visible",
    "textarea:visible",
    "select:visible",
    "button:visible",
    '[role="button"]:visible',
    '[contenteditable="true"]:visible',
  ].join(", "));
  const control_metadata = await controls
    .evaluateAll((elements) =>
      elements.map((control) =>
        [
          control.tagName.toLowerCase(),
          control.getAttribute("type"),
          control.getAttribute("name"),
          control.id,
          control.getAttribute("placeholder"),
          control.getAttribute("aria-label"),
          (control.textContent ?? "").trim().replace(/\s+/g, " "),
        ]
          .filter(Boolean)
          .join("|"),
      ),
    )
    .catch(() => []);
  return [form_metadata, ...control_metadata].join("\n");
}

async function wait_for_changed_form_state(
  form: Locator,
  before: string,
): Promise<string | undefined> {
  const deadline = Date.now() + STATE_CHANGE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const current = await form_state_fingerprint(form);
    if (current && current !== before) {
      return current;
    }
    await form.page().waitForTimeout(100);
  }
  return undefined;
}

async function locator_is_inside(root: Locator, target: Locator): Promise<boolean> {
  const root_handle = await root.elementHandle().catch(() => null);
  const target_handle = await target.elementHandle().catch(() => null);
  if (!root_handle || !target_handle) {
    await root_handle?.dispose().catch(() => undefined);
    await target_handle?.dispose().catch(() => undefined);
    return false;
  }
  try {
    return await root_handle.evaluate(
      (element, candidate) => element === candidate || element.contains(candidate),
      target_handle,
    );
  } catch {
    return false;
  } finally {
    await root_handle.dispose().catch(() => undefined);
    await target_handle.dispose().catch(() => undefined);
  }
}

async function normalize_to_form(locator: Locator): Promise<Locator | undefined> {
  const tag = await locator
    .evaluate((element) => element.tagName.toLowerCase())
    .catch(() => "");
  if (tag === "form") return locator;
  const ancestor = locator.locator("xpath=ancestor::form[1]");
  return (await ancestor.count().catch(() => 0)) > 0
    ? ancestor.first()
    : undefined;
}

async function locators_reference_same_element(
  left: Locator,
  right: Locator,
): Promise<boolean> {
  const left_handle = await left.elementHandle().catch(() => null);
  const right_handle = await right.elementHandle().catch(() => null);
  if (!left_handle || !right_handle) {
    await left_handle?.dispose().catch(() => undefined);
    await right_handle?.dispose().catch(() => undefined);
    return false;
  }
  try {
    return await left_handle.evaluate(
      (element, other) => element === other,
      right_handle,
    );
  } catch {
    return false;
  } finally {
    await left_handle.dispose().catch(() => undefined);
    await right_handle.dispose().catch(() => undefined);
  }
}

function safe_origin(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return "";
  }
}
