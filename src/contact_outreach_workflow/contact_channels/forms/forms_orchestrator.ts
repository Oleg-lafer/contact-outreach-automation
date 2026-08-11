import { dirname } from "node:path";
import {
  attach_ai_usage_summary,
  write_ai_assistance_artifact,
} from "../../shared_files_orchestrator/ai_observability_(Support).js";
import { describe_error } from "../../shared_files_orchestrator/outreach_errors_(Support).js";
import type {
  AutomationEngine,
  AutomationRunMode,
  AiUsageSummary,
  ContactRequest,
  ContactRouteDiscoveryResult,
  OutreachBrowserSession,
} from "../../shared_files_orchestrator/outreach_types_(Support).js";
import type {
  BrowserSession,
  FormChannelOutcome,
  FormDiscoveryOutcome,
  FormPopulationResult,
} from "./shared_files_forms/forms_types_(Support).js";
import { create_deep_debug_context } from "./shared_files_forms/deep_debug_observability_(Support).js";
import type { DeepDebugContext } from "./shared_files_forms/deep_debug_types_(Support).js";
import { discover_contact_form } from "./pipeline/A_discovery/A1_contact_form_discovery_(Integration).js";
import {
  collect_discovery_page_signals,
  create_blocked_discovery_outcome,
  create_discovery_outcome,
} from "./pipeline/A_discovery/A4_discovery_evidence_(Deterministic).js";
import { populate_contact_form } from "./pipeline/B_population/B1_contact_form_population_(Integration).js";
import { submit_and_assess_contact_form } from "./pipeline/C_submission/C1_contact_form_submission_(Integration).js";
import {
  create_form_channel_outcome,
  create_form_failure_outcome,
} from "./pipeline/D_reporting/D1_form_reporting_(Support).js";

/*
 * Forms-channel boundary:
 * discover -> populate -> submit -> normalize FormChannelOutcome.
 *
 * Macro input, browser ownership, route collection, aggregate reporting,
 * queue updates, and cleanup remain in contact_outreach_orchestrator.ts.
 */

export interface FormsWorkflowOptions {
  runMode?: AutomationRunMode | undefined;
  outputPath?: string | undefined;
  engine?: AutomationEngine | undefined;
}

/*
 * ========================================================================
 * TOP_LEVEL_WORKFLOW_FUNCTIONS
 * ========================================================================
 */

/*
 * ========================================================================
 * FORMS CHANNEL ORCHESTRATION - run_forms_workflow(...)
 * ========================================================================
 * Input:  A validated request, macro-owned browser, and ranked contact routes.
 * Output: The normalized forms-channel outcome.
 *
 * Responsibility: Coordinate only form-owned work. The macro orchestrator
 * guarantees browser cleanup and aggregate reporting.
 * ========================================================================
 */
