import type { Frame, Locator, Page, Route } from "playwright";
import {
  AI_ACTION_TIMEOUT_MS,
  AI_OBSERVE_TIMEOUT_MS,
  MAX_AI_DISCOVERY_ACTIONS,
  NAVIGATION_TIMEOUT_MS,
} from "../../../../shared_files_orchestrator/outreach_constants_(Support).js";
import { create_ai_operation_evidence } from "../../../../shared_files_orchestrator/ai_observability_(Support).js";
import { describe_error } from "../../../../shared_files_orchestrator/outreach_errors_(Support).js";
import { wait_for_discovery_readiness } from "../../../../shared_files_orchestrator/discovery_readiness_(Deterministic).js";
import type {
  AiActionEvidence,
  BrowserSession,
  FormDiscoveryResult,
  ContactFormCandidate,
} from "../../shared_files_forms/forms_types_(Support).js";
import {
  CAPTCHA_SELECTOR,
  selector_targets_captcha,
} from "../../shared_files_forms/captcha_detection_(Deterministic).js";
import {
  assess_contact_form,
  type ContactFormAssessment,
} from "../../shared_files_forms/contact_form_intent_(Deterministic).js";
import { has_contact_route_intent } from "../../../../orchestrator/C_contact_routes/C2_contact_route_scoring_(Deterministic).js";
import { dismiss_cookie_obstruction } from "../../../../shared_files_orchestrator/page_obstructions_(Deterministic).js";
import type {
  PageIntelligence,
  PageIntelligenceAction,
  PageIntelligenceObserveResult,
} from "../../../../shared_files_orchestrator/page_intelligence_(Integration).js";
import {
  capture_discovery_interaction_state,
  type DiscoveryDebugCollector,
} from "./A3_discovery_observability_(Support).js";
import { recover_structurally_strong_rejected_form } from "./A5_stagehand_rejected_form_semantic_recovery_(LLM).js";

const DISCOVERY_INSTRUCTION = [
  "Locate one visible contact, inquiry, consultation, booking, quote, audit, project-start, or work-with-us form on the current page.",
  "If none is visible, locate one safe same-site navigation control most likely to reveal such a form.",
  "Return only an argument-free click action; a selector inside a form will be used only as locator evidence and will not be clicked.",
  "Do not submit a form, enter values, accept consent, solve CAPTCHA, download anything, or leave the current site intentionally.",
].join(" ");

interface ResolvedNavigationTarget {
  frame: Frame;
  locator: Locator;
  destination: string;
  normalization: string;
}

interface ActionClassification {
  formCandidate?: ContactFormCandidate;
  navigationTarget?: ResolvedNavigationTarget;
  normalizedAction: PageIntelligenceAction;
  normalization: string;
  reason: string;
  semanticRecoveryAttempted?: boolean;
  semanticAiActions?: AiActionEvidence[];
}

interface RejectedFormEvidence {
  form: Locator;
  frame: Frame;
  assessment: ContactFormAssessment;
}

interface FormResolution {
  candidate?: ContactFormCandidate;
  rejected?: RejectedFormEvidence;
}

interface SameOriginNavigationGuard {
  readonly blockedCount: number;
  close: () => Promise<void>;
}

/*
 * Bounded semantic fallback used only after deterministic discovery fails.
 * Stagehand proposes selectors. Playwright owns validation, normalization,
 * navigation, form assessment, and all browser interaction.
 */
export async function discover_contact_form_with_stagehand_fallback(
  browser_session: BrowserSession,
  deterministic_result: FormDiscoveryResult,
  rediscover_current_page: () => Promise<ContactFormCandidate | undefined>,
  collector?: DiscoveryDebugCollector,
): Promise<FormDiscoveryResult> {
  if (deterministic_result.candidate) {
    return deterministic_result;
  }
  const page_intelligence =
    browser_session.pageIntelligence ??
    (await browser_session.ensurePageIntelligence?.());
  if (!page_intelligence) {
    return deterministic_result;
  }

  const allowed_origin = url_origin(browser_session.page.url());
  if (!allowed_origin) {
    return discovery_failure(
      deterministic_result,
      "current page origin could not be validated for AI discovery",
      [],
    );
  }

  const navigation_guard = await install_same_origin_navigation_guard(
    browser_session.page,
    allowed_origin,
  );
  try {
    return await run_stagehand_discovery_fallback(
      browser_session,
      deterministic_result,
      rediscover_current_page,
      page_intelligence,
      allowed_origin,
      navigation_guard,
      collector,
    );
  } finally {
    await navigation_guard.close();
  }
}

