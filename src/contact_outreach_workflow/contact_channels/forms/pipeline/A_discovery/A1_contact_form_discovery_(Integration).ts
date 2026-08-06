import type { Locator, Page } from "playwright";
import {
  MAX_CONTACT_LINKS,
  NAVIGATION_TIMEOUT_MS,
} from "../../../../shared_files_orchestrator/outreach_constants_(Support).js";
import { describe_error } from "../../../../shared_files_orchestrator/outreach_errors_(Support).js";
import { wait_for_discovery_readiness } from "../../../../shared_files_orchestrator/discovery_readiness_(Deterministic).js";
import { dismiss_cookie_obstruction } from "../../../../shared_files_orchestrator/page_obstructions_(Deterministic).js";
import { discover_contact_routes } from "../../../../orchestrator/C_contact_routes/C1_contact_route_discovery_(Integration).js";
import type {
  ContactRouteCandidate,
  ContactRouteDiscoveryResult,
} from "../../../../shared_files_orchestrator/outreach_types_(Support).js";
import { assess_contact_form } from "../../shared_files_forms/contact_form_intent_(Deterministic).js";
import type {
  BrowserSession,
  FormDiscoveryResult,
  ContactFormCandidate,
} from "../../shared_files_forms/forms_types_(Support).js";
import { discover_contact_form_with_stagehand_fallback } from "./A2_stagehand_discovery_fallback_(LLM).js";
import {
  DiscoveryDebugCollector,
  capture_discovery_interaction_state,
  finalize_discovery_debug,
} from "./A3_discovery_observability_(Support).js";

const FORM_LIKE_CONTAINER_SELECTOR = [
  "main:visible:has(input:visible)",
  "main:visible:has(textarea:visible)",
  "section:visible:has(input:visible)",
  "section:visible:has(textarea:visible)",
  "article:visible:has(input:visible)",
  "article:visible:has(textarea:visible)",
  "div:visible:has(input:visible)",
  "div:visible:has(textarea:visible)",
].join(", ");
const FORM_LIKE_CONTAINER_CONFIDENCE_THRESHOLD = 8;

/*
 * TOP LEVEL WORKFLOW:
 *
 * discover_contact_form(browser_session)
 *        |
 *        v
 * inspect current page and frames
 *        |
 *        v
 * rank likely contact links if no form exists
 *        |
 *        v
 * visit up to three candidates and inspect again
 */

/*
 * ========================================================================
 * TOP_LEVEL_WORKFLOW_FUNCTIONS
 * ========================================================================
 */

/*
 * ========================================================================
 * CONTACT FORM DISCOVERY - discover_contact_form(...)
 * ========================================================================
 * Input:  The browser session currently displaying the target website.
 * Output: The best contact-form candidate and whether contact content was found.
 *
 * Responsibility: Inspect the current document and frames first, then visit a
 * small ranked set of contact links when no suitable inline form is present.
 * ========================================================================
 */
export async function discover_contact_form(
  browser_session: BrowserSession,
  website_url: string,
  options: {
    artifactDirectory?: string | undefined;
    initialRoutes?: ContactRouteDiscoveryResult | undefined;
  } = {},
): Promise<FormDiscoveryResult> {
  const collector = new DiscoveryDebugCollector(browser_session.page.url());
  const result = await run_contact_form_discovery(
    browser_session,
    website_url,
    collector,
    options.initialRoutes ??
      (await discover_contact_routes(browser_session.page)),
  );
  const finalized = await finalize_discovery_debug(
    browser_session.page,
    result,
    collector,
    options.artifactDirectory,
  );
  if (!finalized.candidate && !finalized.failureKind) {
    finalized.failureKind = classify_discovery_failure_kind(finalized);
  }
  return finalized;
}

function classify_discovery_failure_kind(
  result: FormDiscoveryResult,
): NonNullable<FormDiscoveryResult["failureKind"]> {
  const reason = (result.reason ?? "").toLowerCase();
  if (result.transportFailure) {
    return "navigation.failed";
  }
  if ((result.aiActions?.length ?? 0) > 0 || /stagehand fallback/.test(reason)) {
    return "discovery.llm_unresolved";
  }
  if (/email.only|only email|email contact/.test(reason)) {
    return "discovery.email_only";
  }
  if (/booking.only|booking|cross.origin/.test(reason)) {
    return "discovery.booking_only";
  }
  if (/rejected|newsletter|subscription|search|login|message field/.test(reason)) {
    return "discovery.rejected_form";
  }
  return "discovery.no_route";
}

