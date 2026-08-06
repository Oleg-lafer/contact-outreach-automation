import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { pathToFileURL } from "node:url";
import { create_email_failure_outcome } from "./contact_channels/emails/pipeline/E_reporting/E1_email_reporting_(Support).js";
import { create_form_failure_outcome } from "./contact_channels/forms/pipeline/D_reporting/D1_form_reporting_(Support).js";
import { create_meeting_failure_outcome } from "./contact_channels/meetings/pipeline/C_reporting/C1_meeting_reporting_(Support).js";
import { run_contact_outreach_core } from "./orchestrator/contact_outreach_core_(Integration).js";
import {
  create_contact_outreach_outcome,
  format_contact_outreach_outcome,
  write_contact_outreach_outcome_file,
} from "./orchestrator/E_aggregate_reporting/E_aggregate_reporting_(Support).js";
import { resolve_automation_engine } from "./orchestrator/B_browser/B_browser_session_(Integration).js";
import {
  contact_request_from_database,
  create_database_campaign_repository,
  type DatabaseCampaignRepository,
  type DatabaseCandidateMode,
} from "./shared_files_orchestrator/database_campaign_repository_(Integration).js";
import {
  resolve_site_watchdog_timeout,
  RUN_MODE_ENVIRONMENT_VARIABLE,
} from "./shared_files_orchestrator/outreach_constants_(Support).js";
import type {
  AutomationEngine,
  AutomationRunMode,
  ContactOutreachOutcome,
} from "./shared_files_orchestrator/outreach_types_(Support).js";

export interface DatabaseRunnerOptions {
  campaignId: number;
  runMode: AutomationRunMode;
  retryUnsuccessful: boolean;
  preview: boolean;
  outputRoot: string;
}

export interface DatabaseRunSummary {
  campaignId: number;
  eligible: number;
  processed: number;
  succeeded: number;
  partial: number;
  failed: number;
  skipped: number;
  unavailable: number;
  staleAttemptsRecovered: number;
  runDirectory?: string;
  confirmed: boolean;
}

interface DatabaseRunnerDependencies {
  repository: DatabaseCampaignRepository;
  confirm: (message: string) => Promise<boolean>;
  runCore: typeof run_contact_outreach_core;
  engine?: AutomationEngine;
  now: () => Date;
}

