import type { AutomationStatus } from "../../../shared_files_orchestrator/outreach_types_(Support).js";

export type EmailFailureKind =
  | "email.discovery.no_address"
  | "email.discovery.incomplete"
  | "email.discovery.failed";

export interface EmailPageFailure {
  url: string;
  reason: string;
}

export interface EmailDiscoveryResult {
  emails: string[];
  plannedPages: string[];
  inspectedPages: string[];
  failedPages: EmailPageFailure[];
}

export interface EmailChannelOutcome {
  websiteUrl: string;
  status: AutomationStatus;
  emails: string[];
  plannedPageCount: number;
  inspectedPages: string[];
  failedPages: EmailPageFailure[];
  failureKind?: EmailFailureKind;
  reason?: string;
}