async function run_contact_form_discovery(
  browser_session: BrowserSession,
  _website_url: string,
  collector: DiscoveryDebugCollector,
  initial_routes: ContactRouteDiscoveryResult,
): Promise<FormDiscoveryResult> {
  const starting_url = initial_routes.startingUrl;
  const visited_routes = new Set<string>();
  const initial_result = await discover_generic_contact_form(
    browser_session.page,
    collector,
    visited_routes,
    initial_routes.candidates,
  );
  if (initial_result.candidate) {
    return initial_result;
  }

  await return_to_starting_page_for_spa_retry(browser_session.page, starting_url);
  await wait_for_discovery_readiness(browser_session.page);
  await dismiss_cookie_obstruction(browser_session.page);
  const refreshed_routes = await discover_contact_routes(browser_session.page);

  const retry_result = await discover_generic_contact_form(
    browser_session.page,
    collector,
    visited_routes,
    refreshed_routes.candidates,
  );
  const deterministic_result =
    retry_result.candidate || retry_result.contactPageFound
      ? retry_result
      : initial_result;

  return deterministic_result.candidate || deterministic_result.transportFailure
    ? deterministic_result
    : discover_contact_form_with_stagehand_fallback(
        browser_session,
        deterministic_result,
        () => find_best_contact_form_candidate(browser_session.page, collector),
        collector,
      );
}

async function discover_generic_contact_form(
  page: Page,
  collector: DiscoveryDebugCollector,
  visited_routes: Set<string>,
  contact_routes: ContactRouteCandidate[],
): Promise<FormDiscoveryResult> {
  const inline_candidate = await find_best_contact_form_candidate(
    page,
    collector,
  );
  if (inline_candidate?.classification === "complete") {
    return { contactPageFound: true, candidate: inline_candidate };
  }

  let progression_fallback = inline_candidate
    ? { url: page.url(), score: inline_candidate.score }
    : undefined;

  let contact_page_found = Boolean(inline_candidate);
  let transport_failure_count = 0;

  for (const link of contact_routes.slice(0, MAX_CONTACT_LINKS)) {
    const canonical_url = canonical_discovery_url(link.url);
    if (visited_routes.has(canonical_url)) {
      collector.recordRoute({
        url: link.url,
        label: link.label,
        score: link.score,
        result: "duplicate",
        reason: "the same contact destination was already attempted",
      });
      continue;
    }
    visited_routes.add(canonical_url);
    const interaction_started_at = new Date().toISOString();
    const interaction_before = await capture_discovery_interaction_state(page);
    try {
      await page.goto(link.url, {
        waitUntil: "domcontentloaded",
        timeout: NAVIGATION_TIMEOUT_MS,
      });
      contact_page_found = true;
      collector.recordRoute({
        url: link.url,
        label: link.label,
        score: link.score,
        result: "opened",
      });
      await wait_for_discovery_readiness(page);
      await dismiss_cookie_obstruction(page);
      const interaction_after = await capture_discovery_interaction_state(page);
      collector.recordInteraction({
        label: link.label || link.url,
        performedAt: interaction_started_at,
        before: interaction_before,
        after: interaction_after,
        pageStateChanged: discovery_state_changed(interaction_before, interaction_after),
      });

      const linked_candidate = await find_best_contact_form_candidate(
        page,
        collector,
      );
      if (linked_candidate?.classification === "complete") {
        return { contactPageFound: true, candidate: linked_candidate };
      }
      if (
        linked_candidate?.classification === "progression" &&
        (!progression_fallback ||
          linked_candidate.score > progression_fallback.score)
      ) {
        progression_fallback = {
          url: page.url(),
          score: linked_candidate.score,
        };
      }
    } catch (error) {
      transport_failure_count += 1;
      collector.recordRoute({
        url: link.url,
        label: link.label,
        score: link.score,
        result: "failed",
        reason: describe_error(error),
      });
      const interaction_after = await capture_discovery_interaction_state(page);
      collector.recordInteraction({
        label: link.label || link.url,
        performedAt: interaction_started_at,
        before: interaction_before,
        after: interaction_after,
        pageStateChanged: discovery_state_changed(interaction_before, interaction_after),
      });
      // A broken candidate link should not prevent trying the remaining links.
    }
  }

  if (progression_fallback) {
    if (canonical_discovery_url(page.url()) !== canonical_discovery_url(progression_fallback.url)) {
      await page
        .goto(progression_fallback.url, {
          waitUntil: "domcontentloaded",
          timeout: NAVIGATION_TIMEOUT_MS,
        })
        .catch(() => undefined);
      await wait_for_discovery_readiness(page);
      await dismiss_cookie_obstruction(page);
    }
    const candidate = await find_best_contact_form_candidate(
      page,
      collector,
    );
    if (candidate?.classification === "progression") {
      return { contactPageFound: true, candidate };
    }
  }

  const unsupported_classification =
    await classify_unsupported_contact_experience(page);
  const rejected_form_classification = classify_rejected_form_candidates(
    collector,
  );
  const classified_contact_page_found =
    contact_page_found || unsupported_classification !== undefined;
  return {
    contactPageFound: classified_contact_page_found,
    ...(rejected_form_classification?.includes("none offered a message field")
      ? { messageDisposition: "notOffered" as const }
      : {}),
    reason:
      rejected_form_classification ??
      unsupported_classification ??
      (contact_page_found
        ? "contact route found, but all form candidates were rejected"
        : transport_failure_count > 0
          ? "contact route was inaccessible"
          : "contact page not found: no contact or consultation route was found"),
    ...(!classified_contact_page_found && transport_failure_count > 0
      ? { transportFailure: true }
      : {}),
  };
}

