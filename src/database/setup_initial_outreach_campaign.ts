import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { pathToFileURL } from "node:url";
import mysql, {
  type Connection,
  type ResultSetHeader,
  type RowDataPacket,
} from "mysql2/promise";
import { database_config_from_environment } from "../contact_outreach_workflow/shared_files_orchestrator/outreach_database_(Integration).js";
import { normalize_outreach_domain } from "../contact_outreach_workflow/shared_files_orchestrator/website_identity_(Deterministic).js";
import type { OutreachSenderDetails } from "../contact_outreach_workflow/shared_files_orchestrator/outreach_history_types_(Support).js";

const INITIAL_CAMPAIGN_NAME = "Academic Institutions Outreach";
const INITIAL_CONTACT_VALUES_PATH = "run_results/contact_values_REAL.json";
const SENDER_DETAIL_KEYS = [
  "name", "email", "phone", "company", "role", "website", "country",
] as const satisfies readonly (keyof OutreachSenderDetails)[];
const HISTORICAL_QUEUE_PATHS = [
  "run_results/BATCH_1/websites_100_BATCH_1.json",
  "run_results/BATCH_2/websites_100_BATCH_2.json",
  "run_results/BATCH_3/websites_100_BATCH_3.json",
  "run_results/BATCH_4/websites_100_BATCH_4.json",
  "run_results/BATCH_5/websites_100_BATCH_5.json",
  "run_results/BATCH_6/websites_BATCH_6.json",
  "run_results/BATCH_7_deepDebug/websites_BATCH_7_deepDebug.json",
  "run_results/BATCH_8/websites_BATCH_8.json",
  "run_results/BATCH_9/websites_BATCH_9.json",
] as const;

interface IdRow extends RowDataPacket {
  id: number;
}

interface CountRow extends RowDataPacket {
  imported_count: number;
}

interface WebsiteCountRow extends RowDataPacket {
  website_count: number;
}

interface WebsiteQueueEntry {
  id: string;
  websiteUrl: string;
  status: string;
}

export interface HistoricalSuccess {
  normalizedDomain: string;
  originalInputUrl: string;
  sourcePaths: string[];
}

export async function collect_historical_successes(
  queue_paths: readonly string[],
): Promise<HistoricalSuccess[]> {
  const successes = new Map<string, HistoricalSuccess>();

  for (const queue_path of queue_paths) {
    const queue_entries = await read_website_queue(queue_path);
    const checkpoint_statuses = await read_checkpoint_statuses(
      `${queue_path}.full-checkpoints.jsonl`,
    );

    for (const entry of queue_entries) {
      const final_status = checkpoint_statuses.get(entry.id) ?? entry.status;
      if (final_status !== "succeeded") continue;

      const normalized_domain = normalize_outreach_domain(entry.websiteUrl);
      const existing = successes.get(normalized_domain);
      if (existing) {
        if (!existing.sourcePaths.includes(queue_path)) {
          existing.sourcePaths.push(queue_path);
        }
        continue;
      }

      successes.set(normalized_domain, {
        normalizedDomain: normalized_domain,
        originalInputUrl: entry.websiteUrl,
        sourcePaths: [queue_path],
      });
    }
  }

  return [...successes.values()].sort((left, right) =>
    left.normalizedDomain.localeCompare(right.normalizedDomain),
  );
}

