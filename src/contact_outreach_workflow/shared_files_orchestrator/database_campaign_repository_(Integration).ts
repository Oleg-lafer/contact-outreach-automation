import mysql, {
  type Pool,
  type PoolConnection,
  type ResultSetHeader,
  type RowDataPacket,
} from "mysql2/promise";
import { database_config_from_environment } from "./outreach_database_(Integration).js";
import { outreach_attempt_completion_from_outcome } from "./outreach_database_(Integration).js";
import type {
  ContactOutreachOutcome,
  ContactRequest,
} from "./outreach_types_(Support).js";
import type { OutreachSenderDetails } from "./outreach_history_types_(Support).js";

export type DatabaseCandidateMode = "unattempted" | "retry-unsuccessful";

export interface DatabaseCampaign {
  campaignId: number;
  campaignName: string;
  senderDetails: OutreachSenderDetails;
  messageToSend: string;
  preventResend: boolean;
}

export interface DatabaseWebsiteCandidate {
  websiteId: number;
  websiteUrl: string;
}

export type DatabaseWebsiteClaim =
  | { action: "run"; attemptId: number; website: DatabaseWebsiteCandidate }
  | { action: "skip"; attemptId: number; website: DatabaseWebsiteCandidate; reason: string }
  | { action: "unavailable"; websiteId: number; reason: string };

interface CampaignRow extends RowDataPacket {
  campaign_id: number;
  campaign_name: string;
  sender_details: unknown;
  message_to_send: string;
  prevent_resend: number | boolean;
}

interface CandidateRow extends RowDataPacket {
  website_id: number;
  original_input_url: string;
}

interface AttemptStateRow extends RowDataPacket {
  attempt_id: number;
  execution_status: string;
  forms_result: string | null;
}

export interface DatabaseCampaignRepository {
  loadCampaign(campaignId: number): Promise<DatabaseCampaign>;
  snapshotCandidates(
    campaignId: number,
    mode: DatabaseCandidateMode,
  ): Promise<DatabaseWebsiteCandidate[]>;
  claimWebsite(
    campaign: DatabaseCampaign,
    websiteId: number,
    mode: DatabaseCandidateMode,
  ): Promise<DatabaseWebsiteClaim>;
  completeAttempt(attemptId: number, outcome: ContactOutreachOutcome): Promise<void>;
  recoverStaleAttempts(campaignId: number, staleBefore: Date): Promise<number>;
  close(): Promise<void>;
}

export function create_database_campaign_repository(
  environment: NodeJS.ProcessEnv = process.env,
): DatabaseCampaignRepository {
  return new MysqlDatabaseCampaignRepository(
    mysql.createPool({
      ...database_config_from_environment(environment),
      connectionLimit: 5,
    }),
  );
}