function discovery_state_changed(
  before: Awaited<ReturnType<typeof capture_discovery_interaction_state>>,
  after: Awaited<ReturnType<typeof capture_discovery_interaction_state>>,
): boolean {
  return (
    before.url !== after.url ||
    before.visibleFormCount !== after.visibleFormCount ||
    before.visibleDialogCount !== after.visibleDialogCount ||
    before.frameCount !== after.frameCount
  );
}

function classify_rejected_form_candidates(
  collector: DiscoveryDebugCollector,
): string | undefined {
  const rejected = collector.candidates.filter((candidate) => !candidate.accepted);
  if (
    rejected.some((candidate) =>
      /newsletter/.test(candidate.reason),
    )
  ) {
    return "contact forms were rejected because only newsletter or subscription forms were available";
  }
  if (
    rejected.some((candidate) =>
      /route\/directions/.test(candidate.reason),
    )
  ) {
    return "contact forms were rejected because only route or directions forms were available";
  }
  if (
    rejected.some((candidate) =>
      /no message field|no safe non-submit progression/.test(candidate.reason),
    )
  ) {
    return "contact forms were found, but none offered a message field or safe multi-step progression";
  }
  return undefined;
}

async function return_to_starting_page_for_spa_retry(
  page: Page,
  starting_url: string,
): Promise<void> {
  if (page.url() === starting_url) {
    return;
  }

  await page
    .goto(starting_url, {
      waitUntil: "domcontentloaded",
      timeout: NAVIGATION_TIMEOUT_MS,
    })
    .catch(() => undefined);
}

/*
 * ========================================================================
 * STEP_LEVEL_HELPER_FUNCTIONS
 * ========================================================================
 *
 * find_best_form_like_container(...) - Score strong non-native form containers.
 * find_best_contact_form(...)       - Score visible forms in every frame.
 * score_contact_form(...)           - Evaluate contact-related form evidence.
 * collect_ranked_contact_links(...) - Rank likely contact destinations.
 * ========================================================================
 */

async function find_best_contact_form_candidate(
  page: Page,
  collector: DiscoveryDebugCollector,
): Promise<ContactFormCandidate | undefined> {
  const candidates = [
    await find_best_contact_form(page, collector),
    await find_best_form_like_container(page, collector),
  ].filter((candidate): candidate is ContactFormCandidate => Boolean(candidate));
  candidates.sort(compare_contact_candidates);
  return candidates[0];
}

async function find_best_form_like_container(
  page: Page,
  collector: DiscoveryDebugCollector,
): Promise<ContactFormCandidate | undefined> {
  const container_candidates: Array<{
    candidate: ContactFormCandidate;
    domPath: string;
  }> = [];

  for (const frame of page.frames()) {
    let containers: Locator;
    try {
      containers = frame.locator(FORM_LIKE_CONTAINER_SELECTOR);
      const container_count = await containers.count();
      for (let index = 0; index < container_count; index += 1) {
        const container = containers.nth(index);
        const owns_no_native_form = await container
          .evaluate(
            (element) =>
              !element.closest("form") && !element.querySelector("form"),
          )
          .catch(() => false);
        if (!owns_no_native_form) {
          continue;
        }
        const assessment = await assess_contact_form(container);
        collector.recordCandidate({
          url: page.url(),
          frameUrl: frame.url(),
          source: "generic",
          assessment,
        });
        if (
          assessment.accepted &&
          assessment.classification !== "rejected" &&
          assessment.score >= FORM_LIKE_CONTAINER_CONFIDENCE_THRESHOLD
        ) {
          const dom_path = await container
            .evaluate((element) => {
              const indexes: number[] = [];
              let current: Element | null = element;
              while (current?.parentElement) {
                indexes.unshift(
                  Array.prototype.indexOf.call(
                    current.parentElement.children,
                    current,
                  ),
                );
                current = current.parentElement;
              }
              return indexes.join("/");
            })
            .catch(() => `${index}`);
          container_candidates.push({
            candidate: {
              form: container,
              frame,
              score: assessment.score,
              source: "generic",
              structure: "formLikeContainer",
              classification: assessment.classification,
              messageDisposition: assessment.messageDisposition,
            },
            domPath: dom_path,
          });
        }
      }
    } catch {
      continue;
    }
  }

  const candidates = deduplicate_nested_form_like_candidates(
    container_candidates,
  );
  candidates.sort(compare_contact_candidates);
  return candidates[0];
}

