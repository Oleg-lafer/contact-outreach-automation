import { run_emails_workflow } from "../../contact_channels/emails/emails_orchestrator.js";
import {
  run_forms_workflow,
  type FormsWorkflowOptions,
} from "../../contact_channels/forms/forms_orchestrator.js";
import { run_meetings_workflow } from "../../contact_channels/meetings/meetings_orchestrator.js";
import type {
  ContactOutreachOutcome,
  ContactRequest,
  ContactRouteDiscoveryResult,
  OutreachBrowserSession,
} from "../../shared_files_orchestrator/outreach_types_(Support).js";

export async function run_contact_channels(options: {
  contactRequest: ContactRequest;
  browserSession: OutreachBrowserSession;
  contactRoutes: ContactRouteDiscoveryResult;
  forms: FormsWorkflowOptions;
}): Promise<ContactOutreachOutcome["channels"]> {
  const emails = await run_emails_workflow(
    options.contactRequest,
    options.browserSession,
    options.contactRoutes,
  );
  const meetings = await run_meetings_workflow(
    options.contactRequest,
    options.browserSession,
    options.contactRoutes,
  );
  const forms = await run_forms_workflow(
    options.contactRequest,
    options.browserSession,
    options.contactRoutes,
    options.forms,
  );

  return { forms, emails, meetings };
}
