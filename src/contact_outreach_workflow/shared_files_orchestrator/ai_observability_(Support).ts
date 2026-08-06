import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
  AiActionEvidence,
  AiAssistanceSummary,
  AiUsageSummary,
} from "./outreach_types_(Support).js";

const AI_ACTIONS_ARTIFACT_NAME = "ai-actions.json";

export function create_ai_operation_evidence(options: {
  stage: AiActionEvidence["stage"];
  placeholderInstruction: string;
  method: "observe" | "act" | "extract";
  model: string;
  durationMs: number;
  acceptanceReason: string;
  result: "observed" | "notRun" | "failed";
}): AiActionEvidence {
  return {
    stage: options.stage,
    placeholderInstruction: options.placeholderInstruction,
    selector: "",
    method: options.method,
    acceptance: "rejected",
    acceptanceReason: options.acceptanceReason,
    result: options.result,
    model: options.model,
    durationMs: options.durationMs,
  };
}

export function summarize_ai_assistance(
  ...action_groups: Array<AiActionEvidence[] | undefined>
): AiAssistanceSummary | undefined {
  const actions = action_groups.flatMap((group) => group ?? []);
  if (actions.length === 0) {
    return undefined;
  }

  return {
    actionCount: actions.length,
    acceptedActionCount: actions.filter(
      (action) => action.acceptance === "accepted",
    ).length,
    rejectedActionCount: actions.filter(
      (action) => action.acceptance === "rejected",
    ).length,
    actions,
  };
}

export function attach_ai_usage_summary(
  summary: AiAssistanceSummary | undefined,
  usage: AiUsageSummary | undefined,
): AiAssistanceSummary | undefined {
  const recorded_usage = usage && usage.requestCount > 0 ? usage : undefined;
  if (!summary && !recorded_usage) {
    return undefined;
  }

  return {
    ...(summary ?? {
      actionCount: 0,
      acceptedActionCount: 0,
      rejectedActionCount: 0,
      actions: [],
    }),
    ...(recorded_usage ? { usage: recorded_usage } : {}),
  };
}

export async function write_ai_assistance_artifact(
  summary: AiAssistanceSummary | undefined,
  artifact_directory: string | undefined,
  redaction_values: string[] = [],
): Promise<AiAssistanceSummary | undefined> {
  if (!summary || !artifact_directory) {
    return summary;
  }

  const absolute_artifact_directory = resolve(artifact_directory);
  const artifact_path = join(
    absolute_artifact_directory,
    AI_ACTIONS_ARTIFACT_NAME,
  );
  const safe_summary = redact_ai_assistance(summary, redaction_values);
  const persisted_summary: AiAssistanceSummary = {
    ...safe_summary,
    artifactPath: artifact_path,
  };

  await mkdir(absolute_artifact_directory, { recursive: true });
  await writeFile(
    artifact_path,
    `${JSON.stringify(
      {
        version: 1,
        generatedAt: new Date().toISOString(),
        summary: persisted_summary,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  return persisted_summary;
}

function redact_ai_assistance(
  summary: AiAssistanceSummary,
  redaction_values: string[],
): AiAssistanceSummary {
  return {
    ...summary,
    actions: summary.actions.map((action) => ({
      ...action,
      placeholderInstruction: redact_text(
        action.placeholderInstruction,
        redaction_values,
      ),
      selector: redact_text(action.selector, redaction_values),
      method: redact_text(action.method, redaction_values),
      acceptanceReason: redact_text(action.acceptanceReason, redaction_values),
      model: redact_text(action.model, redaction_values),
      ...(action.resultMessage
        ? { resultMessage: redact_text(action.resultMessage, redaction_values) }
        : {}),
    })),
  };
}

function redact_text(value: string, redaction_values: string[]): string {
  let redacted = value;
  for (const sensitive_value of redaction_values) {
    if (!sensitive_value) {
      continue;
    }

    redacted = redacted.replaceAll(sensitive_value, "[redacted contact value]");
  }
  return redacted;
}
