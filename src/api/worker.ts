import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import mysql from "mysql2/promise";
import { database_config_from_environment } from "../contact_outreach_workflow/shared_files_orchestrator/outreach_database_(Integration).js";
import { acquire_execution_lock } from "../contact_outreach_workflow/shared_files_orchestrator/execution_lock_(Integration).js";
import { MysqlDatabaseCampaignRepository } from "../contact_outreach_workflow/shared_files_orchestrator/database_campaign_repository_(Integration).js";
import { run_database_campaign } from "../contact_outreach_workflow/database_outreach_runner.js";
import { run_contact_outreach_core } from "../contact_outreach_workflow/orchestrator/contact_outreach_core_(Integration).js";
import { RUN_MODE_ENVIRONMENT_VARIABLE } from "../contact_outreach_workflow/shared_files_orchestrator/outreach_constants_(Support).js";
import { MysqlLaunchRepository, requireLaunchSchema } from "./mysql_launch_repository.js";
import { run_worker } from "./launch_worker.js";

if (existsSync(".env")) loadEnvFile(".env");
const configuration = database_config_from_environment(process.env);
if (configuration.database !== "leadspot_main") throw new Error("The worker requires DB_NAME=leadspot_main.");
const pool = mysql.createPool({ ...configuration, connectionLimit: 5 });
const stop = new AbortController();
process.once("SIGINT", () => stop.abort());
process.once("SIGTERM", () => stop.abort());
try {
  await requireLaunchSchema(pool);
  console.log("ContactUs launch worker started.");
  await run_worker({
    queue: new MysqlLaunchRepository(pool), acquireLock: () => acquire_execution_lock(),
    execute: async (run, signal) => {
      process.env[RUN_MODE_ENVIRONMENT_VARIABLE] = run.runMode;
      console.log(`ContactUs run ${run.runNumber} started for campaign ${run.campaignId}.`);
      return run_database_campaign({ campaignId: run.campaignId, runMode: run.runMode,
        retryUnsuccessful: false, preview: false, confirmed: true, outputRoot: "output/database",
        runNumber: run.runNumber, websiteIdUpperBound: run.websiteIdUpperBound, signal }, {
        repository: new MysqlDatabaseCampaignRepository(pool), runCore: run_contact_outreach_core, now: () => new Date(),
      });
    },
  }, stop.signal);
} catch {
  if (!stop.signal.aborted) { console.error("ContactUs worker stopped. Check database connectivity, launch schema, and server logs."); process.exitCode = 1; }
} finally { await pool.end(); }