function deduplicate_nested_form_like_candidates(
  entries: Array<{ candidate: ContactFormCandidate; domPath: string }>,
): ContactFormCandidate[] {
  return entries
    .filter((entry, index) => {
      const duplicate_before = entries.some(
        (other, other_index) =>
          other_index < index &&
          other.candidate.frame === entry.candidate.frame &&
          other.domPath === entry.domPath,
      );
      if (duplicate_before) return false;
      if (entry.candidate.classification !== "complete") return true;
      return !entries.some(
        (other) =>
          other.candidate.frame === entry.candidate.frame &&
          other.candidate.classification === "complete" &&
          other.domPath !== entry.domPath &&
          other.domPath.startsWith(`${entry.domPath}/`),
      );
    })
    .map((entry) => entry.candidate);
}

async function find_best_contact_form(
  page: Page,
  collector: DiscoveryDebugCollector,
): Promise<ContactFormCandidate | undefined> {
  const candidates: ContactFormCandidate[] = [];

  for (const frame of page.frames()) {
    const forms = frame.locator("form:visible");
    let form_count = 0;
    try {
      form_count = await forms.count();
    } catch {
      continue;
    }

    for (let index = 0; index < form_count; index += 1) {
      const form = forms.nth(index);
      const assessment = await assess_contact_form(form);
      collector.recordCandidate({
        url: page.url(),
        frameUrl: frame.url(),
        source: "generic",
        assessment,
      });
      if (assessment.accepted && assessment.classification !== "rejected") {
        candidates.push({
          form,
          frame,
          score: assessment.score,
          source: "generic",
          structure: "nativeForm",
          classification: assessment.classification,
          messageDisposition: assessment.messageDisposition,
        });
      }
    }
  }

  candidates.sort(compare_contact_candidates);
  return candidates[0];
}

function compare_contact_candidates(
  left: ContactFormCandidate,
  right: ContactFormCandidate,
): number {
  const classification_rank = (candidate: ContactFormCandidate): number =>
    candidate.classification === "complete" ? 2 : 1;
  return (
    classification_rank(right) - classification_rank(left) ||
    right.score - left.score ||
    candidate_source_rank(right) - candidate_source_rank(left)
  );
}

function candidate_source_rank(candidate: ContactFormCandidate): number {
  if (
    candidate.source === "generic" &&
    candidate.structure === "nativeForm"
  ) {
    return 3;
  }
  if (candidate.source === "generic") return 2;
  return 1;
}

async function classify_unsupported_contact_experience(
  page: Page,
): Promise<string | undefined> {
  let has_email_contact = false;
  let has_booking_contact = false;
  let has_cross_origin_booking = false;
  for (const frame of page.frames()) {
    has_email_contact ||= await frame
      .locator('a[href^="mailto:" i]:visible')
      .first()
      .isVisible()
      .catch(() => false);
    const links = frame.locator("a[href]:visible");
    const count = Math.min(await links.count().catch(() => 0), 100);
    for (let index = 0; index < count; index += 1) {
      const metadata = await links
        .nth(index)
        .evaluate((element) => ({
          href: element.getAttribute("href") ?? "",
          text: [
            element.textContent,
            element.getAttribute("aria-label"),
            element.getAttribute("title"),
          ]
            .filter(Boolean)
            .join(" "),
        }))
        .catch(() => undefined);
      if (!metadata || !/book|schedule|consultation|appointment/i.test(`${metadata.text} ${metadata.href}`)) {
        continue;
      }
      has_booking_contact = true;
      try {
        has_cross_origin_booking ||=
          new URL(metadata.href, frame.url() || page.url()).origin !==
          new URL(page.url()).origin;
      } catch {
        // Broken booking links are handled by the ordinary route diagnostics.
      }
    }
  }
  if (has_email_contact) {
    return "contact content was found, but only email contact was available";
  }
  if (has_cross_origin_booking) {
    return "contact content was found, but only a cross-origin booking route was available";
  }
  if (has_booking_contact) {
    return "booking-only contact content was found, but no supported embedded form was available";
  }
  return undefined;
}

function canonical_discovery_url(value: string): string {
  const url = new URL(value);
  url.hostname = url.hostname.toLowerCase();
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url.toString();
}
