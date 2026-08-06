import type { AutomationStatus } from "../../../shared_files_orchestrator/outreach_types_(Support).js";

export type MeetingProvider =
  | "calendly"
  | "cal.com"
  | "hubspot"
  | "chili-piper"
  | "custom";

export type MeetingEvidenceKind = "visible_link" | "embedded_widget";

export type MeetingFailureKind =
  | "meeting.discovery.no_option"
  | "meeting.discovery.incomplete"
  | "meeting.discovery.failed";

export interface MeetingLinkSource {
  pageUrl: string;
  kind: MeetingEvidenceKind;
  label?: string;
}

export interface MeetingSchedulingLink {
  url: string;
  provider: MeetingProvider;
  sources: MeetingLinkSource[];
}

export interface MeetingPageFailure {
  url: string;
  reason: string;
}

export interface MeetingDiscoveryResult {
  meetingLinks: MeetingSchedulingLink[];
  plannedPages: string[];
  inspectedPages: string[];
  failedPages: MeetingPageFailure[];
}

export interface MeetingChannelOutcome {
  websiteUrl: string;
  status: AutomationStatus;
  meetingLinks: MeetingSchedulingLink[];
  plannedPageCount: number;
  inspectedPages: string[];
  failedPages: MeetingPageFailure[];
  failureKind?: MeetingFailureKind;
  reason?: string;
}
