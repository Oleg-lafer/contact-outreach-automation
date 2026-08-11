import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { pathToFileURL } from "node:url";
import { create_form_failure_outcome } from "./contact_channels/forms/pipeline/D_reporting/D1_form_reporting_(Support).js";
import { create_email_failure_outcome } from "./contact_channels/emails/pipeline/E_reporting/E1_email_reporting_(Support).js";
import { create_meeting_failure_outcome } from "./contact_channels/meetings/pipeline/C_reporting/C1_meeting_reporting_(Support).js";
import {
  load_and_validate_contact_request,
  update_website_run_status,
} from "./orchestrator/A_input/A_contact_input_(Support).js";
import { run_contact_outreach_core } from "./orchestrator/contact_outreach_core_(Integration).js";
import {
  create_contact_outreach_outcome,
  format_contact_outreach_outcome,
  write_contact_outreach_outcome_file,
} from "./orchestrator/E_aggregate_reporting/E_aggregate_reporting_(Support).js";
import {
  DEFAULT_DEEP_DEBUG_OUTPUT_PATH,
  DEFAULT_INPUT_PATH,
  DEFAULT_OUTPUT_PATH,
  DEFAULT_PRODUCTION_OUTPUT_PATH,
  DEFAULT_SHARED_INPUT_PATH,
  resolve_site_watchdog_timeout,
  RUN_MODE_ENVIRONMENT_VARIABLE,
} from "./shared_files_orchestrator/outreach_constants_(Support).js";
import {
  ContactInputError,
  describe_error,
} from "./shared_files_orchestrator/outreach_errors_(Support).js";
import type {
  AutomationEngine,
  AutomationRunMode,
  ContactOutreachOutcome,
  ContactRequest,
} from "./shared_files_orchestrator/outreach_types_(Support).js";

interface CliOptions {
  runMode?: AutomationRunMode;
  inputPath: string;
  outputPath: string;
}

export interface ContactOutreachWorkflowOptions {
  contactValuesPath?: string | undefined;
  runMode?: AutomationRunMode | undefined;
  outputPath?: string | undefined;
  engine?: AutomationEngine | undefined;
}

export async function run_contact_outreach_workflow(
  input_path: string,
  options: ContactOutreachWorkflowOptions = {},
): Promise<ContactOutreachOutcome> {
  let contact_request: ContactRequest | undefined;
  let outcome: ContactOutreachOutcome;

  try {
    contact_request = await load_and_validate_contact_request(
      input_path,
      options.contactValuesPath,
    );

    outcome = await run_contact_outreach_core(contact_request, options);
  } catch (error) {
    const website_url =
      contact_request?.websiteUrl ??
      (error instanceof ContactInputError ? error.websiteUrl : "(unknown)");
    const failure_reason = describe_error(error);
    const failure_kind = error instanceof ContactInputError
      ? "input.invalid"
      : "runtime.error";
    const forms = create_form_failure_outcome(
      website_url,
      failure_reason,
      failure_kind,
    );
    const emails = create_email_failure_outcome(website_url, failure_reason);
    const meetings = create_meeting_failure_outcome(website_url, failure_reason);
    outcome = create_contact_outreach_outcome(
      forms,
      emails,
      meetings,
      "RUN_FAILED",
    );
  }
  await update_website_run_status(contact_request, outcome);
  return outcome;
}

async function main(): Promise<void> {
  load_local_environment_if_present();
  const cli_options = resolve_cli_options(process.argv.slice(2));
  if (cli_options.runMode) {
    process.env[RUN_MODE_ENVIRONMENT_VARIABLE] = cli_options.runMode;
  }

  const site_timeout_ms = resolve_site_watchdog_timeout(process.env);
  const watchdog = setTimeout(() => {
    console.error(
      `Site watchdog stopped the workflow after ${Math.round(site_timeout_ms / 1000)} seconds without completion.`,
    );
    process.exit(124);
  }, site_timeout_ms);
  const outcome = await run_contact_outreach_workflow(
    cli_options.inputPath,
    {
      ...(cli_options.runMode ? { runMode: cli_options.runMode } : {}),
      outputPath: cli_options.outputPath,
    },
  ).finally(() => clearTimeout(watchdog));
  const resolved_output_path = resolve(cli_options.outputPath);
  const report = format_contact_outreach_outcome(
    outcome,
    cli_options.runMode,
    resolved_output_path,
  );
  await write_contact_outreach_outcome_file(cli_options.outputPath, report);
  console.log(report);
  process.exitCode = outcome.status === "SUCCESS" ? 0 : 1;
}

function load_local_environment_if_present(): void {
  const environment_path = resolve(".env");
  if (existsSync(environment_path)) {
    loadEnvFile(environment_path);
  }
}

export { resolve_site_watchdog_timeout } from "./shared_files_orchestrator/outreach_constants_(Support).js";

export function resolve_cli_options(
  args: string[],
  environment: NodeJS.ProcessEnv = process.env,
): CliOptions {
  const maybe_mode = args[0];
  if (is_run_mode(maybe_mode)) {
    return {
      runMode: maybe_mode,
      inputPath: args[1] ?? DEFAULT_SHARED_INPUT_PATH,
      outputPath:
        args[2] ??
        (maybe_mode === "deep-debug"
          ? DEFAULT_DEEP_DEBUG_OUTPUT_PATH
          : DEFAULT_PRODUCTION_OUTPUT_PATH),
    };
  }

  const environment_mode = environment[RUN_MODE_ENVIRONMENT_VARIABLE];
  if (is_run_mode(environment_mode)) {
    return {
      runMode: environment_mode,
      inputPath: args[0] ?? DEFAULT_SHARED_INPUT_PATH,
      outputPath:
        args[1] ??
        (environment_mode === "deep-debug"
          ? DEFAULT_DEEP_DEBUG_OUTPUT_PATH
          : DEFAULT_PRODUCTION_OUTPUT_PATH),
    };
  }

  return {
    inputPath: args[0] ?? DEFAULT_INPUT_PATH,
    outputPath: args[1] ?? DEFAULT_OUTPUT_PATH,
  };
}

function is_run_mode(value: string | undefined): value is AutomationRunMode {
  return value === "production" || value === "deep-debug";
}

const executed_file_url = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : undefined;

if (executed_file_url === import.meta.url) {
  await main();
}
