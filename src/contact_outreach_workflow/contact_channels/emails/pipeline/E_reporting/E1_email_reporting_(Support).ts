import type { ReportSection } from "../../../../shared_files_orchestrator/outreach_types_(Support).js";
import type {
  EmailChannelOutcome,
  EmailDiscoveryResult,
  EmailFailureKind,
} from "../../shared_files_emails/email_types_(Support).js";

export function create_email_channel_outcome(
  website_url: string,
  discovery: EmailDiscoveryResult,
): EmailChannelOutcome {
  const planned_page_count = discovery.plannedPages.length;
  const inspected_page_count = discovery.inspectedPages.length;

  if (inspected_page_count === 0) {
    return {
      websiteUrl: website_url,
      status: "FAILED",
      emails: discovery.emails,
      plannedPageCount: planned_page_count,
      inspectedPages: discovery.inspectedPages,
      failedPages: discovery.failedPages,
      failureKind: "email.discovery.failed",
      reason:
        discovery.failedPages.length > 0
          ? "Email discovery could not inspect any planned same-origin page."
          : "Email discovery had no same-origin pages to inspect.",
    };
  }

  if (discovery.failedPages.length > 0) {
    return {
      websiteUrl: website_url,
      status: "PARTIAL",
      emails: discovery.emails,
      plannedPageCount: planned_page_count,
      inspectedPages: discovery.inspectedPages,
      failedPages: discovery.failedPages,
      failureKind: "email.discovery.incomplete",
      reason: `Email discovery inspected ${inspected_page_count} of ${planned_page_count} planned same-origin pages.`,
    };
  }

  if (discovery.emails.length === 0) {
    return {
      websiteUrl: website_url,
      status: "FAILED",
      emails: [],
      plannedPageCount: planned_page_count,
      inspectedPages: discovery.inspectedPages,
      failedPages: [],
      failureKind: "email.discovery.no_address",
      reason: "No usable published email address was found on the inspected pages.",
    };
  }

  return {
    websiteUrl: website_url,
    status: "SUCCESS",
    emails: discovery.emails,
    plannedPageCount: planned_page_count,
    inspectedPages: discovery.inspectedPages,
    failedPages: [],
  };
}

export function create_email_failure_outcome(
  website_url: string,
  reason: string,
  failure_kind: EmailFailureKind = "email.discovery.failed",
): EmailChannelOutcome {
  return {
    websiteUrl: website_url,
    status: "FAILED",
    emails: [],
    plannedPageCount: 0,
    inspectedPages: [],
    failedPages: [],
    failureKind: failure_kind,
    reason,
  };
}

export function build_email_report_sections(
  outcome: EmailChannelOutcome,
): ReportSection[] {
  return [
    {
      title: "EMAIL DISCOVERY",
      lines: [
        `Email status: ${outcome.status}`,
        ...(outcome.reason ? [`Email reason: ${outcome.reason}`] : []),
        ...(outcome.failureKind
          ? [`Email failure kind: ${outcome.failureKind}`]
          : []),
        `Email count: ${outcome.emails.length}`,
        ...outcome.emails.map((email) => `Discovered email: ${email}`),
        `Email planned pages: ${outcome.plannedPageCount}`,
        `Email inspected pages: ${outcome.inspectedPages.length}`,
        `Email failed pages: ${outcome.failedPages.length}`,
        ...outcome.failedPages.map(
          (failure) =>
            `Email failed page: ${failure.url} — ${failure.reason}`,
        ),
      ],
    },
  ];
}