async function run_stagehand_discovery_fallback(
  browser_session: BrowserSession,
  deterministic_result: FormDiscoveryResult,
  rediscover_current_page: () => Promise<ContactFormCandidate | undefined>,
  page_intelligence: PageIntelligence,
  allowed_origin: string,
  navigation_guard: SameOriginNavigationGuard,
  collector?: DiscoveryDebugCollector,
): Promise<FormDiscoveryResult> {
  const ai_actions: AiActionEvidence[] = [];
  const attempted_selectors = new Set<string>();
  const attempted_destinations = new Set<string>();
  let navigation_click_count = 0;
  let normal_observation_count = 0;
  let technical_retry_used = false;
  let semantic_recovery_used = false;
  const semantic_recovery_enabled = stagehand_semantic_recovery_enabled();
  let fallback_reason = "no safe contact form or navigation action was found";

  while (
    navigation_click_count < MAX_AI_DISCOVERY_ACTIONS &&
    normal_observation_count < MAX_AI_DISCOVERY_ACTIONS
  ) {
    if (!url_has_origin(browser_session.page.url(), allowed_origin)) {
      fallback_reason =
        "current page left the allowed origin before AI observation";
      break;
    }

    let observation: PageIntelligenceObserveResult;
    const observation_started_at = Date.now();
    try {
      observation = await page_intelligence.observe({
        stage: "discovery",
        page: browser_session.page,
        instruction: discovery_instruction_for_attempt(attempted_selectors),
        ignoreSelectors: [CAPTCHA_SELECTOR],
        timeoutMs: AI_OBSERVE_TIMEOUT_MS,
      });
    } catch (error) {
      const error_text = describe_error(error);
      const technical_failure = is_retryable_observation_failure(error_text);
      fallback_reason = technical_failure
        ? `invalid Stagehand output or observation timeout: ${error_text}`
        : `observation failed: ${error_text}`;
      ai_actions.push(
        create_ai_operation_evidence({
          stage: "discovery",
          placeholderInstruction: DISCOVERY_INSTRUCTION,
          method: "observe",
          model: page_intelligence.model,
          durationMs: Date.now() - observation_started_at,
          acceptanceReason: fallback_reason,
          result: "failed",
        }),
      );
      if (technical_failure && !technical_retry_used) {
        technical_retry_used = true;
        continue;
      }
      break;
    }
    normal_observation_count += 1;

    if (observation.actions.length === 0) {
      fallback_reason = "observation returned no candidate action";
      ai_actions.push(
        create_ai_operation_evidence({
          stage: "discovery",
          placeholderInstruction: DISCOVERY_INSTRUCTION,
          method: "observe",
          model: observation.model,
          durationMs: observation.durationMs,
          acceptanceReason: fallback_reason,
          result: "observed",
        }),
      );
      break;
    }

    const classifications: ActionClassification[] = [];
    for (const action of observation.actions) {
      classifications.push(
        await classify_discovery_action(
          browser_session.page,
          page_intelligence,
          action,
          attempted_selectors,
          attempted_destinations,
          allowed_origin,
          semantic_recovery_enabled && !semantic_recovery_used,
          collector,
        ),
      );
      const classification = classifications.at(-1);
      if (classification?.semanticRecoveryAttempted) {
        semantic_recovery_used = true;
      }
    }
    ai_actions.push(
      ...classifications.flatMap(
        (classification) => classification.semanticAiActions ?? [],
      ),
    );

    const form_index = classifications.findIndex(
      (classification) => classification.formCandidate !== undefined,
    );
    if (form_index >= 0) {
      record_rejected_discovery_actions(
        ai_actions,
        observation,
        classifications,
        form_index,
        collector,
      );
      const action = observation.actions[form_index];
      const classification = classifications[form_index];
      if (action && classification?.formCandidate) {
        const evidence = discovery_evidence(
          action,
          observation,
          "accepted",
          classification.reason,
          "observed",
          classification.normalization,
        );
        ai_actions.push(evidence);
        collector?.recordAiAction({
          selector: action.selector,
          argumentCount: action.arguments?.length ?? 0,
          normalization: classification.normalization,
          result: "accepted",
          reason: classification.reason,
        });
        return {
          contactPageFound: true,
          candidate: classification.formCandidate,
          aiActions: ai_actions,
        };
      }
    }

    const navigation_index = classifications.findIndex(
      (classification) => classification.navigationTarget !== undefined,
    );
    record_rejected_discovery_actions(
      ai_actions,
      observation,
      classifications,
      navigation_index,
      collector,
    );
    const action = observation.actions[navigation_index];
    const classification = classifications[navigation_index];
    const target = classification?.navigationTarget;
    if (navigation_index < 0 || !action || !classification || !target) {
      fallback_reason = classifications
        .map((item) => item.reason)
        .filter(Boolean)
        .join("; ");
      if (!fallback_reason) {
        fallback_reason = "observation returned no safe navigation action";
      }
      break;
    }

    attempted_selectors.add(action.selector);
    attempted_destinations.add(target.destination);
    const evidence_index =
      ai_actions.push(
        discovery_evidence(
          action,
          observation,
          "accepted",
          classification.reason,
          "observed",
          classification.normalization,
        ),
      ) - 1;
    const url_before_action = browser_session.page.url();
    const interaction_started_at = new Date().toISOString();
    const interaction_before = await capture_discovery_interaction_state(
      browser_session.page,
    );
    const blocked_navigation_count = navigation_guard.blockedCount;
    let click_succeeded = false;
    const click_started_at = Date.now();
    try {
      await target.locator.click({ timeout: AI_ACTION_TIMEOUT_MS });
      click_succeeded = true;
      navigation_click_count += 1;
      ai_actions[evidence_index] = {
        ...ai_actions[evidence_index]!,
        result: "succeeded",
        resultMessage: "Playwright completed the validated navigation click",
        durationMs:
          ai_actions[evidence_index]!.durationMs +
          (Date.now() - click_started_at),
      };
      collector?.recordRoute({
        url: target.destination,
        label: action.instruction,
        score: 0,
        result: "opened",
        reason: classification.normalization,
      });
      collector?.recordAiAction({
        selector: action.selector,
        argumentCount: action.arguments?.length ?? 0,
        normalization: classification.normalization,
        result: "accepted",
        reason: classification.reason,
      });
    } catch (error) {
      fallback_reason = `navigation action failed: ${describe_error(error)}`;
      ai_actions[evidence_index] = {
        ...ai_actions[evidence_index]!,
        result: "failed",
        resultMessage: fallback_reason,
        durationMs:
          ai_actions[evidence_index]!.durationMs +
          (Date.now() - click_started_at),
      };
      collector?.recordRoute({
        url: target.destination,
        label: action.instruction,
        score: 0,
        result: "failed",
        reason: fallback_reason,
      });
      collector?.recordAiAction({
        selector: action.selector,
        argumentCount: action.arguments?.length ?? 0,
        normalization: classification.normalization,
        result: "failed",
        reason: fallback_reason,
      });
    }

    await wait_for_discovery_readiness(browser_session.page);
    await dismiss_cookie_obstruction(browser_session.page);
    const interaction_after = await capture_discovery_interaction_state(
      browser_session.page,
    );
    collector?.recordInteraction({
      label: action.instruction,
      performedAt: interaction_started_at,
      before: interaction_before,
      after: interaction_after,
      pageStateChanged:
        interaction_before.url !== interaction_after.url ||
        interaction_before.visibleFormCount !== interaction_after.visibleFormCount ||
        interaction_before.visibleDialogCount !== interaction_after.visibleDialogCount ||
        interaction_before.frameCount !== interaction_after.frameCount,
    });
    if (
      navigation_guard.blockedCount > blocked_navigation_count ||
      !url_has_origin(browser_session.page.url(), allowed_origin)
    ) {
      fallback_reason =
        "validated control attempted cross-origin navigation; no further AI observation was allowed";
      ai_actions[evidence_index] = {
        ...ai_actions[evidence_index]!,
        result: "failed",
        resultMessage: fallback_reason,
      };
      await restore_page_after_unsafe_navigation(
        browser_session.page,
        url_before_action,
      );
      break;
    }

    let rediscovered_candidate: ContactFormCandidate | undefined;
    try {
      rediscovered_candidate = await rediscover_current_page();
    } catch (error) {
      fallback_reason = `deterministic rediscovery failed: ${describe_error(error)}`;
      continue;
    }
    if (rediscovered_candidate) {
      return {
        contactPageFound: true,
        candidate: rediscovered_candidate,
        aiActions: ai_actions,
      };
    }
    if (!click_succeeded) {
      continue;
    }
    fallback_reason =
      "validated navigation completed, but deterministic rediscovery found no contact form";
  }

  return discovery_failure(deterministic_result, fallback_reason, ai_actions);
}