async function main(): Promise<void> {
  loadEnvFile(resolve(".env"));
  const contact_values_path =
    process.argv[2]?.trim() || INITIAL_CONTACT_VALUES_PATH;
  const website_queue_path = process.argv[3]?.trim();
  const contact_values = await read_record(
    contact_values_path,
    "initial campaign contact values",
  );
  const { senderDetails: sender_details, messageToSend: message } =
    campaign_content_from_contact_values(contact_values);
  const historical_successes = await collect_historical_successes(
    HISTORICAL_QUEUE_PATHS,
  );
  const connection = await mysql.createConnection(
    database_config_from_environment(process.env),
  );

  try {
    await connection.beginTransaction();
    const campaign_id = await find_or_create_initial_campaign(
      connection,
      sender_details,
      message,
    );
    const campaign_websites = website_queue_path
      ? await collect_campaign_websites(website_queue_path)
      : [];
    const existing_campaign_website_count = await count_campaign_websites(
      connection,
      campaign_id,
    );
    await upsert_historical_websites(connection, campaign_id, historical_successes);
    await upsert_historical_websites(connection, campaign_id, campaign_websites);
    const imported_attempt_count = await insert_historical_successes(
      connection,
      campaign_id,
      historical_successes,
    );

    await connection.commit();
    console.log(`Initial campaign ID: ${campaign_id}`);
    console.log(
      `Historical successful domains found: ${historical_successes.length}`,
    );
    console.log(`Historical attempts imported: ${imported_attempt_count}`);
    if (website_queue_path) {
      const final_campaign_website_count = await count_campaign_websites(
        connection,
        campaign_id,
      );
      console.log(`Campaign website entries supplied: ${campaign_websites.length}`);
      console.log(
        `New campaign websites inserted: ${final_campaign_website_count - existing_campaign_website_count}`,
      );
      console.log(`Campaign websites now stored: ${final_campaign_website_count}`);
    }
  } catch (error) {
    await connection.rollback().catch(() => undefined);
    throw error;
  } finally {
    await connection.end();
  }
}

export async function collect_campaign_websites(
  queue_path: string,
): Promise<HistoricalSuccess[]> {
  const entries = await read_website_queue(queue_path);
  const websites = new Map<string, HistoricalSuccess>();
  for (const entry of entries) {
    const normalized_domain = normalize_outreach_domain(entry.websiteUrl);
    if (!websites.has(normalized_domain)) {
      websites.set(normalized_domain, {
        normalizedDomain: normalized_domain,
        originalInputUrl: entry.websiteUrl,
        sourcePaths: [queue_path],
      });
    }
  }
  return [...websites.values()].sort((left, right) =>
    left.normalizedDomain.localeCompare(right.normalizedDomain),
  );
}

async function count_campaign_websites(
  connection: Connection,
  campaign_id: number,
): Promise<number> {
  const [rows] = await connection.execute<WebsiteCountRow[]>(
    `SELECT COUNT(*) AS website_count
     FROM \`OUTREACH_websites\`
     WHERE campaign_id = ?`,
    [campaign_id],
  );
  return rows[0]?.website_count ?? 0;
}

async function find_or_create_initial_campaign(
  connection: Connection,
  sender_details: OutreachSenderDetails,
  message: string,
): Promise<number> {
  const [rows] = await connection.execute<IdRow[]>(
    `SELECT campaign_id AS id
     FROM \`OUTREACH_campaigns\`
     WHERE campaign_name = ?
     ORDER BY campaign_id
     LIMIT 1`,
    [INITIAL_CAMPAIGN_NAME],
  );
  const existing = rows[0];
  if (existing) {
    await connection.execute(
      `UPDATE \`OUTREACH_campaigns\`
       SET sender_details = ?, message_to_send = ?, prevent_resend = TRUE
       WHERE campaign_id = ?`,
      [JSON.stringify(sender_details), message, existing.id],
    );
    return existing.id;
  }

  const [result] = await connection.execute<ResultSetHeader>(
    `INSERT INTO \`OUTREACH_campaigns\`
       (campaign_name, sender_details, message_to_send, prevent_resend)
     VALUES (?, ?, ?, TRUE)`,
    [INITIAL_CAMPAIGN_NAME, JSON.stringify(sender_details), message],
  );
  return result.insertId;
}

export function campaign_content_from_contact_values(
  contact_values: Record<string, unknown>,
): { senderDetails: OutreachSenderDetails; messageToSend: string } {
  const sender_details = Object.fromEntries(
    SENDER_DETAIL_KEYS.map((key) => [key, required_string(contact_values[key], key)]),
  ) as unknown as OutreachSenderDetails;
  return {
    senderDetails: sender_details,
    messageToSend: required_string(contact_values.message, "message"),
  };
}

