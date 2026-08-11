import type { Locator } from "playwright";
import {
  SUBMIT_GEOMETRY_SAMPLE_COUNT,
  SUBMIT_GEOMETRY_SAMPLE_INTERVAL_MS,
  SUBMIT_LAYOUT_SETTLE_MS,
  SUBMIT_PREFLIGHT_ATTEMPTS,
} from "../../../../shared_files_orchestrator/outreach_constants_(Support).js";
import type {
  ContactFormCandidate,
  PageObstructionAction,
} from "../../shared_files_forms/forms_types_(Support).js";
import type { DeepDebugContext } from "../../shared_files_forms/deep_debug_types_(Support).js";
import { dismiss_cookie_obstructions } from "../../../../shared_files_orchestrator/page_obstructions_(Deterministic).js";
import type {
  SubmitCandidateDebugInfo,
  SubmitControlSearchResult,
  SubmitHitTestReceiver,
} from "./C2_submission_types_(Support).js";

/*
 * TOP LEVEL WORKFLOW:
 *
 * find_submit_control(candidate)
 *        |
 *        v
 * apply the structural submit strategy
 *        |
 *        v
 * score generic submit candidates
 */

/*
 * ========================================================================
 * TOP_LEVEL_WORKFLOW_FUNCTIONS
 * ========================================================================
 */

/*
 * ========================================================================
 * SUBMIT CONTROL SELECTION - find_submit_control(...)
 * ========================================================================
 * Input:  A populated contact-form candidate.
 * Output: The selected submit control or a reason none was found.
 *
 * Responsibility: Choose the safest submit-like control using the candidate
 * structure and generic scoring without performing the click.
 * ========================================================================
 */
export async function find_submit_control(
  candidate: ContactFormCandidate,
): Promise<SubmitControlSearchResult> {
  if (candidate.structure === "formLikeContainer") {
    const valid_non_native_container = await candidate.form
      .evaluate(
        (element) =>
          !element.closest("form") && !element.querySelector("form"),
      )
      .catch(() => false);
    if (!valid_non_native_container) {
      return {
        reason: "form-like submit strategy requires a validated non-native container",
        strategy: "sendLikeControl",
      };
    }
    return find_send_like_submit_control(candidate.form);
  }

  return find_generic_submit_control(candidate.form);
}