function discovery_instruction_for_attempt(
  attempted_selectors: Set<string>,
): string {
  if (attempted_selectors.size === 0) {
    return DISCOVERY_INSTRUCTION;
  }
  return [
    DISCOVERY_INSTRUCTION,
    `Do not return these already-clicked selectors: ${[...attempted_selectors].join(", ")}.`,
    "Choose a different safe control or return no action.",
  ].join(" ");
}

async function classify_discovery_action(
  page: Page,
  page_intelligence: PageIntelligence,
  action: PageIntelligenceAction,
  attempted_selectors: Set<string>,
  attempted_destinations: Set<string>,
  allowed_origin: string,
  allow_semantic_recovery: boolean,
  collector?: DiscoveryDebugCollector,
): Promise<ActionClassification> {
  const argument_count = action.arguments?.length ?? 0;
  const { arguments: _ignored_arguments, ...normalized_action } = action;
  const argument_normalization =
    argument_count > 0
      ? `removed ${argument_count} irrelevant click argument${argument_count === 1 ? "" : "s"}`
      : "no click arguments required removal";
  const rejected = (reason: string): ActionClassification => ({
    normalizedAction: normalized_action,
    normalization: argument_normalization,
    reason,
  });

  if (action.method.trim().toLowerCase() !== "click") {
    return rejected("only click actions are allowed during discovery");
  }
  if (!action.selector.trim()) {
    return rejected("invalid Stagehand output: the action had no selector");
  }
  if (attempted_selectors.has(action.selector)) {
    return rejected("the observed selector was already attempted");
  }
  if (await selector_targets_captcha(page, action.selector)) {
    return rejected("the observed selector targeted a CAPTCHA control");
  }

  const form_resolution = await resolve_visible_form_candidate(
    page,
    action.selector,
    collector,
  );
  if (form_resolution.candidate) {
    return {
      formCandidate: form_resolution.candidate,
      normalizedAction: normalized_action,
      normalization: `${argument_normalization}; treated selector as form locator evidence`,
      reason: "selector resolved to a validated contact form",
    };
  }

  if (form_resolution.rejected && allow_semantic_recovery) {
    const semantic_recovery =
      await recover_structurally_strong_rejected_form({
        pageIntelligence: page_intelligence,
        page,
        frame: form_resolution.rejected.frame,
        form: form_resolution.rejected.form,
        assessment: form_resolution.rejected.assessment,
        observedSelector: action.selector,
      });
    if (semantic_recovery.candidate) {
      return {
        formCandidate: semantic_recovery.candidate,
        normalizedAction: normalized_action,
        normalization: `${argument_normalization}; treated selector as form locator evidence; semantically recovered rejected form`,
        reason: semantic_recovery.reason,
        semanticRecoveryAttempted: semantic_recovery.attempted,
        semanticAiActions: semantic_recovery.aiActions,
      };
    }
    if (semantic_recovery.attempted) {
      return {
        normalizedAction: normalized_action,
        normalization: `${argument_normalization}; treated selector as rejected-form locator evidence`,
        reason: semantic_recovery.reason,
        semanticRecoveryAttempted: true,
        semanticAiActions: semantic_recovery.aiActions,
      };
    }
  }

  if (
    form_resolution.rejected ||
    (await selector_resolves_inside_form(page, action.selector))
  ) {
    return rejected(
      "selector resolved inside a rejected form candidate and was not clicked",
    );
  }

  const resolved = await first_visible_locator(page, action.selector);
  if (!resolved) {
    return rejected("selector did not resolve to a visible element");
  }
  const normalized_target = await normalize_interactive_locator(resolved.locator);
  if (!normalized_target) {
    return rejected("target could not be normalized to a safe link or button");
  }
  const target_normalization =
    normalized_target === resolved.locator
      ? argument_normalization
      : `${argument_normalization}; resolved non-interactive child to nearest link/button ancestor`;
  const navigation_result = await validate_navigation_target(
    page,
    resolved.frame,
    normalized_target,
    allowed_origin,
  );
  if (!navigation_result.allowed) {
    return {
      normalizedAction: normalized_action,
      normalization: target_normalization,
      reason: navigation_result.reason,
    };
  }
  if (attempted_destinations.has(navigation_result.destination)) {
    return {
      normalizedAction: normalized_action,
      normalization: target_normalization,
      reason: "the observed destination was already attempted",
    };
  }
  return {
    navigationTarget: {
      frame: resolved.frame,
      locator: normalized_target,
      destination: navigation_result.destination,
      normalization: target_normalization,
    },
    normalizedAction: normalized_action,
    normalization: target_normalization,
    reason: "selector resolved to a safe visible same-origin contact route",
  };
}