export class MysqlDatabaseCampaignRepository
implements DatabaseCampaignRepository {
  public constructor(private readonly pool: Pool) {}

  public async loadCampaign(campaignId: number): Promise<DatabaseCampaign> {
    const [rows] = await this.pool.execute<CampaignRow[]>(
      `SELECT campaign_id, campaign_name, sender_details,
              message_to_send, prevent_resend
       FROM \`OUTREACH_campaigns\`
       WHERE campaign_id = ?`,
      [campaignId],
    );
    const row = rows[0];
    if (!row) throw new Error(`Outreach campaign ${campaignId} does not exist.`);
    return campaign_from_database_row(row);
  }

  public async snapshotCandidates(
    campaignId: number,
    mode: DatabaseCandidateMode,
  ): Promise<DatabaseWebsiteCandidate[]> {
    const eligibility = mode === "unattempted"
      ? `NOT EXISTS (
           SELECT 1 FROM \`OUTREACH_attempts\` AS attempt
           WHERE attempt.website_id = website.website_id
         )`
      : `EXISTS (
           SELECT 1 FROM \`OUTREACH_attempts\` AS latest
           WHERE latest.attempt_id = (
             SELECT MAX(candidate_attempt.attempt_id)
             FROM \`OUTREACH_attempts\` AS candidate_attempt
             WHERE candidate_attempt.website_id = website.website_id
           )
             AND (
               latest.execution_status = 'run_failed'
               OR (
                 latest.execution_status = 'finished'
                 AND latest.forms_result IN ('failed', 'partial', 'inconclusive')
               )
             )
         )
         AND NOT EXISTS (
           SELECT 1 FROM \`OUTREACH_attempts\` AS successful
           WHERE successful.website_id = website.website_id
             AND successful.forms_result = 'success'
         )`;
    const [rows] = await this.pool.execute<CandidateRow[]>(
      `SELECT website.website_id, website.original_input_url
       FROM \`OUTREACH_websites\` AS website
       WHERE website.campaign_id = ? AND ${eligibility}
       ORDER BY website.website_id`,
      [campaignId],
    );
    return rows.map(candidate_from_row);
  }

  public async claimWebsite(
    campaign: DatabaseCampaign,
    websiteId: number,
    mode: DatabaseCandidateMode,
  ): Promise<DatabaseWebsiteClaim> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const website = await select_website_for_update(
        connection,
        campaign.campaignId,
        websiteId,
      );
      if (!website) {
        await connection.rollback();
        return { action: "unavailable", websiteId, reason: "Website is no longer in the campaign." };
      }
      const attempts = await select_attempt_states(connection, websiteId);
      const previous_success = attempts.some(
        (attempt) => attempt.forms_result === "success",
      );
      if (campaign.preventResend && previous_success) {
        const reason = `Skipped because campaign ${campaign.campaignId} already has a successful attempt for website ${websiteId}.`;
        const attemptId = await insert_attempt(connection, websiteId, "skipped", reason);
        await connection.commit();
        return { action: "skip", attemptId, website, reason };
      }
      if (previous_success) {
        await connection.rollback();
        return {
          action: "unavailable",
          websiteId,
          reason: "Successful websites are excluded from database retry runs.",
        };
      }
      if (!claim_is_still_eligible(attempts, mode)) {
        await connection.rollback();
        return { action: "unavailable", websiteId, reason: "Website eligibility changed after the campaign snapshot." };
      }
      const attemptId = await insert_attempt(connection, websiteId, "running");
      await connection.commit();
      return { action: "run", attemptId, website };
    } catch (error) {
      await connection.rollback().catch(() => undefined);
      throw error;
    } finally {
      connection.release();
    }
  }

  public async completeAttempt(
    attemptId: number,
    outcome: ContactOutreachOutcome,
  ): Promise<void> {
    const completion = outreach_attempt_completion_from_outcome(outcome);
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
        outcome.reason ?? null,
        JSON.stringify(outcome.channels),
        attemptId,
      ],
    );
    if (result.affectedRows !== 1) {
      throw new Error(`Running outreach attempt ${attemptId} was not found for completion.`);
    }
  }

  public async recoverStaleAttempts(
    campaignId: number,
    staleBefore: Date,
  ): Promise<number> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE \`OUTREACH_attempts\` AS attempt
       JOIN \`OUTREACH_websites\` AS website
         ON website.website_id = attempt.website_id
       SET attempt.execution_status = 'run_failed',
           attempt.outcome_reason = 'Recovered stale running attempt after an interrupted process.',
           attempt.completed_time = CURRENT_TIMESTAMP(3)
       WHERE website.campaign_id = ?
         AND attempt.execution_status = 'running'
         AND attempt.started_time < ?`,
      [campaignId, staleBefore],
    );
    return result.affectedRows;
  }

  public async close(): Promise<void> {
    await this.pool.end();
  }
}

