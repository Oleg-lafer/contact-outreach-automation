import { create_form_failure_outcome } from "../contact_channels/forms/pipeline/D_reporting/D1_form_reporting_(Support).js";
import { create_email_failure_outcome } from "../contact_channels/emails/pipeline/E_reporting/E1_email_reporting_(Support).js";
import { create_meeting_failure_outcome } from "../contact_channels/meetings/pipeline/C_reporting/C1_meeting_reporting_(Support).js";
import { create_blocked_discovery_outcome } from "../contact_channels/forms/pipeline/A_discovery/A4_discovery_evidence_(Deterministic).js";
import { open_target_website } from "./B_browser/B_browser_session_(Integration).js";
import { discover_contact_routes } from "./C_contact_routes/C1_contact_route_discovery_(Integration).js";
import { run_contact_channels } from "./D_contact_channel_coordination/D_contact_channel_coordination_(Integration).js";
import { create_contact_outreach_outcome } from "./E_aggregate_reporting/E_aggregate_reporting_(Support).js";
import { describe_error } from "../shared_files_orchestrator/outreach_errors_(Support).js";
import { BrowserStageError } from "../shared_files_orchestrator/browser_stage_diagnostics_(Support).js";
import { create_deep_debug_context } from "../shared_files_orchestrator/deep_debug_observability_(Support).js";
import { resolve_automation_engine } from "./B_browser/B_browser_session_(Integration).js";
import type { DeepDebugContext } from "../shared_files_orchestrator/deep_debug_types_(Support).js";
import type {
  AutomationEngine,
  AutomationRunMode,
  ContactOutreachOutcome,
  ContactRequest,
  OutreachBrowserSession,
} from "../shared_files_orchestrator/outreach_types_(Support).js";

export interface ContactOutreachCoreOptions {
  runMode?: AutomationRunMode | undefined;
  outputPath?: string | undefined;
  engine?: AutomationEngine | undefined;
  browserRunContext?: {
    campaignId?: number;
    campaignName?: string;
    siteOrdinal?: number;
    websiteId?: number;
  };
}

export async function run_contact_outreach_core(
  contact_request: ContactRequest,
  options: ContactOutreachCoreOptions = {},
): Promise<ContactOutreachOutcome> {
  let browser_session: OutreachBrowserSession | undefined;
  let deep_debug: DeepDebugContext | undefined;
  let outcome: ContactOutreachOutcome;
  let workflow_failure: string | undefined;
  try {
    if (options.runMode === "deep-debug" && options.outputPath) {
      deep_debug = await create_deep_debug_context({
        outputPath: options.outputPath,
        targetUrl: contact_request.websiteUrl,
        engine: resolve_automation_engine(options.engine),
        redactionValues: contact_request_redaction_values(contact_request),
        environment: process.env,
      }).catch(() => undefined);
    }
    browser_session = await open_target_website(contact_request, {
      ...(options.engine ? { engine: options.engine } : {}),
      ...(deep_debug ? { deepDebug: deep_debug } : {}),
      redactionValues: contact_request_redaction_values(contact_request),
      ...(options.browserRunContext ? { runContext: options.browserRunContext } : {}),
      networkDebug: {
        redactionValues: contact_request_redaction_values(contact_request),
      },
    });
    const contact_routes = await discover_contact_routes(browser_session.page);
    const channels = await run_contact_channels({
      contactRequest: contact_request,
      browserSession: browser_session,
      contactRoutes: contact_routes,
      forms: {
        ...(options.runMode ? { runMode: options.runMode } : {}),
        ...(options.outputPath ? { outputPath: options.outputPath } : {}),
        ...(options.engine ? { engine: options.engine } : {}),
      },
    });
    outcome = create_contact_outreach_outcome(
      channels.forms,
      channels.emails,
      channels.meetings,
    );
    if (browser_session.browserStage) outcome.browserStage = browser_session.browserStage;
  } catch (error) {
    const reason = describe_error(error);
    workflow_failure = reason;
    const failure_kind = browser_session ? "runtime.error" : "navigation.failed";
    const discovery = create_blocked_discovery_outcome(
      contact_request.websiteUrl,
      `Full-run discovery could not be classified reliably: ${reason}`,
    );
    outcome = create_contact_outreach_outcome(
      create_form_failure_outcome(
        contact_request.websiteUrl,
        reason,
        failure_kind,
        discovery,
      ),
      create_email_failure_outcome(contact_request.websiteUrl, reason),
      create_meeting_failure_outcome(contact_request.websiteUrl, reason),
      "RUN_FAILED",
    );
    const browser_error = find_browser_stage_error(error);
    if (browser_error) outcome.browserStage = browser_error.browserStage;
    else if (browser_session?.browserStage) outcome.browserStage = browser_session.browserStage;
  } finally {
    await browser_session?.close().catch(() => undefined);
    if (deep_debug) {
      const summary = await deep_debug.finalize({
        // Keep the established manifest outcome shape form-owned for backward
        // compatibility. Browser-stage evidence is stored in browser/browser-stage.json.
        ...(outcome! ? { outcome: outcome.channels.forms } : {}),
        ...(browser_session?.pageIntelligence?.getUsageSummary?.()
          ? { aiUsage: browser_session.pageIntelligence.getUsageSummary?.() }
          : {}),
        ...(workflow_failure ? { failure: workflow_failure } : {}),
      }).catch(() => undefined);
      if (outcome! && summary) {
        outcome.deepDebug = summary;
        outcome.channels.forms.deepDebug = summary;
      }
    }
  }
  return outcome!;
}

function find_browser_stage_error(error: unknown): BrowserStageError | undefined {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current && !seen.has(current)) {
    if (current instanceof BrowserStageError) return current;
    seen.add(current);
    current = current instanceof Error ? current.cause : undefined;
  }
  return undefined;
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