async function upsert_historical_websites(
  connection: Connection,
  campaign_id: number,
  successes: readonly HistoricalSuccess[],
): Promise<void> {
  if (successes.length === 0) return;
  const values = successes.map(() => "(?, ?, ?)").join(", ");
  const parameters = successes.flatMap((success) => [
    campaign_id, success.normalizedDomain, success.originalInputUrl,
  ]);
  await connection.execute(
    `INSERT INTO \`OUTREACH_websites\`
       (campaign_id, normalized_domain, original_input_url)
     VALUES ${values}
     ON DUPLICATE KEY UPDATE
       campaign_id = IF(campaign_id = VALUES(campaign_id), campaign_id, NULL)`,
    parameters,
  );
}

async function insert_historical_successes(
  connection: Connection,
  campaign_id: number,
  successes: readonly HistoricalSuccess[],
): Promise<number> {
  if (successes.length === 0) return 0;
  const domain_placeholders = successes.map(() => "?").join(", ");
  await connection.execute(
    `INSERT INTO \`OUTREACH_attempts\`
       (website_id, execution_status, forms_result,
        outcome_reason, started_time, completed_time)
     SELECT website.website_id, 'finished', 'success',
            'Imported confirmed historical success.',
            CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)
     FROM \`OUTREACH_websites\` AS website
     WHERE website.campaign_id = ?
       AND website.normalized_domain IN (${domain_placeholders})
       AND NOT EXISTS (
         SELECT 1
         FROM \`OUTREACH_attempts\` AS attempt
         JOIN \`OUTREACH_websites\` AS attempt_website
           ON attempt_website.website_id = attempt.website_id
         WHERE attempt_website.campaign_id = ?
           AND attempt.website_id = website.website_id
           AND attempt.forms_result = 'success'
       )`,
    [
      campaign_id,
      ...successes.map((success) => success.normalizedDomain),
      campaign_id,
    ],
  );
  const [count_rows] = await connection.execute<CountRow[]>(
    "SELECT ROW_COUNT() AS imported_count",
  );
  return count_rows[0]?.imported_count ?? 0;
}

async function read_website_queue(path: string): Promise<WebsiteQueueEntry[]> {
  const input = await read_record(path, "historical website queue");
  if (!Array.isArray(input.websites)) {
    throw new Error(`Historical website queue "${path}" must contain websites.`);
  }

  return input.websites.map((value, index) => {
    if (!is_record(value)) {
      throw new Error(`Historical queue entry ${index} in "${path}" is invalid.`);
    }
    return {
      id: required_string_or_number(value.id ?? index + 1, "website id"),
      websiteUrl: required_string(value.websiteUrl, "websiteUrl"),
      status: required_string(value.status, "status"),
    };
  });
}

async function read_checkpoint_statuses(
  path: string,
): Promise<Map<string, string>> {
  const statuses = new Map<string, string>();
  if (!existsSync(resolve(path))) return statuses;

  const lines = (await readFile(resolve(path), "utf8"))
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "");
  for (const line of lines) {
    const value: unknown = JSON.parse(line);
    if (!is_record(value)) {
      throw new Error(`Checkpoint in "${path}" must contain an object.`);
    }
    statuses.set(
      required_string_or_number(value.id, "checkpoint id"),
      required_string(value.status, "checkpoint status"),
    );
  }
  return statuses;
}

async function read_record(
  path: string,
  label: string,
): Promise<Record<string, unknown>> {
  const source = (await readFile(resolve(path), "utf8")).replace(/^\uFEFF/, "");
  const value: unknown = JSON.parse(source);
  if (!is_record(value)) {
    throw new Error(`${label} "${path}" must contain an object.`);
  }
  return value;
}

function required_string(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return value.trim();
}

function required_string_or_number(value: unknown, name: string): string {
  if (
    (typeof value !== "string" && typeof value !== "number") ||
    String(value).trim() === ""
  ) {
    throw new Error(`${name} must be a string or number.`);
  }
  return String(value);
}

function is_record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const executed_file_url = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : undefined;
if (executed_file_url === import.meta.url) {
  await main();
}