export function campaign_from_database_row(row: {
  campaign_id: number;
  campaign_name: string;
  sender_details: unknown;
  message_to_send: string;
  prevent_resend: number | boolean;
}): DatabaseCampaign {
  const raw = typeof row.sender_details === "string"
    ? JSON.parse(row.sender_details) as unknown
    : row.sender_details;
  if (!is_record(raw)) throw new Error("Campaign sender_details must be a JSON object.");
  const senderDetails = {
    name: required_string(raw.name, "sender_details.name"),
    email: required_string(raw.email, "sender_details.email"),
    phone: required_string(raw.phone, "sender_details.phone"),
    company: required_string(raw.company, "sender_details.company"),
    role: required_string(raw.role, "sender_details.role"),
    website: required_string(raw.website, "sender_details.website"),
    country: required_string(raw.country, "sender_details.country"),
  };
  return {
    campaignId: positive_integer(row.campaign_id, "campaign_id"),
    campaignName: required_string(row.campaign_name, "campaign_name"),
    senderDetails,
    messageToSend: required_string(row.message_to_send, "message_to_send"),
    preventResend: Boolean(row.prevent_resend),
  };
}

export function contact_request_from_database(
  campaign: DatabaseCampaign,
  website: DatabaseWebsiteCandidate,
): ContactRequest {
  const parsed = new URL(website.websiteUrl);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Website ${website.websiteId} must use HTTP or HTTPS.`);
  }
  return {
    websiteUrl: parsed.toString(),
    ...campaign.senderDetails,
    message: campaign.messageToSend,
  };
}

export function claim_is_still_eligible(
  attempts: ReadonlyArray<{ execution_status: string; forms_result: string | null }>,
  mode: DatabaseCandidateMode,
): boolean {
  if (attempts.some((attempt) => attempt.execution_status === "running")) return false;
  if (mode === "unattempted") return attempts.length === 0;
  const latest = attempts[0];
  return latest?.execution_status === "run_failed" ||
    (latest?.execution_status === "finished" &&
      ["failed", "partial", "inconclusive"].includes(latest.forms_result ?? ""));
}

async function select_website_for_update(
  connection: PoolConnection,
  campaignId: number,
  websiteId: number,
): Promise<DatabaseWebsiteCandidate | undefined> {
  const [rows] = await connection.execute<CandidateRow[]>(
    `SELECT website_id, original_input_url
     FROM \`OUTREACH_websites\`
     WHERE campaign_id = ? AND website_id = ?
     FOR UPDATE`,
    [campaignId, websiteId],
  );
  return rows[0] ? candidate_from_row(rows[0]) : undefined;
}

async function select_attempt_states(
  connection: PoolConnection,
  websiteId: number,
): Promise<AttemptStateRow[]> {
  const [rows] = await connection.execute<AttemptStateRow[]>(
    `SELECT attempt_id, execution_status, forms_result
     FROM \`OUTREACH_attempts\`
     WHERE website_id = ?
     ORDER BY attempt_id DESC
     FOR UPDATE`,
    [websiteId],
  );
  return rows;
}

async function insert_attempt(
  connection: PoolConnection,
  websiteId: number,
  status: "running" | "skipped",
  reason?: string,
): Promise<number> {
  const [result] = await connection.execute<ResultSetHeader>(
    status === "running"
      ? `INSERT INTO \`OUTREACH_attempts\`
           (website_id, execution_status, started_time)
         VALUES (?, 'running', CURRENT_TIMESTAMP(3))`
      : `INSERT INTO \`OUTREACH_attempts\`
           (website_id, execution_status, outcome_reason, completed_time)
         VALUES (?, 'skipped', ?, CURRENT_TIMESTAMP(3))`,
    status === "running" ? [websiteId] : [websiteId, reason ?? null],
  );
  return result.insertId;
}

function candidate_from_row(row: CandidateRow): DatabaseWebsiteCandidate {
  return { websiteId: row.website_id, websiteUrl: row.original_input_url };
}

function required_string(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return value.trim();
}

function positive_integer(value: unknown, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function is_record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
