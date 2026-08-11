import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { pathToFileURL } from "node:url";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { database_config_from_environment } from "../contact_outreach_workflow/shared_files_orchestrator/outreach_database_(Integration).js";

const BASELINE_MIGRATION_PATH =
  "database/migrations/001_create_outreach_tables.sql";
const CHANNEL_RESULTS_MIGRATION_PATH =
  "database/migrations/002_separate_execution_and_channel_results.sql";
const CAMPAIGN_CONTENT_MIGRATION_PATH =
  "database/migrations/003_normalize_campaign_content.sql";
const WEBSITE_CAMPAIGN_MIGRATION_PATH =
  "database/migrations/004_assign_websites_to_campaigns.sql";
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
  loadEnvFile(resolve(".env"));
  const connection = await mysql.createConnection({
    ...database_config_from_environment(process.env),
    multipleStatements: true,
  });

  try {
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
    await execute_migration(connection, CAMPAIGN_CONTENT_MIGRATION_PATH);
    const ownership_state = await read_website_campaign_schema_state(connection);
    if (ownership_state === "partial") {
      throw new Error(
        "Website campaign ownership is partially migrated; refusing to apply another schema change.",
      );
    }
    if (ownership_state === "legacy") {
      await execute_migration(connection, WEBSITE_CAMPAIGN_MIGRATION_PATH);
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
    console.log(
      initial_state === "legacy" || ownership_state === "legacy"
        ? "Applied pending outreach database migrations."
        : "Outreach database schema is already current.",
    );
  } finally {
    await connection.end();
  }
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
