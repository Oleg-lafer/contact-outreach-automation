import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  build_form_report_sections,
} from "../../contact_channels/forms/pipeline/D_reporting/D1_form_reporting_(Support).js";
import { build_email_report_sections } from "../../contact_channels/emails/pipeline/E_reporting/E1_email_reporting_(Support).js";
import type { EmailChannelOutcome } from "../../contact_channels/emails/shared_files_emails/email_types_(Support).js";
import type { FormChannelOutcome } from "../../contact_channels/forms/shared_files_forms/forms_types_(Support).js";
import { build_meeting_report_sections } from "../../contact_channels/meetings/pipeline/C_reporting/C1_meeting_reporting_(Support).js";
import type { MeetingChannelOutcome } from "../../contact_channels/meetings/shared_files_meetings/meeting_types_(Support).js";
import type {
  AutomationRunMode,
  ContactOutreachOutcome,
  ReportSection,
  WorkflowExecutionStatus,
} from "../../shared_files_orchestrator/outreach_types_(Support).js";

export function create_contact_outreach_outcome(
  forms: FormChannelOutcome,
  emails: EmailChannelOutcome,
  meetings: MeetingChannelOutcome,
  execution_status: WorkflowExecutionStatus = "FINISHED",
): ContactOutreachOutcome {
  return {
    websiteUrl: forms.websiteUrl,
    executionStatus: execution_status,
    status: forms.status,
    ...(forms.reason ? { reason: forms.reason } : {}),
    ...(forms.failureKind ? { failureKind: forms.failureKind } : {}),
    channels: { forms, emails, meetings },
  };
}

export function format_contact_outreach_outcome(
  outcome: ContactOutreachOutcome,
  run_mode?: AutomationRunMode,
  output_path?: string,
): string {
  const sections: ReportSection[] = [
    {
      title: "RUN",
      lines: [
        ...(run_mode ? [`Run mode: ${run_mode}`] : []),
        `Execution status: ${outcome.executionStatus}`,
        `Website: ${outcome.websiteUrl}`,
      ],
    },
    {
      title: "CHANNEL SUMMARY",
      lines: [
        `Forms status: ${outcome.channels.forms.status}`,
        `Emails status: ${outcome.channels.emails.status}`,
        `Meetings status: ${outcome.channels.meetings.status}`,
      ],
    },
    ...build_form_report_sections(outcome.channels.forms, output_path),
    ...build_email_report_sections(outcome.channels.emails),
    ...build_meeting_report_sections(outcome.channels.meetings),
  ];

  return sections
    .map(
      (section) =>
        [`==================== ${section.title} ====================`, ...section.lines]
          .join("\n"),
    )
    .join("\n\n");
}

export async function write_contact_outreach_outcome_file(
  output_path: string,
  report: string,
): Promise<void> {
  const absolute_output_path = resolve(output_path);
  await mkdir(dirname(absolute_output_path), { recursive: true });
  await writeFile(absolute_output_path, `${report}\n`, "utf8");
}