export async function prepare_submit_control(
  candidate: ContactFormCandidate,
  deep_debug?: DeepDebugContext,
): Promise<{
  result: SubmitControlSearchResult;
  obstructionActions: PageObstructionAction[];
}> {
  const page = candidate.frame.page();
  const obstruction_actions: PageObstructionAction[] = [];
  let remaining_cookie_actions = 3;
  const initial_obstructions = await dismiss_cookie_obstructions(
    page,
    undefined,
    remaining_cookie_actions,
  );
  obstruction_actions.push(...initial_obstructions);
  remaining_cookie_actions -= initial_obstructions.length;

  let result: SubmitControlSearchResult = {
    reason: "no enabled submit control was found",
  };
  for (let attempt = 0; attempt < SUBMIT_PREFLIGHT_ATTEMPTS; attempt += 1) {
    result = await find_submit_control(candidate);
    deep_debug?.record({
      stage: "submission",
      substage: "preflight",
      operation: "resolve-submit-control",
      outcome: result.control ? "succeeded" : "blocked",
      correlationId: `preflight-${attempt + 1}`,
      reason: result.reason || undefined,
      data: {
        attempt: attempt + 1,
        strategy: result.strategy ?? null,
        selector: result.selector ?? null,
        selectedIndex: result.selectedIndex ?? null,
        score: result.score ?? null,
        candidates: result.candidates ?? [],
      },
    });
    if (!result.control) {
      return { result, obstructionActions: obstruction_actions };
    }

    await result.control.scrollIntoViewIfNeeded().catch(() => undefined);
    await page.waitForTimeout(SUBMIT_LAYOUT_SETTLE_MS).catch(() => undefined);

    const targeted_obstructions =
      remaining_cookie_actions > 0
        ? await dismiss_cookie_obstructions(
            page,
            result.control,
            remaining_cookie_actions,
          )
        : [];
    if (targeted_obstructions.length > 0) {
      obstruction_actions.push(...targeted_obstructions);
      remaining_cookie_actions -= targeted_obstructions.length;
      deep_debug?.record({
        stage: "submission",
        substage: "preflight",
        operation: "dismiss-targeted-obstruction",
        outcome: targeted_obstructions.some((action) => action.cleared)
          ? "succeeded"
          : "failed",
        correlationId: `preflight-${attempt + 1}`,
        data: {
          actions: targeted_obstructions,
          remainingCookieActions: remaining_cookie_actions,
        },
      });
      continue;
    }

    // Re-resolve after scrolling and obstruction handling so preflight verifies
    // the same current-DOM candidate that will be clicked.
    result = await find_submit_control(candidate);
    if (!result.control) {
      return { result, obstructionActions: obstruction_actions };
    }
    await result.control.scrollIntoViewIfNeeded().catch(() => undefined);

    const actionability = await inspect_submit_actionability(
      result.control,
      deep_debug,
      attempt + 1,
    );
    deep_debug?.record({
      stage: "submission",
      substage: "preflight",
      operation: "inspect-submit-actionability",
      outcome: actionability.reason ? "blocked" : "succeeded",
      correlationId: `preflight-${attempt + 1}`,
      reason: actionability.reason,
      data: { attempt: attempt + 1, receiver: actionability.receiver ?? null },
    });
    if (!actionability.reason) {
      return { result, obstructionActions: obstruction_actions };
    }

    // A geometry change may settle on the next pass. A real non-cookie
    // interceptor is terminal unless cookie handling can remove it.
    if (actionability.receiver) {
      const recovered_obstructions =
        remaining_cookie_actions > 0
          ? await dismiss_cookie_obstructions(
              page,
              result.control,
              remaining_cookie_actions,
            )
          : [];
      if (recovered_obstructions.length > 0) {
        obstruction_actions.push(...recovered_obstructions);
        remaining_cookie_actions -= recovered_obstructions.length;
        continue;
      }
      return {
        result: preflight_failure(
          result,
          actionability.reason,
          actionability.receiver,
        ),
        obstructionActions: obstruction_actions,
      };
    }

    if (attempt === SUBMIT_PREFLIGHT_ATTEMPTS - 1) {
      return {
        result: preflight_failure(result, actionability.reason),
        obstructionActions: obstruction_actions,
      };
    }
  }

  return {
    result: preflight_failure(result, "submit preflight did not stabilize"),
    obstructionActions: obstruction_actions,
  };
}

export async function submit_actionability_failure_reason(
  control: Locator,
): Promise<string | undefined> {
  return (await inspect_submit_actionability(control)).reason;
}

async function inspect_submit_actionability(
  control: Locator,
  deep_debug?: DeepDebugContext,
  attempt?: number,
): Promise<{ reason?: string; receiver?: SubmitHitTestReceiver }> {
  await control.scrollIntoViewIfNeeded().catch(() => undefined);
  if (!(await has_stable_geometry(control, deep_debug, attempt))) {
    return {
      reason: "submit control geometry did not stabilize before activation",
    };
  }
  const hit_test = await hit_test_submit_control(control);
  deep_debug?.record({
    stage: "submission",
    substage: "preflight-hit-test",
    operation: "element-from-point",
    outcome: hit_test.receivesPointer ? "succeeded" : "blocked",
    correlationId: attempt ? `preflight-${attempt}` : undefined,
    data: hit_test,
  });
  if (!hit_test.receivesPointer) {
    return {
      reason: hit_test.receiver
        ? `another page element intercepted the submit control (${describe_hit_test_receiver(hit_test.receiver)})`
        : "another page element intercepted the submit control",
      ...(hit_test.receiver ? { receiver: hit_test.receiver } : {}),
    };
  }
  return {};
}

function preflight_failure(
  result: SubmitControlSearchResult,
  reason: string,
  receiver?: SubmitHitTestReceiver,
): SubmitControlSearchResult {
  const { control: _control, ...remaining } = result;
  return {
    ...remaining,
    preflightBlocked: true,
    reason,
    ...(receiver ? { preflightInterceptor: receiver } : {}),
  };
}