async function resolve_visible_form_candidate(
  page: Page,
  selector: string,
  collector?: DiscoveryDebugCollector,
): Promise<FormResolution> {
  let first_rejected: RejectedFormEvidence | undefined;
  for (const frame of page.frames()) {
    let candidates: Locator;
    try {
      candidates = frame.locator(selector);
    } catch {
      continue;
    }
    const count = Math.min(await candidates.count().catch(() => 0), 10);
    for (let index = 0; index < count; index += 1) {
      const candidate = await normalize_form_locator(candidates.nth(index));
      if (!candidate || !(await candidate.isVisible().catch(() => false))) {
        continue;
      }
      const structure = await candidate
        .evaluate((element) =>
          element.tagName.toLowerCase() === "form"
            ? "nativeForm" as const
            : "formLikeContainer" as const
        )
        .catch(() => "formLikeContainer" as const);
      const assessment = await assess_contact_form(candidate);
      collector?.recordCandidate({
        url: page.url(),
        frameUrl: frame.url(),
        source: "stagehand",
        assessment,
      });
      if (!assessment.accepted || assessment.classification === "rejected") {
        const is_form = await candidate
          .evaluate((element) => element.tagName.toLowerCase() === "form")
          .catch(() => false);
        if (is_form && !first_rejected) {
          first_rejected = { form: candidate, frame, assessment };
        }
        continue;
      }
      return {
        candidate: {
          form: candidate,
          frame,
          score: assessment.score,
          source: "stagehand",
          structure,
          classification: assessment.classification,
          messageDisposition: assessment.messageDisposition,
        },
      };
    }
  }
  return first_rejected ? { rejected: first_rejected } : {};
}