export async function run_forms_workflow(
  contact_request: ContactRequest,
  outreach_browser_session: OutreachBrowserSession,
  initial_routes: ContactRouteDiscoveryResult,
  options: FormsWorkflowOptions = {},
): Promise<FormChannelOutcome> {
  const browser_session = outreach_browser_session as BrowserSession;
  let outcome: FormChannelOutcome;
  let discovery_assessment: FormDiscoveryOutcome | undefined;
  let deep_debug: DeepDebugContext | undefined;
  let owns_deep_debug = false;
  let workflow_failure: string | undefined;

  try {
    deep_debug = browser_session.deepDebug;
    if (!deep_debug && options.runMode === "deep-debug" && options.outputPath) {
      const requested_engine =
        options.engine ??
        (process.env.CONTACT_FORM_ENGINE === "stagehand"
          ? "stagehand"
          : "playwright");
      deep_debug = await create_deep_debug_context({
        outputPath: options.outputPath,
        targetUrl: contact_request.websiteUrl,
        engine: requested_engine,
        redactionValues: contact_request_redaction_values(contact_request),
        environment: process.env,
      });
      owns_deep_debug = true;
    }
    if (deep_debug && owns_deep_debug) {
      browser_session.deepDebug = deep_debug;
    }

    const discovery_result = await discover_contact_form(
      browser_session,
      contact_request.websiteUrl,
      {
        ...(workflow_artifact_directory(options, deep_debug)
          ? { artifactDirectory: workflow_artifact_directory(options, deep_debug) }
          : {}),
        initialRoutes: initial_routes,
      },
    );
    const page_signals = await collect_discovery_page_signals(
      browser_session.page,
    ).catch(() => ({
      contactContext: false,
      contactChannels: [],
      recognizedFormEmbeds: [],
      contactRevealControls: [],
    }));
    discovery_assessment = create_discovery_outcome({
      websiteUrl: contact_request.websiteUrl,
      finalUrl: browser_session.page.url(),
      discoveryResult: discovery_result,
      pageSignals: page_signals,
      networkRecords: browser_session.networkDebugRecorder?.snapshot() ?? [],
    });
    if (!discovery_result.candidate) {
      deep_debug?.record({
        stage: "orchestrator",
        substage: "discovery-handoff",
        operation: "selected-form-candidate",
        outcome: "blocked",
        reason: discovery_result.reason ?? "discovery returned no candidate",
        url: browser_session.page.url(),
      });
      outcome = create_form_channel_outcome(
        contact_request.websiteUrl,
        discovery_result,
        undefined,
        undefined,
        discovery_assessment,
      );
      return await finalize_workflow_outcome(
        contact_request,
        outcome,
        options,
        browser_session?.pageIntelligence?.getUsageSummary?.(),
        deep_debug?.artifactDirectory,
      );
    }

    if (deep_debug) {
      if (owns_deep_debug) await deep_debug.attachPage(browser_session.page);
      deep_debug.record({
        stage: "orchestrator",
        substage: "discovery-handoff",
        operation: "selected-form-candidate",
        outcome: "succeeded",
        url: browser_session.page.url(),
        frameUrl: discovery_result.candidate.frame.url(),
        data: {
          score: discovery_result.candidate.score,
          classification: discovery_result.candidate.classification,
          messageDisposition: discovery_result.candidate.messageDisposition,
          source: discovery_result.candidate.source,
          structure: discovery_result.candidate.structure,
        },
      });
      await deep_debug.captureFormSnapshot({
        stage: "population",
        label: "00-discovery-candidate-entry",
        form: discovery_result.candidate.form,
        expectedValues: contact_request_redaction_values(contact_request),
      });
      await deep_debug.captureScreenshot(
        browser_session.page,
        "population",
        "00-discovery-candidate-entry",
      );
    }

    let population_result = await populate_contact_form(
      contact_request,
      discovery_result.candidate,
      {
        artifactDirectory: workflow_artifact_directory(options, deep_debug),
        ...(browser_session.pageIntelligence
          ? { pageIntelligence: browser_session.pageIntelligence }
          : {}),
        ...(browser_session.ensurePageIntelligence
          ? {
              ensurePageIntelligence:
                browser_session.ensurePageIntelligence,
            }
          : {}),
        obstructionActions: browser_session.obstructionActions ?? [],
        ...(deep_debug ? { deepDebug: deep_debug } : {}),
      },
    );
    if (deep_debug) {
      deep_debug.record({
        stage: "population",
        substage: "result",
        operation: "population-completed",
        outcome: population_result.blockingReason ? "blocked" : "succeeded",
        reason: population_result.blockingReason,
        url: browser_session.page.url(),
        frameUrl: discovery_result.candidate.frame.url(),
        data: {
          populatedFields: population_result.populatedFields,
          messageDisposition: population_result.messageDisposition,
          failureKind: population_result.failureKind ?? null,
          hasSubmissionHandoff: Boolean(population_result.submissionHandoff),
          aiActionCount: population_result.aiActions?.length ?? 0,
        },
      });
      if (population_result.aiActions?.length) {
        deep_debug.recordAiOperations(
          "population",
          population_result.blockingReason ?? "population fallback completed",
          population_result.aiActions,
        );
      }
      await deep_debug.captureFormSnapshot({
        stage: "population",
        label: "99-population-final",
        form: discovery_result.candidate.form,
        expectedValues: contact_request_redaction_values(contact_request),
        extra: {
          populatedFields: population_result.populatedFields,
          messageDisposition: population_result.messageDisposition,
          blockingReason: population_result.blockingReason ?? null,
        },
      });
      await deep_debug.captureScreenshot(
        browser_session.page,
        "population",
        "99-population-final",
      );
      if (population_result.submissionHandoff) {
        await deep_debug.writeJson("handoff/population-created.json", {
          frameUrl: population_result.submissionHandoff.frameUrl,
          formFingerprintLength:
            population_result.submissionHandoff.formFingerprint.length,
          fields: population_result.submissionHandoff.fields.map((field) => ({
            field: field.field,
            controlIndex: field.controlIndex,
            metadata: field.metadata,
            expectedValuePresent: field.expectedValue.length > 0,
            expectedValueLength: field.expectedValue.length,
          })),
        });
      }
    }
    if (population_result.blockingReason) {
      outcome = create_form_channel_outcome(
        contact_request.websiteUrl,
        discovery_result,
        population_result,
        undefined,
        discovery_assessment,
      );
      return await finalize_workflow_outcome(
        contact_request,
        outcome,
        options,
        browser_session?.pageIntelligence?.getUsageSummary?.(),
        deep_debug?.artifactDirectory,
      );
    }

    const submission_assessment = await submit_and_assess_contact_form(
      browser_session,
      discovery_result.candidate,
      {
        artifactDirectory: workflow_artifact_directory(options, deep_debug),
        contactRequest: contact_request,
        ...(population_result.submissionHandoff
          ? { populationHandoff: population_result.submissionHandoff }
          : {}),
        onPopulationResultUpdated: (updated_population) => {
          population_result = merge_population_results(
            population_result,
            updated_population,
          );
        },
        recoverPopulation: async ({ candidate, validation }) => {
          deep_debug?.record({
            stage: "handoff",
            substage: "validation-recovery",
            operation: "deterministic-population-recovery",
            outcome: "started",
            reason: validation.reason,
            url: browser_session!.page.url(),
            frameUrl: candidate.frame.url(),
            data: {
              invalidControls: validation.invalidControls,
              pageIntelligenceAllowed: false,
            },
          });
          const recovered_population = await populate_contact_form(
            contact_request!,
            candidate,
            {
              artifactDirectory: workflow_artifact_directory(
                options,
                deep_debug,
              ),
              obstructionActions: browser_session!.obstructionActions ?? [],
              ...(deep_debug ? { deepDebug: deep_debug } : {}),
            },
          );
          population_result = merge_population_results(
            population_result,
            recovered_population,
          );
          deep_debug?.record({
            stage: "handoff",
            substage: "validation-recovery",
            operation: "deterministic-population-recovery",
            outcome: recovered_population.blockingReason
              ? "blocked"
              : "succeeded",
            reason: recovered_population.blockingReason,
            url: browser_session!.page.url(),
            frameUrl: candidate.frame.url(),
            data: {
              populatedFields: recovered_population.populatedFields,
              messageDisposition: recovered_population.messageDisposition,
              hasSubmissionHandoff: Boolean(
                recovered_population.submissionHandoff,
              ),
              aiActionCount: recovered_population.aiActions?.length ?? 0,
              pageIntelligenceAllowed: false,
            },
          });
          return {
            candidate,
            populationResult: population_result,
          };
        },
        ...(deep_debug ? { deepDebug: deep_debug } : {}),
      },
    );
    outcome = create_form_channel_outcome(
      contact_request.websiteUrl,
      discovery_result,
      population_result,
      submission_assessment,
      discovery_assessment,
    );
    return await finalize_workflow_outcome(
      contact_request,
      outcome,
      options,
      browser_session?.pageIntelligence?.getUsageSummary?.(),
      deep_debug?.artifactDirectory,
    );
  } catch (error) {
    const failure_reason = describe_error(error);
    workflow_failure = failure_reason;
    deep_debug?.record({
      stage: "orchestrator",
      substage: "exception",
      operation: "workflow-exception",
      outcome: "failed",
      reason: failure_reason,
      url: browser_session.page.url(),
    });
    discovery_assessment ??= create_blocked_discovery_outcome(
      contact_request.websiteUrl,
      `Full-run discovery could not be classified reliably: ${failure_reason}`,
    );
    outcome = create_form_failure_outcome(
      contact_request.websiteUrl,
      failure_reason,
      "runtime.error",
      discovery_assessment,
    );
    return await finalize_workflow_outcome(
      contact_request,
      outcome,
      options,
      browser_session?.pageIntelligence?.getUsageSummary?.(),
      deep_debug?.artifactDirectory,
    );
  } finally {
    if (deep_debug && owns_deep_debug) {
      const debug_summary = await deep_debug.finalize({
        ...(outcome! ? { outcome } : {}),
        ...(browser_session?.pageIntelligence?.getUsageSummary?.()
          ? { aiUsage: browser_session.pageIntelligence.getUsageSummary?.() }
          : {}),
        ...(workflow_failure ? { failure: workflow_failure } : {}),
      });
      if (outcome!) {
        outcome.deepDebug = debug_summary;
      }
    }
    if (owns_deep_debug) delete browser_session.deepDebug;
  }
}

