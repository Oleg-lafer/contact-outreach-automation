import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { pathToFileURL } from "node:url";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { database_config_from_environment } from "../contact_outreach_workflow/shared_files_orchestrator/outreach_database_(Integration).js";

import { EXECUTION_LOCK_NAME } from "../contact_outreach_workflow/shared_files_orchestrator/execution_lock_(Integration).js";
import { migrate_campaign_run_storage, assert_no_active_attempts } from "./migrate_campaign_run_storage.js";

const BASELINE_MIGRATION_PATH =
  "database/migrations/001_create_outreach_tables.sql";
const CHANNEL_RESULTS_MIGRATION_PATH =
  "database/migrations/002_separate_execution_and_channel_results.sql";
const CAMPAIGN_CONTENT_MIGRATION_PATH =
  "database/migrations/003_normalize_campaign_content.sql";
const WEBSITE_CAMPAIGN_MIGRATION_PATH =
  "database/migrations/004_assign_websites_to_campaigns.sql";
const TIMED_OUT_STATUS_MIGRATION_PATH =
  "database/migrations/005_add_timed_out_execution_status.sql";
const RESULT_COLUMNS = [
  "forms_result",
  "email_discovery_result",
  "meeting_discovery_result",
] as const;

interface ColumnRow extends RowDataPacket {
  TABLE_NAME: string;
  COLUMN_NAME: string;
  COLUMN_TYPE: string;
}

export type AttemptSchemaState = "legacy" | "final" | "partial";
export type WebsiteCampaignSchemaState = "legacy" | "final" | "partial";

export function classify_attempt_schema(
  columns: ReadonlyArray<{ name: string; type: string }>,
): AttemptSchemaState {
  const by_name = new Map(columns.map((column) => [column.name, column.type]));
  const result_column_count = RESULT_COLUMNS.filter((column) =>
    by_name.has(column),
  ).length;
  const execution_type = by_name.get("execution_status")?.toLowerCase() ?? "";
  const has_final_execution_values =
    execution_type.includes("'finished'") &&
    execution_type.includes("'run_failed'") &&
    !execution_type.includes("'succeeded'") &&
    !execution_type.includes("'partial'");

  if (result_column_count === 0 && !has_final_execution_values) return "legacy";
  if (result_column_count === RESULT_COLUMNS.length && has_final_execution_values) {
    return "final";
  }
  return "partial";
}

export function classify_website_campaign_schema(
  website_columns: readonly string[],
  attempt_columns: readonly string[],
): WebsiteCampaignSchemaState {
  const website_has_campaign = website_columns.includes("campaign_id");
  const attempt_has_campaign = attempt_columns.includes("campaign_id");
  if (!website_has_campaign && attempt_has_campaign) return "legacy";
  if (website_has_campaign && !attempt_has_campaign) return "final";
  return "partial";
}

