import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Page } from "playwright";
import type {
  FormDiscoveryResult,
  DiscoveryAiActionDebug,
  ContactFormCandidateSource,
  DiscoveryDebugSummary,
  DiscoveryFormCandidateDebug,
  DiscoveryInteractionDebug,
  DiscoveryInteractionState,
  DiscoveryRouteAttemptDebug,
} from "../../shared_files_forms/forms_types_(Support).js";
import type { ContactFormAssessment } from "../../shared_files_forms/contact_form_intent_(Deterministic).js";

export class DiscoveryDebugCollector {
  readonly startingUrl: string;
  readonly attemptedRoutes: DiscoveryRouteAttemptDebug[] = [];
  readonly candidates: DiscoveryFormCandidateDebug[] = [];
  readonly aiActions: DiscoveryAiActionDebug[] = [];
  readonly interactions: DiscoveryInteractionDebug[] = [];

  constructor(starting_url: string) {
    this.startingUrl = starting_url;
  }

  recordRoute(record: DiscoveryRouteAttemptDebug): void {
    this.attemptedRoutes.push(record);
  }

  recordCandidate(options: {
    url: string;
    frameUrl: string;
    source: ContactFormCandidateSource | "deterministic";
    assessment: ContactFormAssessment;
  }): void {
    this.candidates.push({
      url: options.url,
      frameUrl: options.frameUrl,
      source: options.source,
      score: options.assessment.score,
      classification: options.assessment.classification,
      accepted: options.assessment.accepted,
      reason: options.assessment.reason,
      signals: options.assessment.signals,
    });
  }

  recordAiAction(record: DiscoveryAiActionDebug): void {
    this.aiActions.push(record);
  }

  recordInteraction(record: DiscoveryInteractionDebug): void {
    this.interactions.push(record);
  }
}

export async function finalize_discovery_debug(
  page: Page,
  result: FormDiscoveryResult,
  collector: DiscoveryDebugCollector,
  artifact_directory?: string,
): Promise<FormDiscoveryResult> {
  if (!artifact_directory) {
    return result;
  }

  const absolute_directory = resolve(artifact_directory);
  await mkdir(absolute_directory, { recursive: true });
  const report_path = join(absolute_directory, "discovery-debug.json");
  let screenshot_path: string | undefined;
  if (!result.candidate) {
    screenshot_path = join(absolute_directory, "discovery-failure.png");
    await page
      .screenshot({ path: screenshot_path, fullPage: true })
      .catch(() => {
        screenshot_path = undefined;
      });
  }

  const starting_origin = safe_origin(collector.startingUrl);
  const summary: DiscoveryDebugSummary = {
    reportPath: report_path,
    artifactDirectory: absolute_directory,
    ...(screenshot_path ? { screenshotPath: screenshot_path } : {}),
    startingUrl: collector.startingUrl,
    finalUrl: page.url(),
    finalClassification:
      result.reason ??
      (result.candidate ? "contact form candidate accepted" : "discovery failed"),
    attemptedRoutes: collector.attemptedRoutes,
    candidates: collector.candidates,
    aiActions: collector.aiActions,
    frames: page.frames().map((frame) => ({
      url: frame.url(),
      sameOrigin: safe_origin(frame.url()) === starting_origin,
    })),
    interactions: collector.interactions,
  };
  await writeFile(
    report_path,
    `${JSON.stringify({ version: 1, generatedAt: new Date().toISOString(), summary }, null, 2)}\n`,
    "utf8",
  );
  return { ...result, debug: summary };
}

export async function capture_discovery_interaction_state(
  page: Page,
): Promise<DiscoveryInteractionState> {
  const counts = await page
    .evaluate(() => ({
      visibleFormCount: Array.from(document.querySelectorAll("form")).filter(
        (element) => {
          const style = window.getComputedStyle(element as HTMLElement);
          const bounds = (element as HTMLElement).getBoundingClientRect();
          return style.display !== "none" && style.visibility !== "hidden" && bounds.width > 0 && bounds.height > 0;
        },
      ).length,
      visibleDialogCount: Array.from(
        document.querySelectorAll("dialog[open], [role='dialog'], [aria-modal='true']"),
      ).filter((element) => {
        const style = window.getComputedStyle(element as HTMLElement);
        const bounds = (element as HTMLElement).getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && bounds.width > 0 && bounds.height > 0;
      }).length,
    }))
    .catch(() => ({ visibleFormCount: 0, visibleDialogCount: 0 }));
  return {
    url: page.url(),
    visibleFormCount: counts.visibleFormCount,
    visibleDialogCount: counts.visibleDialogCount,
    frameCount: page.frames().length,
  };
}

export async function write_blocked_discovery_debug(
  page: Page,
  starting_url: string,
  reason: string,
  artifact_directory: string,
): Promise<DiscoveryDebugSummary> {
  const absolute_directory = resolve(artifact_directory);
  await mkdir(absolute_directory, { recursive: true });
  const report_path = join(absolute_directory, "discovery-debug.json");
  const attempted_screenshot_path = join(
    absolute_directory,
    "discovery-failure.png",
  );
  const screenshot_written = await page
    .screenshot({ path: attempted_screenshot_path, fullPage: true })
    .then(() => true)
    .catch(() => false);
  const summary: DiscoveryDebugSummary = {
    reportPath: report_path,
    artifactDirectory: absolute_directory,
    ...(screenshot_written ? { screenshotPath: attempted_screenshot_path } : {}),
    startingUrl: starting_url,
    finalUrl: page.url(),
    finalClassification: reason,
    attemptedRoutes: [],
    candidates: [],
    aiActions: [],
    frames: page.frames().map((frame) => ({
      url: frame.url(),
      sameOrigin: safe_origin(frame.url()) === safe_origin(starting_url),
    })),
  };
  await writeFile(
    report_path,
    `${JSON.stringify({ version: 1, generatedAt: new Date().toISOString(), summary }, null, 2)}\n`,
    "utf8",
  );
  return summary;
}

function safe_origin(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return "";
  }
}