async function normalize_form_locator(
  observed: Locator,
): Promise<Locator | undefined> {
  const tag_name = await observed
    .evaluate((element) => element.tagName.toLowerCase())
    .catch(() => "");
  if (tag_name === "form") {
    return observed;
  }
  const ancestor_form = observed.locator("xpath=ancestor::form[1]");
  if ((await ancestor_form.count().catch(() => 0)) > 0) {
    return ancestor_form.first();
  }
  const descendant_form = observed.locator("form").first();
  if ((await descendant_form.count().catch(() => 0)) > 0) {
    return descendant_form;
  }
  return observed;
}

async function normalize_interactive_locator(
  observed: Locator,
): Promise<Locator | undefined> {
  const is_interactive = await observed
    .evaluate((element) => {
      const tag = element.tagName.toLowerCase();
      const role = element.getAttribute("role")?.toLowerCase();
      return tag === "a" || tag === "button" || role === "link" || role === "button";
    })
    .catch(() => false);
  if (is_interactive) {
    return observed;
  }
  const ancestor = observed.locator(
    "xpath=ancestor::*[self::a or self::button or @role='link' or @role='button'][1]",
  );
  if (
    (await ancestor.count().catch(() => 0)) > 0 &&
    (await ancestor.first().isVisible().catch(() => false))
  ) {
    return ancestor.first();
  }
  return undefined;
}