async function has_stable_geometry(
  control: Locator,
  deep_debug?: DeepDebugContext,
  attempt?: number,
): Promise<boolean> {
  let previous = await control.boundingBox().catch(() => null);
  const samples = [previous];
  if (!previous) return false;
  for (let sample = 1; sample < SUBMIT_GEOMETRY_SAMPLE_COUNT; sample += 1) {
    await control
      .page()
      .waitForTimeout(SUBMIT_GEOMETRY_SAMPLE_INTERVAL_MS)
      .catch(() => undefined);
    const current = await control.boundingBox().catch(() => null);
    samples.push(current);
    if (!current) return false;
    const stable = ["x", "y", "width", "height"].every(
      (key) =>
        Math.abs(
          previous![key as keyof typeof previous] -
            current[key as keyof typeof current],
        ) <= 2,
    );
    if (!stable) {
      deep_debug?.record({
        stage: "submission",
        substage: "preflight-geometry",
        operation: "sample-submit-geometry",
        outcome: "blocked",
        correlationId: attempt ? `preflight-${attempt}` : undefined,
        reason: "geometry changed between samples",
        data: { samples },
      });
      return false;
    }
    previous = current;
  }
  deep_debug?.record({
    stage: "submission",
    substage: "preflight-geometry",
    operation: "sample-submit-geometry",
    outcome: "succeeded",
    correlationId: attempt ? `preflight-${attempt}` : undefined,
    data: { samples },
  });
  return true;
}

async function hit_test_submit_control(control: Locator): Promise<{
  receivesPointer: boolean;
  receiver?: SubmitHitTestReceiver;
}> {
  return control
    .evaluate((element) => {
      const rectangle = element.getBoundingClientRect();
      if (rectangle.width <= 0 || rectangle.height <= 0) {
        return { receivesPointer: false };
      }
      const receiver = document.elementFromPoint(
        rectangle.left + rectangle.width / 2,
        rectangle.top + rectangle.height / 2,
      );
      if (receiver && (receiver === element || element.contains(receiver))) {
        return { receivesPointer: true };
      }
      if (!(receiver instanceof HTMLElement)) {
        return { receivesPointer: false };
      }
      return {
        receivesPointer: false,
        receiver: {
          tag: receiver.tagName.toLowerCase(),
          id: receiver.id,
          className:
            typeof receiver.className === "string" ? receiver.className : "",
          text: (receiver.innerText || receiver.textContent || "")
            .trim()
            .replace(/\s+/g, " ")
            .slice(0, 120),
        },
      };
    })
    .catch(() => ({ receivesPointer: false }));
}

function describe_hit_test_receiver(receiver: SubmitHitTestReceiver): string {
  const identity = [
    receiver.tag,
    receiver.id ? `#${receiver.id}` : "",
    receiver.className
      ? `.${receiver.className.trim().replace(/\s+/g, ".")}`
      : "",
  ].join("");
  return receiver.text ? `${identity}: ${receiver.text}` : identity;
}

/*
 * ========================================================================
 * STEP_LEVEL_HELPER_FUNCTIONS
 * ========================================================================
 *
 * find_generic_submit_control(...)      - Score real-world button candidates.
 * describe_submit_candidate(...)        - Capture candidate evidence.
 * score_submit_candidate(...)           - Rank candidate labels/types.
 * compare_submit_candidates(...)        - Sort score and field proximity.
 * find_send_like_submit_control(...)    - Select controls for form-like containers.
 * find_last_fillable_field_bottom(...)  - Locate form fields for tie-breaking.
 * ========================================================================
 */

async function find_generic_submit_control(
  form: Locator,
): Promise<SubmitControlSearchResult> {
  const selector = [
    'button[type="submit"]',
    'input[type="submit"]',
    'button[type="button"]',
    'input[type="button"]',
    "button:not([type])",
    '[role="button"]',
    "a[href]",
  ].join(", ");
  const controls = form.locator(selector);
  const field_bottom = await find_last_fillable_field_bottom(form);
  const candidates: Array<{
    control: Locator;
    evidence: SubmitCandidateDebugInfo;
  }> = [];

  for (let index = 0; index < (await controls.count()); index += 1) {
    const control = controls.nth(index);
    const evidence = await describe_submit_candidate(
      control,
      index,
      selector,
      field_bottom,
    );
    candidates.push({ control, evidence });
  }

  const ranked = candidates
    .filter(
      (candidate) =>
        candidate.evidence.visible &&
        candidate.evidence.enabled &&
        candidate.evidence.score > 0,
    )
    .sort(compare_submit_candidates);

  const selected = ranked[0];
  for (const candidate of candidates) {
    candidate.evidence.selected = selected?.evidence.index === candidate.evidence.index;
    candidate.evidence.reason = candidate.evidence.selected
      ? "selected as the highest scoring visible enabled submit candidate"
      : submit_candidate_rejection_reason(candidate.evidence);
  }

  return selected
    ? {
        control: selected.control,
        reason: "",
        strategy: "genericSubmitControl",
        selector,
        selectedIndex: selected.evidence.index,
        score: selected.evidence.score,
        candidates: candidates.map((candidate) => candidate.evidence),
      }
    : {
        reason: "no enabled submit control was found",
        strategy: "genericSubmitControl",
        selector,
        candidates: candidates.map((candidate) => candidate.evidence),
      };
}