function merge_population_results(
  previous: FormPopulationResult,
  current: FormPopulationResult,
): FormPopulationResult {
  const cumulative_ai_actions = [
    ...(previous.aiActions ?? []),
    ...(current.aiActions ?? []),
  ];
  return {
    ...current,
    ...(current.debug
      ? {}
      : previous.debug
        ? { debug: previous.debug }
        : {}),
    ...(cumulative_ai_actions.length > 0
      ? { aiActions: cumulative_ai_actions }
      : {}),
  };
}

function contact_request_redaction_values(
  contact_request: ContactRequest,
): string[] {
  return [
    contact_request.name,
    contact_request.email,
    contact_request.phone,
    contact_request.message,
    contact_request.company,
    contact_request.role,
    contact_request.website,
    contact_request.country,
  ].filter((value): value is string => Boolean(value));
}

function population_artifact_directory(
  options: FormsWorkflowOptions,
): string | undefined {
  return options.outputPath ? dirname(options.outputPath) : undefined;
}

function workflow_artifact_directory(
  options: FormsWorkflowOptions,
  deep_debug?: DeepDebugContext,
): string | undefined {
  return deep_debug?.artifactDirectory ?? population_artifact_directory(options);
}

async function finalize_workflow_outcome(
  contact_request: ContactRequest,
  outcome: FormChannelOutcome,
  options: FormsWorkflowOptions,
  ai_usage?: AiUsageSummary,
  artifact_directory_override?: string,
): Promise<FormChannelOutcome> {
  const attached_ai_assistance = attach_ai_usage_summary(
    outcome.aiAssistance,
    ai_usage,
  );
  const ai_assistance = options.runMode === "deep-debug"
    ? attached_ai_assistance
    : await write_ai_assistance_artifact(
        attached_ai_assistance,
        artifact_directory_override ?? population_artifact_directory(options),
        contact_request_redaction_values(contact_request),
      );
  if (ai_assistance) {
    outcome.aiAssistance = ai_assistance;
  } else {
    delete outcome.aiAssistance;
  }
  return outcome;
}
