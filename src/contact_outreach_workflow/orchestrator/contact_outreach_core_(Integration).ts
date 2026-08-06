import { create_form_failure_outcome } from "../contact_channels/forms/pipeline/D_reporting/D1_form_reporting_(Support).js";
import { create_email_failure_outcome } from "../contact_channels/emails/pipeline/E_reporting/E1_email_reporting_(Support).js";
import { create_meeting_failure_outcome } from "../contact_channels/meetings/pipeline/C_reporting/C1_meeting_reporting_(Support).js";
import { create_blocked_discovery_outcome } from "../contact_channels/forms/pipeline/A_discovery/A4_discovery_evidence_(Deterministic).js";
import { open_target_website } from "./B_browser/B_browser_session_(Integration).js";
import { discover_contact_routes } from "./C_contact_routes/C1_contact_route_discovery_(Integration).js";
import { run_contact_channels } from "./D_contact_channel_coordination/D_contact_channel_coordination_(Integration).js";
import { create_contact_outreach_outcome } from "./E_aggregate_reporting/E_aggregate_reporting_(Support).js";
import { describe_error } from "../shared_files_orchestrator/outreach_errors_(Support).js";
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
}

export async function run_contact_outreach_core(
  contact_request: ContactRequest,
  options: ContactOutreachCoreOptions = {},
): Promise<ContactOutreachOutcome> {
  let browser_session: OutreachBrowserSession | undefined;
  try {
    browser_session = await open_target_website(contact_request, {
      ...(options.engine ? { engine: options.engine } : {}),
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
    return create_contact_outreach_outcome(
      channels.forms,
      channels.emails,
      channels.meetings,
    );
  } catch (error) {
    const reason = describe_error(error);
    const failure_kind = browser_session ? "runtime.error" : "navigation.failed";
    const discovery = create_blocked_discovery_outcome(
      contact_request.websiteUrl,
      `Full-run discovery could not be classified reliably: ${reason}`,
    );
    return create_contact_outreach_outcome(
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
  } finally {
    await browser_session?.close().catch(() => undefined);
  }
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