async function describe_submit_candidate(
  control: Locator,
  index: number,
  selector: string,
  field_bottom: number | null,
): Promise<SubmitCandidateDebugInfo> {
  const element_info = await control.evaluate((element) => {
    const html_element = element as HTMLElement;
    return {
      tag: element.tagName.toLowerCase(),
      type: element.getAttribute("type") ?? "",
      text: (html_element.innerText || element.textContent || "")
        .trim()
        .replace(/\s+/g, " "),
      value: element.getAttribute("value") ?? "",
      name: element.getAttribute("name") ?? "",
      id: html_element.id,
      ariaLabel: element.getAttribute("aria-label") ?? "",
      title: element.getAttribute("title") ?? "",
      href: element.getAttribute("href") ?? "",
      className:
        typeof html_element.className === "string" ? html_element.className : "",
    };
  });
  const [visible, enabled, bounding_box] = await Promise.all([
    control.isVisible().catch(() => false),
    control.isEnabled().catch(() => false),
    control.boundingBox().catch(() => null),
  ]);
  const score = score_submit_candidate(element_info);

  return {
    index,
    selector,
    ...element_info,
    visible,
    enabled,
    score: score.value,
    positiveSignals: score.positiveSignals,
    negativeSignals: score.negativeSignals,
    afterFieldDistance: distance_after_fields(bounding_box, field_bottom),
    selected: false,
    reason: "",
    boundingBox: bounding_box,
  };
}

function score_submit_candidate(candidate: {
  tag: string;
  type: string;
  text: string;
  value: string;
  name: string;
  id: string;
  ariaLabel: string;
  title: string;
  href: string;
  className: string;
}): {
  value: number;
  positiveSignals: string[];
  negativeSignals: string[];
} {
  let value = 0;
  const positiveSignals: string[] = [];
  const negativeSignals: string[] = [];
  const label = normalize_submit_candidate_label(
    [
      candidate.text,
      candidate.value,
      candidate.ariaLabel,
      candidate.title,
      candidate.name,
      candidate.id,
    ].join(" "),
  );
  const metadata = normalize_submit_candidate_label(
    `${label} ${candidate.className}`,
  );
  const type = candidate.type.toLowerCase();

  if (candidate.tag === "a") {
    const explicitly_submits = /\b(send|submit)\b/.test(label);
    const non_navigational = is_non_navigational_href(candidate.href);
    if (!explicitly_submits || !non_navigational) {
      negativeSignals.push(
        !explicitly_submits
          ? "anchor lacks explicit send/submit semantics"
          : "anchor navigates away from the form",
      );
      return { value: 0, positiveSignals, negativeSignals };
    }
  }

  if (/^(submit|send|send message|send request|send inquiry|send lead)$/.test(label)) {
    value += 100;
    positiveSignals.push("exact submit/send label");
  } else if (/\b(submit|send)\b/.test(label)) {
    value += 70;
    positiveSignals.push("submit/send label");
  }

  if (type === "submit") {
    value += 200;
    positiveSignals.push("native submit type");
  }

  if (/\b(contact|request|get in touch)\b/.test(label)) {
    value += 20;
    positiveSignals.push("contact/request label");
  }

  if (type === "button") {
    value += 5;
    positiveSignals.push("button type control");
  }

  if (/\b(schedule|meeting|demo|book|download|extension|learn more|pricing)\b/.test(metadata)) {
    value -= 80;
    negativeSignals.push("secondary CTA label");
  }

  return { value, positiveSignals, negativeSignals };
}

