import { describe_error } from "../../shared_files_orchestrator/outreach_errors_(Support).js";
import type {
  ContactRequest,
  ContactRouteDiscoveryResult,
  OutreachBrowserSession,
} from "../../shared_files_orchestrator/outreach_types_(Support).js";
import { discover_published_emails } from "./pipeline/A_discovery/A1_email_discovery_(Integration).js";
import {
  create_email_channel_outcome,
  create_email_failure_outcome,
} from "./pipeline/E_reporting/E1_email_reporting_(Support).js";
import type { EmailChannelOutcome } from "./shared_files_emails/email_types_(Support).js";

export async function run_emails_workflow(
  contact_request: ContactRequest,
  browser_session: OutreachBrowserSession,
  contact_routes: ContactRouteDiscoveryResult,
): Promise<EmailChannelOutcome> {
  let email_page: Awaited<
    ReturnType<OutreachBrowserSession["createChannelPage"]>
  > | undefined;

  try {
    email_page = await browser_session.createChannelPage();
    const discovery = await discover_published_emails(
      email_page,
      contact_routes,
      contact_request.email,
    );
    return create_email_channel_outcome(contact_request.websiteUrl, discovery);
  } catch (error) {
    return create_email_failure_outcome(
      contact_request.websiteUrl,
      `Email discovery failed: ${describe_error(error)}`,
    );
  } finally {
    await email_page?.close().catch(() => undefined);
  }
}
