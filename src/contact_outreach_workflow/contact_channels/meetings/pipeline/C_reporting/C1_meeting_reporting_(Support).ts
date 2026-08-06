import type { ReportSection } from "../../../../shared_files_orchestrator/outreach_types_(Support).js";
import type {
  MeetingChannelOutcome,
  MeetingDiscoveryResult,
  MeetingFailureKind,
  MeetingSchedulingLink,
} from "../../shared_files_meetings/meeting_types_(Support).js";

export function create_meeting_channel_outcome(
  website_url: string,
  discovery: MeetingDiscoveryResult,
): MeetingChannelOutcome {
  const planned_page_count = discovery.plannedPages.length;
  const inspected_page_count = discovery.inspectedPages.length;

  if (inspected_page_count === 0) {
    return {
      websiteUrl: website_url,
      status: "FAILED",
      meetingLinks: discovery.meetingLinks,
      plannedPageCount: planned_page_count,
      inspectedPages: discovery.inspectedPages,
      failedPages: discovery.failedPages,
      failureKind: "meeting.discovery.failed",
      reason:
        discovery.failedPages.length > 0
          ? "Meeting discovery could not inspect any planned same-origin page."
          : "Meeting discovery had no same-origin pages to inspect.",
    };
  }

  if (discovery.failedPages.length > 0) {
    return {
      websiteUrl: website_url,
      status: "PARTIAL",
      meetingLinks: discovery.meetingLinks,
      plannedPageCount: planned_page_count,
      inspectedPages: discovery.inspectedPages,
      failedPages: discovery.failedPages,
      failureKind: "meeting.discovery.incomplete",
      reason: `Meeting discovery inspected ${inspected_page_count} of ${planned_page_count} planned same-origin pages.`,
    };
  }

  if (discovery.meetingLinks.length === 0) {
    return {
      websiteUrl: website_url,
      status: "FAILED",
      meetingLinks: [],
      plannedPageCount: planned_page_count,
      inspectedPages: discovery.inspectedPages,
      failedPages: [],
      failureKind: "meeting.discovery.no_option",
      reason:
        "No qualifying business meeting-scheduling link was found on the inspected pages.",
    };
  }

  return {
    websiteUrl: website_url,
    status: "SUCCESS",
    meetingLinks: discovery.meetingLinks,
    plannedPageCount: planned_page_count,
    inspectedPages: discovery.inspectedPages,
    failedPages: [],
  };
}

export function create_meeting_failure_outcome(
  website_url: string,
  reason: string,
  failure_kind: MeetingFailureKind = "meeting.discovery.failed",
): MeetingChannelOutcome {
  return {
    websiteUrl: website_url,
    status: "FAILED",
    meetingLinks: [],
    plannedPageCount: 0,
    inspectedPages: [],
    failedPages: [],
    failureKind: failure_kind,
    reason,
  };
}

export function build_meeting_report_sections(
  outcome: MeetingChannelOutcome,
): ReportSection[] {
  return [
    {
      title: "MEETING DISCOVERY",
      lines: [
        `Meeting status: ${outcome.status}`,
        ...(outcome.reason ? [`Meeting reason: ${outcome.reason}`] : []),
        ...(outcome.failureKind
          ? [`Meeting failure kind: ${outcome.failureKind}`]
          : []),
        `Meeting link count: ${outcome.meetingLinks.length}`,
        ...outcome.meetingLinks.map(format_meeting_link),
        `Meeting planned pages: ${outcome.plannedPageCount}`,
        `Meeting inspected pages: ${outcome.inspectedPages.length}`,
        `Meeting failed pages: ${outcome.failedPages.length}`,
        ...outcome.failedPages.map(
          (failure) =>
            `Meeting failed page: ${failure.url} - ${failure.reason}`,
        ),
      ],
    },
  ];
}

function format_meeting_link(link: MeetingSchedulingLink): string {
  const sources = link.sources
    .map(
      (source) =>
        `${source.pageUrl} [${source.kind}${source.label ? `: ${source.label}` : ""}]`,
    )
    .join(", ");
  return `Meeting link: ${link.url} (provider: ${link.provider}; sources: ${sources})`;
}