function is_non_navigational_href(href: string): boolean {
  const normalized = href.trim().toLowerCase();
  return (
    normalized === "" ||
    normalized === "#" ||
    normalized.startsWith("#") ||
    normalized.startsWith("javascript:")
  );
}

function compare_submit_candidates(
  left: { evidence: SubmitCandidateDebugInfo },
  right: { evidence: SubmitCandidateDebugInfo },
): number {
  return (
    right.evidence.score - left.evidence.score ||
    compare_nullable_distance(
      left.evidence.afterFieldDistance,
      right.evidence.afterFieldDistance,
    ) ||
    left.evidence.index - right.evidence.index
  );
}

function compare_nullable_distance(
  left: number | null,
  right: number | null,
): number {
  if (left === null && right === null) {
    return 0;
  }
  if (left === null) {
    return 1;
  }
  if (right === null) {
    return -1;
  }
  return left - right;
}

function submit_candidate_rejection_reason(
  candidate: SubmitCandidateDebugInfo,
): string {
  if (!candidate.visible) {
    return "rejected because it is not visible";
  }
  if (!candidate.enabled) {
    return "rejected because it is not enabled";
  }
  if (candidate.score <= 0) {
    return "rejected because score did not pass the submit threshold";
  }
  return "rejected because another candidate ranked higher";
}

async function find_last_fillable_field_bottom(form: Locator): Promise<number | null> {
  return form
    .locator(
      'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]), textarea, select',
    )
    .evaluateAll((elements) => {
      const bottoms = elements
        .map((element) => {
          const rectangle = element.getBoundingClientRect();
          return rectangle.width > 0 && rectangle.height > 0
            ? rectangle.y + rectangle.height
            : null;
        })
        .filter((bottom): bottom is number => bottom !== null);
      return bottoms.length > 0 ? Math.max(...bottoms) : null;
    })
    .catch(() => null);
}

function distance_after_fields(
  bounding_box: SubmitCandidateDebugInfo["boundingBox"],
  field_bottom: number | null,
): number | null {
  if (!bounding_box || field_bottom === null) {
    return null;
  }

  if (bounding_box.y + bounding_box.height >= field_bottom - 4) {
    return Math.max(0, bounding_box.y - field_bottom);
  }

  return 1_000_000 + Math.abs(field_bottom - bounding_box.y);
}

function normalize_submit_candidate_label(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

async function find_send_like_submit_control(
  form: Locator,
): Promise<SubmitControlSearchResult> {
  const selector = 'button, input[type="submit"], input[type="button"], [role="button"], a';
  const controls = form.locator(selector);
  const ranked: Array<{ control: Locator; score: number; index: number }> = [];

  for (let index = 0; index < (await controls.count()); index += 1) {
    const control = controls.nth(index);
    if (!(await control.isVisible()) || !(await control.isEnabled())) {
      continue;
    }

    const metadata = normalize_submit_candidate_label(
      `${(await control.textContent()) ?? ""} ${(await control.getAttribute("value")) ?? ""} ${(await control.getAttribute("aria-label")) ?? ""} ${(await control.getAttribute("title")) ?? ""}`
    );
    const tag = await control.evaluate((element) =>
      element.tagName.toLowerCase(),
    );
    const type = ((await control.getAttribute("type")) ?? "").toLowerCase();
    const href = (await control.getAttribute("href")) ?? "";
    if (
      tag === "a" &&
      (!/\b(send|submit)\b/.test(metadata) || !is_non_navigational_href(href))
    ) {
      continue;
    }
    let score = /\b(send|submit)\b/.test(metadata)
      ? 100
      : /\b(request|get in touch)\b/.test(metadata)
        ? 30
        : 0;
    if (type === "submit") {
      score += 200;
    } else if (tag === "button" || type === "button") {
      score += 20;
    }
    if (score > 0) {
      ranked.push({ control, score, index });
    }
  }

  ranked.sort((left, right) => right.score - left.score);
  return ranked[0]
    ? {
        control: ranked[0].control,
        reason: "",
        strategy: "sendLikeControl",
        selector,
        selectedIndex: ranked[0].index,
        score: ranked[0].score,
      }
    : {
        reason: "form-like container submit control was not found",
        strategy: "sendLikeControl",
        selector,
      };
}