async function selector_resolves_inside_form(
  page: Page,
  selector: string,
): Promise<boolean> {
  for (const frame of page.frames()) {
    let candidates: Locator;
    try {
      candidates = frame.locator(selector);
    } catch {
      continue;
    }
    const count = Math.min(await candidates.count().catch(() => 0), 10);
    for (let index = 0; index < count; index += 1) {
      if (
        await candidates
          .nth(index)
          .evaluate((element) => Boolean(element.closest("form")))
          .catch(() => false)
      ) {
        return true;
      }
    }
  }
  return false;
}

async function validate_navigation_target(
  page: Page,
  frame: Frame,
  locator: Locator,
  allowed_origin: string,
): Promise<
  | { allowed: true; destination: string }
  | { allowed: false; reason: string }
> {
  if (!url_has_origin(frame.url(), allowed_origin)) {
    return { allowed: false, reason: "navigation target was outside the allowed origin" };
  }
  if (!(await locator.isEnabled().catch(() => false))) {
    return { allowed: false, reason: "navigation target is disabled" };
  }
  const metadata = await locator
    .evaluate((element) => {
      const input = element as HTMLInputElement;
      const anchor = element as HTMLAnchorElement;
      return {
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute("role")?.toLowerCase() ?? "",
        type: input.getAttribute("type")?.toLowerCase() ?? "",
        href: anchor.getAttribute("href") ?? "",
        hasDownload: element.hasAttribute("download"),
        insideForm: Boolean(element.closest("form")),
        text: [
          element.textContent,
          element.getAttribute("aria-label"),
          element.getAttribute("title"),
        ]
          .filter(Boolean)
          .join(" "),
      };
    })
    .catch(() => undefined);
  if (!metadata) {
    return { allowed: false, reason: "navigation target could not be inspected" };
  }
  if (metadata.insideForm) {
    return { allowed: false, reason: "navigation target is inside a form and could submit it" };
  }
  if (metadata.type === "submit" || metadata.type === "reset") {
    return { allowed: false, reason: "target is not a navigation control" };
  }
  if (metadata.hasDownload || /^(?:mailto|tel|javascript|data):/i.test(metadata.href)) {
    return { allowed: false, reason: "target has an unsafe navigation scheme" };
  }
  const semantics = `${metadata.text} ${metadata.href}`;
  if (!has_contact_route_intent(semantics)) {
    return { allowed: false, reason: "target has no supported contact or inquiry intent" };
  }
  if (/delete|remove|unsubscribe|purchase|buy|pay|checkout/i.test(metadata.text)) {
    return { allowed: false, reason: "target text describes a destructive action" };
  }

  let destination = `${frame.url()}#selector:${metadata.text.trim().toLowerCase()}`;
  if (metadata.href) {
    let target_url: URL;
    try {
      target_url = new URL(metadata.href, frame.url() || page.url());
    } catch {
      return { allowed: false, reason: "target URL could not be resolved" };
    }
    if (target_url.origin !== allowed_origin) {
      return { allowed: false, reason: "cross-origin discovery navigation is not allowed" };
    }
    destination = canonical_discovery_url(target_url.toString());
  }
  return { allowed: true, destination };
}

