import mysql, {
  type Pool,
  type PoolConnection,
  type PoolOptions,
  type ResultSetHeader,
  type RowDataPacket,
} from "mysql2/promise";
import type {
  ClaimOutreachInput,
  CompleteOutreachAttemptInput,
  OutreachChannelResult,
  OutreachClaimResult,
  OutreachExecutionStatus,
  OutreachHistoryStore,
  OutreachSenderDetails,
} from "./outreach_history_types_(Support).js";
import type { AutomationStatus } from "./outreach_types_(Support).js";
import { normalize_outreach_domain } from "./website_identity_(Deterministic).js";

interface CampaignRow extends RowDataPacket {
  campaign_id: number;
  sender_details: OutreachSenderDetails | string;
  message_to_send: string;
  prevent_resend: number | boolean;
}

interface AttemptRow extends RowDataPacket {
  attempt_id: number;
}

export interface OutreachAttemptCompletion {
  executionStatus: OutreachExecutionStatus;
  formsResult: OutreachChannelResult | null;
  emailDiscoveryResult: OutreachChannelResult | null;
  meetingDiscoveryResult: OutreachChannelResult | null;
}

export function database_config_from_environment(
  environment: NodeJS.ProcessEnv,
): PoolOptions {
  const port = required_positive_integer(environment.DB_PORT, "DB_PORT");
  return {
    host: required_value(environment.DB_HOST, "DB_HOST"),
    port,
    database: required_value(environment.DB_NAME, "DB_NAME"),
    user: required_value(environment.DB_USER, "DB_USER"),
    password: required_value(environment.DB_PASSWORD, "DB_PASSWORD"),
    charset: "utf8mb4",
  };
}

export function outreach_campaign_id_from_environment(
  environment: NodeJS.ProcessEnv = process.env,
): number {
  return required_positive_integer(
    environment.OUTREACH_CAMPAIGN_ID,
    "OUTREACH_CAMPAIGN_ID",
  );
}

export function create_mysql_outreach_history_store(
  environment: NodeJS.ProcessEnv = process.env,
): OutreachHistoryStore {
  return new MysqlOutreachHistoryStore(
    mysql.createPool({
      ...database_config_from_environment(environment),
      connectionLimit: 5,
    }),
  );
}

export class MysqlOutreachHistoryStore implements OutreachHistoryStore {
  public constructor(private readonly pool: Pool) {}

  public async claimOutreach(
    input: ClaimOutreachInput,
  ): Promise<OutreachClaimResult> {
    const normalized_domain = normalize_outreach_domain(input.websiteUrl);
    const connection = await this.pool.getConnection();

    try {
      await connection.beginTransaction();
      const campaign = await select_campaign_for_update(
        connection,
        input.campaignId,
      );
      const website_id = await find_or_create_website(
        connection,
        input.campaignId,
        normalized_domain,
        input.websiteUrl,
      );

      if (Boolean(campaign.prevent_resend)) {
        const previous_success = await find_previous_success(
          connection,
          website_id,
        );
        if (previous_success) {
          const reason =
            `Skipped because campaign ${input.campaignId} already has a successful ` +
            `attempt for ${normalized_domain}.`;
          const attempt_id = await insert_skipped_attempt(
            connection,
            website_id,
            reason,
          );
          await connection.commit();
          return {
            action: "skip",
            attemptId: attempt_id,
            websiteId: website_id,
            normalizedDomain: normalized_domain,
            reason,
          };
        }
      }

      const attempt_id = await insert_running_attempt(
        connection,
        website_id,
      );
      await connection.commit();
      return {
        action: "run",
        attemptId: attempt_id,
        websiteId: website_id,
        normalizedDomain: normalized_domain,
      };
    } catch (error) {
      await connection.rollback().catch(() => undefined);
      throw error;
    } finally {
      connection.release();
    }
  }

