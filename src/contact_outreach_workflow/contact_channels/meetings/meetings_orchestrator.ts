import { describe_error } from "../../shared_files_orchestrator/outreach_errors_(Support).js";
import type {
  ContactRequest,
  ContactRouteDiscoveryResult,
  OutreachBrowserSession,
} from "../../shared_files_orchestrator/outreach_types_(Support).js";
import { discover_meeting_scheduling_links } from "./pipeline/A_discovery/A1_meeting_discovery_(Integration).js";
import {
  create_meeting_channel_outcome,
  create_meeting_failure_outcome,
} from "./pipeline/C_reporting/C1_meeting_reporting_(Support).js";
import type { MeetingChannelOutcome } from "./shared_files_meetings/meeting_types_(Support).js";

export async function run_meetings_workflow(
  contact_request: ContactRequest,
  browser_session: OutreachBrowserSession,
  contact_routes: ContactRouteDiscoveryResult,
): Promise<MeetingChannelOutcome> {
  let meeting_page: Awaited<
    ReturnType<OutreachBrowserSession["createChannelPage"]>
  > | undefined;

  try {
    meeting_page = await browser_session.createChannelPage();
    const discovery = await discover_meeting_scheduling_links(
      meeting_page,
      contact_routes,
    );
    return create_meeting_channel_outcome(
      contact_request.websiteUrl,
      discovery,
    );
  } catch (error) {
    return create_meeting_failure_outcome(
      contact_request.websiteUrl,
      `Meeting discovery failed: ${describe_error(error)}`,
    );
  } finally {
    await meeting_page?.close().catch(() => undefined);
  }
}
