import assert from "node:assert/strict";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import mysql, { type RowDataPacket } from "mysql2/promise";
import { database_config_from_environment } from "../contact_outreach_workflow/shared_files_orchestrator/outreach_database_(Integration).js";

interface ColumnRow extends RowDataPacket {
  TABLE_NAME: string;
  COLUMN_NAME: string;
  COLUMN_TYPE: string;
}

interface IndexRow extends RowDataPacket {
  TABLE_NAME: string;
  INDEX_NAME: string;
  COLUMN_NAME: string;
  SEQ_IN_INDEX: number;
}

interface ConstraintRow extends RowDataPacket {
  TABLE_NAME: string;
  CONSTRAINT_NAME: string;
  CONSTRAINT_TYPE: string;
}

loadEnvFile(resolve(".env"));
const config = database_config_from_environment(process.env);
const connection = await mysql.createConnection(config);
const databaseName = process.env.DB_NAME?.trim();
assert(databaseName, "DB_NAME must be configured.");
const expectedColumns: Record<string, string[]> = {
  OUTREACH_campaigns: [
    "campaign_id",
    "campaign_name",
    "sender_details",
    "message_to_send",
    "prevent_resend",
    "created_time",
  ],
  OUTREACH_websites: [
    "website_id",
    "campaign_id",
    "normalized_domain",
    "original_input_url",
    "created_time",
  ],
  OUTREACH_attempts: [
    "attempt_id",
    "website_id",
    "execution_status",
    "forms_result",
    "email_discovery_result",
    "meeting_discovery_result",
    "outcome_reason",
    "channel_outcomes",
    "created_time",
    "started_time",
    "completed_time",
  ],
};

try {
  const tableNames = Object.keys(expectedColumns);
  const placeholders = tableNames.map(() => "?").join(", ");
  const [columns] = await connection.execute<ColumnRow[]>(
    `SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN (${placeholders})`,
    [databaseName, ...tableNames],
  );
  for (const [table, expected] of Object.entries(expectedColumns)) {
    const actual = new Set(
      columns
        .filter((row) => row.TABLE_NAME === table)
        .map((row) => row.COLUMN_NAME),
    );
    for (const column of expected) {
      assert(actual.has(column), `Missing ${table}.${column}`);
    }
  }

  const attemptColumns = new Map(
    columns
      .filter((row) => row.TABLE_NAME === "OUTREACH_attempts")
      .map((row) => [row.COLUMN_NAME, row.COLUMN_TYPE.toLowerCase()]),
  );
  const campaignColumns = new Map(
    columns.filter((row) => row.TABLE_NAME === "OUTREACH_campaigns")
      .map((row) => [row.COLUMN_NAME, row.COLUMN_TYPE.toLowerCase()]),
  );
  assert.equal(campaignColumns.get("sender_details"), "json");
  assert.equal(campaignColumns.get("message_to_send"), "text");
  assert.equal(
    attemptColumns.get("execution_status"),
    "enum('queued','running','finished','run_failed','skipped')",
  );
  for (const resultColumn of [
    "forms_result",
    "email_discovery_result",
    "meeting_discovery_result",
  ]) {
    assert.equal(
      attemptColumns.get(resultColumn),
      "enum('success','partial','inconclusive','failed')",
    );
  }

  const [indexes] = await connection.execute<IndexRow[]>(
    `SELECT TABLE_NAME, INDEX_NAME, COLUMN_NAME, SEQ_IN_INDEX
     FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN (${placeholders})`,
    [databaseName, ...tableNames],
  );
  const indexNames = new Set(indexes.map((row) => row.INDEX_NAME));
  assert(indexNames.has("uq_outreach_websites_normalized_domain"));
  assert(indexNames.has("idx_outreach_websites_campaign"));
  assert(indexNames.has("idx_outreach_attempt_resend_lookup"));
  const resendIndexColumns = indexes
    .filter((row) => row.INDEX_NAME === "idx_outreach_attempt_resend_lookup")
    .sort((left, right) => left.SEQ_IN_INDEX - right.SEQ_IN_INDEX)
    .map((row) => row.COLUMN_NAME);
  assert.deepEqual(resendIndexColumns, ["website_id", "forms_result"]);
  assert.equal(attemptColumns.has("campaign_id"), false);

  const [constraints] = await connection.execute<ConstraintRow[]>(
    `SELECT TABLE_NAME, CONSTRAINT_NAME, CONSTRAINT_TYPE
     FROM information_schema.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN (${placeholders})`,
    [databaseName, ...tableNames],
  );
  const constraintNames = new Set(
    constraints.map((row) => row.CONSTRAINT_NAME),
  );
  assert(constraintNames.has("fk_outreach_website_campaign"));
  assert(!constraintNames.has("fk_outreach_attempt_campaign"));
  assert(constraintNames.has("fk_outreach_attempt_website"));
  assert(constraintNames.has("chk_outreach_attempt_completed_time"));

  console.log(
    "Verified 3 outreach tables, 22 columns, channel-result enums, required indexes, foreign keys, and lifecycle constraint.",
  );
} finally {
  await connection.end();
}