  public async completeAttempt(
    input: CompleteOutreachAttemptInput,
  ): Promise<void> {
    const completion = outreach_attempt_completion_from_outcome(input.outcome);
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE \`OUTREACH_attempts\`
       SET execution_status = ?, forms_result = ?,
           email_discovery_result = ?, meeting_discovery_result = ?,
           outcome_reason = ?, channel_outcomes = ?, completed_time = CURRENT_TIMESTAMP(3)
       WHERE attempt_id = ? AND execution_status = 'running'`,
      [
        completion.executionStatus,
        completion.formsResult,
        completion.emailDiscoveryResult,
        completion.meetingDiscoveryResult,
        input.outcome.reason ?? null,
        JSON.stringify(input.outcome.channels),
        input.attemptId,
      ],
    );
    if (result.affectedRows !== 1) {
      throw new Error(
        `Running outreach attempt ${input.attemptId} was not found for completion.`,
      );
    }
  }

  public async close(): Promise<void> {
    await this.pool.end();
  }
}

async function select_campaign_for_update(
  connection: PoolConnection,
  campaign_id: number,
): Promise<CampaignRow> {
  const [rows] = await connection.execute<CampaignRow[]>(
    `SELECT campaign_id, sender_details, message_to_send, prevent_resend
     FROM \`OUTREACH_campaigns\`
     WHERE campaign_id = ?
     FOR UPDATE`,
    [campaign_id],
  );
  const campaign = rows[0];
  if (!campaign) {
    throw new Error(`Outreach campaign ${campaign_id} does not exist.`);
  }
  return campaign;
}

async function find_or_create_website(
  connection: PoolConnection,
  campaign_id: number,
  normalized_domain: string,
  original_input_url: string,
): Promise<number> {
  const [result] = await connection.execute<ResultSetHeader>(
    `INSERT INTO \`OUTREACH_websites\`
       (campaign_id, normalized_domain, original_input_url)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE
       website_id = LAST_INSERT_ID(website_id),
       campaign_id = IF(campaign_id = VALUES(campaign_id), campaign_id, NULL)`,
    [campaign_id, normalized_domain, original_input_url],
  );
  return result.insertId;
}

async function find_previous_success(
  connection: PoolConnection,
  website_id: number,
): Promise<AttemptRow | undefined> {
  const [rows] = await connection.execute<AttemptRow[]>(
    `SELECT attempt_id
     FROM \`OUTREACH_attempts\`
     WHERE website_id = ?
       AND forms_result = 'success'
     LIMIT 1`,
    [website_id],
  );
  return rows[0];
}

async function insert_running_attempt(
  connection: PoolConnection,
  website_id: number,
): Promise<number> {
  const [result] = await connection.execute<ResultSetHeader>(
    `INSERT INTO \`OUTREACH_attempts\`
       (website_id, execution_status, started_time)
     VALUES (?, 'running', CURRENT_TIMESTAMP(3))`,
    [website_id],
  );
  return result.insertId;
}

async function insert_skipped_attempt(
  connection: PoolConnection,
  website_id: number,
  reason: string,
): Promise<number> {
  const [result] = await connection.execute<ResultSetHeader>(
    `INSERT INTO \`OUTREACH_attempts\`
       (website_id, execution_status, outcome_reason, completed_time)
     VALUES (?, 'skipped', ?, CURRENT_TIMESTAMP(3))`,
    [website_id, reason],
  );
  return result.insertId;
}

export function outreach_attempt_completion_from_outcome(
  outcome: CompleteOutreachAttemptInput["outcome"],
): OutreachAttemptCompletion {
  if (outcome.executionStatus !== "FINISHED") {
    return {
      executionStatus:
        outcome.executionStatus === "SKIPPED" ? "skipped" : "run_failed",
      formsResult: null,
      emailDiscoveryResult: null,
      meetingDiscoveryResult: null,
    };
  }
  return {
    executionStatus: "finished",
    formsResult: channel_result_from_status(outcome.channels.forms.status),
    emailDiscoveryResult: channel_result_from_status(
      outcome.channels.emails.status,
    ),
    meetingDiscoveryResult: channel_result_from_status(
      outcome.channels.meetings.status,
    ),
  };
}

function channel_result_from_status(
  status: AutomationStatus,
): OutreachChannelResult {
  switch (status) {
    case "SUCCESS":
      return "success";
    case "PARTIAL":
      return "partial";
    case "INCONCLUSIVE":
      return "inconclusive";
    case "FAILED":
      return "failed";
  }
}

function required_value(
  value: string | undefined,
  name: string,
): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error(`${name} must be configured.`);
  }
  return normalized;
}

function required_positive_integer(
  value: string | undefined,
  name: string,
): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}