async function first_visible_locator(
  page: Page,
  selector: string,
): Promise<{ frame: Frame; locator: Locator } | undefined> {
  for (const frame of page.frames()) {
    try {
      const candidates = frame.locator(selector);
      const count = Math.min(await candidates.count(), 10);
      for (let index = 0; index < count; index += 1) {
        const locator = candidates.nth(index);
        if (await locator.isVisible()) {
          return { frame, locator };
        }
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

function record_rejected_discovery_actions(
  evidence: AiActionEvidence[],
  observation: PageIntelligenceObserveResult,
  classifications: ActionClassification[],
  accepted_index: number,
  collector?: DiscoveryDebugCollector,
): void {
  for (let index = 0; index < observation.actions.length; index += 1) {
    if (index === accepted_index) continue;
    const action = observation.actions[index];
    const classification = classifications[index];
    if (!action || !classification) continue;
    evidence.push(
      discovery_evidence(
        action,
        observation,
        "rejected",
        classification.reason,
        "notRun",
        classification.normalization,
      ),
    );
    collector?.recordAiAction({
      selector: action.selector,
      argumentCount: action.arguments?.length ?? 0,
      normalization: classification.normalization,
      result: "rejected",
      reason: classification.reason,
    });
  }
}

function discovery_evidence(
  action: PageIntelligenceAction,
  observation: PageIntelligenceObserveResult,
  acceptance: "accepted" | "rejected",
  acceptance_reason: string,
  result: "observed" | "notRun",
  normalization: string,
): AiActionEvidence {
  return {
    stage: "discovery",
    placeholderInstruction: DISCOVERY_INSTRUCTION,
    selector: action.selector,
    method: action.method,
    argumentCount: action.arguments?.length ?? 0,
    normalization,
    acceptance,
    acceptanceReason: acceptance_reason,
    result,
    model: observation.model,
    durationMs: observation.durationMs,
  };
}

function is_retryable_observation_failure(error_text: string): boolean {
  return /timeout|timed out|invalid structured output|schema|parse|malformed/i.test(
    error_text,
  );
}

function stagehand_semantic_recovery_enabled(): boolean {
  return !/^(?:0|false|off)$/i.test(
    process.env.CONTACT_FORM_STAGEHAND_SEMANTIC_RECOVERY?.trim() ?? "on",
  );
}

function canonical_discovery_url(value: string): string {
  try {
    const url = new URL(value);
    url.hostname = url.hostname.toLowerCase();
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url.toString();
  } catch {
    return value;
  }
}

function url_origin(value: string): string | undefined {
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

function url_has_origin(value: string, allowed_origin: string): boolean {
  return url_origin(value) === allowed_origin;
}

async function install_same_origin_navigation_guard(
  page: Page,
  allowed_origin: string,
): Promise<SameOriginNavigationGuard> {
  let blocked_count = 0;
  const handler = async (route: Route): Promise<void> => {
    const request = route.request();
    if (
      request.isNavigationRequest() &&
      request.frame() === page.mainFrame() &&
      !url_has_origin(request.url(), allowed_origin)
    ) {
      blocked_count += 1;
      await route.abort("blockedbyclient");
      return;
    }
    await route.fallback();
  };
  await page.route("**/*", handler);

  let closed = false;
  return {
    get blockedCount() {
      return blocked_count;
    },
    close: async () => {
      if (closed) return;
      closed = true;
      await page.unroute("**/*", handler).catch(() => undefined);
    },
  };
}

async function restore_page_after_unsafe_navigation(
  page: Page,
  safe_url: string,
): Promise<void> {
  await page
    .goto(safe_url, {
      waitUntil: "domcontentloaded",
      timeout: NAVIGATION_TIMEOUT_MS,
    })
    .catch(() => undefined);
}

function discovery_failure(
  deterministic_result: FormDiscoveryResult,
  fallback_reason: string,
  ai_actions: AiActionEvidence[],
): FormDiscoveryResult {
  const deterministic_reason =
    deterministic_result.reason ?? "deterministic discovery found no contact form";
  return {
    ...deterministic_result,
    reason: `${deterministic_reason}; Stagehand fallback: ${fallback_reason}`,
    ...(ai_actions.length > 0 ? { aiActions: ai_actions } : {}),
  };
}