async function main(): Promise<void> {
  if (!process.argv.includes("--maintenance-confirmed")) throw new Error("Pause API, worker, and scheduled outreach; then pass --maintenance-confirmed.");
  if (existsSync(resolve(".env"))) loadEnvFile(resolve(".env"));
  const configuration = database_config_from_environment(process.env);
  if (configuration.database !== "leadspot_main") throw new Error("Migration requires DB_NAME=leadspot_main.");
  const connection = await mysql.createConnection({
    ...configuration,
    multipleStatements: true, timezone: "Z", dateStrings: true, supportBigNumbers: true, bigNumberStrings: true,
  });

  const preserveArgument = process.argv.indexOf("--preserve-stale-attempt-ids");
  const preserveStaleAttemptIds = preserveArgument < 0 ? [] : (process.argv[preserveArgument + 1] ?? "").split(",").map(value => {
    if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error("Invalid stale attempt ID.");
    return Number(value);
  });
  let held = false;
  try {
    const [target] = await connection.query<RowDataPacket[]>("SELECT DATABASE() AS name, TIMESTAMPDIFF(SECOND,UTC_TIMESTAMP(),NOW()) AS utcOffset");
    if (target[0]?.name !== "leadspot_main" || Number(target[0]?.utcOffset) !== 0) throw new Error("Migration requires leadspot_main and UTC database session time.");
    const [lock] = await connection.query<RowDataPacket[]>("SELECT GET_LOCK(?, 0) AS acquired", [EXECUTION_LOCK_NAME]);
    if (Number(lock[0]?.acquired) !== 1) throw new Error("Outreach is active. Migration stopped.");
    held = true;
    const [present] = await connection.query<RowDataPacket[]>(
      "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('OUTREACH_attempts','OUTREACH_runs')");
    if (present.some(row => row.TABLE_NAME === "OUTREACH_attempts")) {
      await assert_no_active_attempts(connection, preserveStaleAttemptIds);
    }
    if (present.some(row => row.TABLE_NAME === "OUTREACH_runs")) {
      const [active] = await connection.query<RowDataPacket[]>("SELECT COUNT(*) AS count FROM OUTREACH_runs WHERE state IN ('queued','running')");
      if (Number(active[0]?.count)) throw new Error("Pending runs exist. Migration stopped.");
    }
    await execute_migration(connection, BASELINE_MIGRATION_PATH);
    const initial_state = await read_attempt_schema_state(connection);
    if (initial_state === "partial") {
      throw new Error(
        "OUTREACH_attempts is partially migrated; refusing to apply another schema change.",
      );
    }
    if (initial_state === "legacy") {
      await execute_migration(connection, CHANNEL_RESULTS_MIGRATION_PATH);
    }
    const [campaignColumns] = await connection.query<RowDataPacket[]>(
      "SELECT COLUMN_NAME AS name, DATA_TYPE AS type FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'OUTREACH_campaigns' AND COLUMN_NAME IN ('sender_details','message_to_send')");
    if (campaign_content_requires_migration(campaignColumns as Array<RowDataPacket & { name: string; type: string }>)) {
      await execute_migration(connection, CAMPAIGN_CONTENT_MIGRATION_PATH);
    }
    const ownership_state = await read_website_campaign_schema_state(connection);
    if (ownership_state === "partial") {
      throw new Error(
        "Website campaign ownership is partially migrated; refusing to apply another schema change.",
      );
    }
    if (ownership_state === "legacy") {
      await execute_migration(connection, WEBSITE_CAMPAIGN_MIGRATION_PATH);
    }
    const execution_status_type = await read_execution_status_type(connection);
    const timed_out_status_missing = !execution_status_type.includes("'timed_out'");
    if (timed_out_status_missing) {
      await execute_migration(connection, TIMED_OUT_STATUS_MIGRATION_PATH);
    }

    const final_state = await read_attempt_schema_state(connection);
    if (final_state !== "final") {
      throw new Error(
        `Outreach database migration ended in unexpected state: ${final_state}.`,
      );
    }
    const final_ownership_state =
      await read_website_campaign_schema_state(connection);
    if (final_ownership_state !== "final") {
      throw new Error(
        `Website campaign migration ended in unexpected state: ${final_ownership_state}.`,
      );
    }
    const final_execution_status_type = await read_execution_status_type(connection);
    if (!final_execution_status_type.includes("'timed_out'")) {
      throw new Error("Outreach database migration did not add the timed_out lifecycle status.");
    }
    const backupArgument = process.argv.indexOf("--backup-dir");
    const migration = await migrate_campaign_run_storage(connection, { maintenanceConfirmed: true, preserveStaleAttemptIds,
      backupDirectory: backupArgument < 0 ? resolve("..", "database-backups") : process.argv[backupArgument + 1]! });
    console.log(JSON.stringify(migration));
    console.log(
      initial_state === "legacy" || ownership_state === "legacy" || timed_out_status_missing
        ? "Applied pending core migrations and verified campaign run storage."
        : "Core schema is current. Applied or verified the campaign run storage migration.",
    );
  } finally {
    try { if (held) await connection.query("SELECT RELEASE_LOCK(?)", [EXECUTION_LOCK_NAME]); } finally { await connection.end(); }
  }
}

export function campaign_content_requires_migration(columns: ReadonlyArray<{ name: string; type: string }>): boolean {
  const byName = new Map(columns.map(column => [column.name, column.type.toLowerCase()]));
  return byName.get("sender_details") !== "json" || byName.get("message_to_send") !== "text";
}

async function read_execution_status_type(connection: Connection): Promise<string> {
  const database_name = required_value(process.env.DB_NAME, "DB_NAME");
  const [rows] = await connection.execute<ColumnRow[]>(
    `SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ?
       AND TABLE_NAME = 'OUTREACH_attempts'
       AND COLUMN_NAME = 'execution_status'`,
    [database_name],
  );
  return rows[0]?.COLUMN_TYPE.toLowerCase() ?? "";
}

async function read_website_campaign_schema_state(
  connection: Connection,
): Promise<WebsiteCampaignSchemaState> {
  const database_name = required_value(process.env.DB_NAME, "DB_NAME");
  const [rows] = await connection.execute<ColumnRow[]>(
    `SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ?
       AND TABLE_NAME IN ('OUTREACH_websites', 'OUTREACH_attempts')
       AND COLUMN_NAME = 'campaign_id'`,
    [database_name],
  );
  return classify_website_campaign_schema(
    rows.filter((row) => row.TABLE_NAME === "OUTREACH_websites").map((row) => row.COLUMN_NAME),
    rows.filter((row) => row.TABLE_NAME === "OUTREACH_attempts").map((row) => row.COLUMN_NAME),
  );
}

async function execute_migration(
  connection: Connection,
  path: string,
): Promise<void> {
  const sql = (await readFile(resolve(path), "utf8")).replace(/^\uFEFF/, "");
  await connection.query(sql);
}

async function read_attempt_schema_state(
  connection: Connection,
): Promise<AttemptSchemaState> {
  const database_name = required_value(process.env.DB_NAME, "DB_NAME");
  const [rows] = await connection.execute<ColumnRow[]>(
    `SELECT COLUMN_NAME, COLUMN_TYPE
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ?
       AND TABLE_NAME = 'OUTREACH_attempts'
       AND COLUMN_NAME IN (
         'execution_status',
         'forms_result',
         'email_discovery_result',
         'meeting_discovery_result'
       )`,
    [database_name],
  );
  return classify_attempt_schema(
    rows.map((row) => ({ name: row.COLUMN_NAME, type: row.COLUMN_TYPE })),
  );
}

function required_value(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${name} must be configured.`);
  return normalized;
}

const executed_file_url = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : undefined;
if (executed_file_url === import.meta.url) {
  await main();
}