export async function run_database_campaign(
  options: DatabaseRunnerOptions,
  dependencies: DatabaseRunnerDependencies,
): Promise<DatabaseRunSummary> {
  const { repository } = dependencies;
  const campaign = await repository.loadCampaign(options.campaignId);
  const mode: DatabaseCandidateMode = options.retryUnsuccessful
    ? "retry-unsuccessful"
    : "unattempted";
  const now = dependencies.now();
  const staleAttemptsRecovered = options.preview
    ? 0
    : await repository.recoverStaleAttempts(
        options.campaignId,
        new Date(now.getTime() - resolve_site_watchdog_timeout() - 60_000),
      );
  const candidates = await repository.snapshotCandidates(options.campaignId, mode);
  const base: DatabaseRunSummary = {
    campaignId: options.campaignId,
    eligible: candidates.length,
    processed: 0,
    succeeded: 0,
    partial: 0,
    failed: 0,
    skipped: 0,
    unavailable: 0,
    staleAttemptsRecovered,
    confirmed: false,
  };

  if (options.preview || candidates.length === 0) return base;

  const engine = dependencies.engine ?? resolve_automation_engine(undefined);
  const confirmed = await dependencies.confirm(
    `Campaign ${campaign.campaignId}: ${campaign.campaignName}\n` +
    `Eligible websites: ${candidates.length}\nRun mode: ${options.runMode}\n` +
    `Engine: ${engine}\nType RUN to start live submissions: `,
  );
  if (!confirmed) return base;

  const runId = format_run_id(now);
  const runDirectory = resolve(
    options.outputRoot,
    `campaign-${options.campaignId}`,
    runId,
  );
  await mkdir(runDirectory, { recursive: true });
  const summary: DatabaseRunSummary = {
    ...base,
    runDirectory,
    confirmed: true,
  };

  for (const candidate of candidates) {
    const claim = await repository.claimWebsite(campaign, candidate.websiteId, mode);
    if (claim.action === "unavailable") {
      summary.unavailable++;
      continue;
    }
    const siteDirectory = resolve(runDirectory, `website-${candidate.websiteId}`);
    const reportPath = resolve(siteDirectory, `${options.runMode}.txt`);
    await mkdir(siteDirectory, { recursive: true });
    let outcome: ContactOutreachOutcome;
    if (claim.action === "skip") {
      outcome = resend_prevented_outcome(claim.website.websiteUrl, claim.reason);
      summary.skipped++;
    } else {
      try {
        const request = contact_request_from_database(campaign, claim.website);
        outcome = await dependencies.runCore(request, {
          runMode: options.runMode,
          outputPath: reportPath,
          engine,
        });
      } catch (error) {
        outcome = database_input_failure_outcome(
          claim.website.websiteUrl,
          error instanceof Error ? error.message : String(error),
        );
      }
      await repository.completeAttempt(claim.attemptId, outcome);
      summary.processed++;
      if (outcome.status === "SUCCESS") summary.succeeded++;
      else if (outcome.status === "PARTIAL" || outcome.status === "INCONCLUSIVE") {
        summary.partial++;
      } else summary.failed++;
    }
    const report = format_contact_outreach_outcome(
      outcome,
      options.runMode,
      reportPath,
    );
    await write_contact_outreach_outcome_file(reportPath, report);
  }

  await writeFile(
    resolve(runDirectory, "summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
    "utf8",
  );
  return summary;
}

function database_input_failure_outcome(
  websiteUrl: string,
  reason: string,
): ContactOutreachOutcome {
  return create_contact_outreach_outcome(
    create_form_failure_outcome(websiteUrl, reason, "input.invalid"),
    create_email_failure_outcome(websiteUrl, reason),
    create_meeting_failure_outcome(websiteUrl, reason),
    "RUN_FAILED",
  );
}

export function resolve_database_runner_options(
  args: string[],
  environment: NodeJS.ProcessEnv = process.env,
): DatabaseRunnerOptions {
  const runMode = args[0];
  if (runMode !== "production" && runMode !== "deep-debug") {
    throw new Error("Database run mode must be production or deep-debug.");
  }
  let campaignIdText = environment.OUTREACH_CAMPAIGN_ID;
  let retryUnsuccessful = false;
  let preview = false;
  let outputRoot = "output/database";
  for (let index = 1; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--retry-unsuccessful") retryUnsuccessful = true;
    else if (argument === "--preview") preview = true;
    else if (argument === "--campaign-id") campaignIdText = args[++index];
    else if (argument === "--output-root") outputRoot = args[++index] ?? "";
    else throw new Error(`Unknown database runner argument: ${argument}`);
  }
  const campaignId = Number(campaignIdText);
  if (!Number.isSafeInteger(campaignId) || campaignId <= 0) {
    throw new Error("--campaign-id or OUTREACH_CAMPAIGN_ID must be a positive integer.");
  }
  if (!outputRoot.trim()) throw new Error("--output-root must not be empty.");
  return { campaignId, runMode, retryUnsuccessful, preview, outputRoot };
}

async function prompt_for_run(message: string): Promise<boolean> {
  const terminal = createInterface({ input, output });
  try {
    return (await terminal.question(message)) === "RUN";
  } finally {
    terminal.close();
  }
}

function resend_prevented_outcome(
  websiteUrl: string,
  reason: string,
): ContactOutreachOutcome {
  return create_contact_outreach_outcome(
    create_form_failure_outcome(websiteUrl, reason, "outreach.resend_prevented"),
    create_email_failure_outcome(websiteUrl, reason),
    create_meeting_failure_outcome(websiteUrl, reason),
    "SKIPPED",
  );
}

function format_run_id(value: Date): string {
  return value.toISOString().replaceAll(/[:.]/g, "-");
}

async function main(): Promise<void> {
  const environmentPath = resolve(".env");
  if (existsSync(environmentPath)) loadEnvFile(environmentPath);
  const options = resolve_database_runner_options(process.argv.slice(2));
  process.env[RUN_MODE_ENVIRONMENT_VARIABLE] = options.runMode;
  const repository = create_database_campaign_repository();
  try {
    const summary = await run_database_campaign(options, {
      repository,
      confirm: prompt_for_run,
      runCore: run_contact_outreach_core,
      now: () => new Date(),
    });
    console.log(JSON.stringify(summary, null, 2));
    process.exitCode = summary.failed > 0 || summary.partial > 0 ? 1 : 0;
  } finally {
    await repository.close();
  }
}

const executedFileUrl = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : undefined;
if (executedFileUrl === import.meta.url) await main();
