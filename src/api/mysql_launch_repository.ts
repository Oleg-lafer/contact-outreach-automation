import type { Pool, PoolConnection, RowDataPacket, ResultSetHeader } from "mysql2/promise";
import { ImportError } from "./import_contract.js";
import type { LaunchCampaignResponse, LaunchRepository, RunMode } from "./launch_service.js";
import type { DatabaseRunSummary } from "../contact_outreach_workflow/database_outreach_runner.js";
import { json_value, read_run, run_history, safe_run_number, sql_utc_time, type CampaignRun, type RunIdentity } from "./campaign_run.js";

interface CampaignRow extends RowDataPacket {
  campaign_id: number | string;
  run_sequence: number | string;
  run_state: CampaignRun["state"] | null;
  current_run: unknown;
  run_history: unknown;
}
export interface QueuedRun extends LaunchCampaignResponse { websiteIdUpperBound: number }
export interface RunQueue {
  next(): Promise<QueuedRun | undefined>;
  heartbeat(identity: RunIdentity): Promise<void>;
  finish(identity: RunIdentity, summary: DatabaseRunSummary | undefined): Promise<void>;
}
function current(row: CampaignRow): CampaignRun {
  const run = read_run(row.current_run);
  if (run.runNumber !== safe_run_number(row.run_sequence) || run.state !== row.run_state) throw new Error("Stored run state does not match.");
  return run;
}
function reply(row: CampaignRow, run: CampaignRun): LaunchCampaignResponse {
  if (run.state !== "queued" && run.state !== "running") throw new Error("Run is not active.");
  return { campaignId: safe_run_number(row.campaign_id), runNumber: run.runNumber, runMode: run.runMode, status: run.state };
}
function missingSchema(error: unknown): boolean {
  return ["ER_NO_SUCH_TABLE", "ER_BAD_FIELD_ERROR"].includes((error as { code?: string })?.code ?? "");
}
export async function requireLaunchSchema(pool: Pick<Pool, "query">): Promise<void> {
  try {
    await pool.query("SELECT campaign_id, run_sequence, run_state, run_requested_time, current_run, run_history FROM OUTREACH_campaigns LIMIT 0");
    await pool.query("SELECT run_number FROM OUTREACH_attempts LIMIT 0");
    const [indexes] = await pool.query<RowDataPacket[]>(
      `SELECT COUNT(DISTINCT INDEX_NAME) AS ready,
       (SELECT COUNT(*) FROM information_schema.TABLES t WHERE t.TABLE_SCHEMA = DATABASE() AND t.TABLE_NAME = 'OUTREACH_runs') +
       (SELECT COUNT(*) FROM information_schema.COLUMNS c WHERE c.TABLE_SCHEMA = DATABASE() AND c.TABLE_NAME = 'OUTREACH_attempts' AND c.COLUMN_NAME = 'run_id') AS obsolete
       FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND
       ((TABLE_NAME = 'OUTREACH_campaigns' AND INDEX_NAME = 'idx_outreach_campaign_run_queue') OR
        (TABLE_NAME = 'OUTREACH_attempts' AND INDEX_NAME = 'idx_outreach_attempt_run_number'))`);
    if (Number(indexes[0]?.ready) !== 2 || Number(indexes[0]?.obsolete) !== 0) throw new ImportError(503, "SERVICE_UNAVAILABLE", "The launch service schema is unavailable.");
  } catch (error) {
    if (error instanceof ImportError) throw error;
    if (missingSchema(error)) throw new ImportError(503, "SERVICE_UNAVAILABLE", "The launch service schema is unavailable.");
    throw new ImportError(500, "DATABASE_ERROR", "The launch database is unavailable.");
  }
}
async function save_current(connection: PoolConnection, identity: RunIdentity, run: CampaignRun, previousState: string): Promise<void> {
  const [result] = await connection.execute<ResultSetHeader>(
    `UPDATE OUTREACH_campaigns SET run_state = ?, current_run = ?
     WHERE campaign_id = ? AND run_sequence = ? AND run_state = ?`,
    [run.state, JSON.stringify(run), identity.campaignId, identity.runNumber, previousState]);
  if (result.affectedRows !== 1) throw new Error("Active campaign run was not found.");
}
export class MysqlLaunchRepository implements LaunchRepository, RunQueue {
  constructor(private readonly pool: Pool, private readonly now = () => new Date()) {}

  async enqueue(campaignId: number, runMode: RunMode): Promise<LaunchCampaignResponse> {
    await requireLaunchSchema(this.pool);
    const connection = await this.pool.getConnection().catch(() => {
      throw new ImportError(500, "DATABASE_ERROR", "The launch could not be saved.");
    });
    let reusable = true;
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute<CampaignRow[]>("SELECT * FROM OUTREACH_campaigns WHERE campaign_id = ? FOR UPDATE", [campaignId]);
      const row = rows[0];
      if (!row) throw new ImportError(404, "CAMPAIGN_NOT_FOUND", "The campaign does not exist.");
      const sequence = safe_run_number(row.run_sequence, true);
      const previous = json_value(row.current_run) == null ? undefined : current(row);
      if ((sequence === 0) !== (previous === undefined) || (!previous && row.run_state !== null)) throw new Error("Invalid campaign run storage.");
      if (previous && (previous.state === "queued" || previous.state === "running")) {
        if (previous.runMode !== runMode) throw new ImportError(409, "RUN_MODE_CONFLICT", "The campaign already has an active run in another mode.");
        const result = reply(row, previous); await connection.commit(); return result;
      }
      const [sites] = await connection.execute<RowDataPacket[]>(
        `SELECT MAX(website.website_id) AS upper_bound,
           SUM(NOT EXISTS (SELECT 1 FROM OUTREACH_attempts attempt WHERE attempt.website_id = website.website_id)) AS eligible
         FROM OUTREACH_websites website WHERE website.campaign_id = ?`, [campaignId]);
      if (!Number(sites[0]?.eligible)) throw new ImportError(409, "NO_ELIGIBLE_WEBSITES", "The campaign has no unattempted websites.");
      const history = run_history(row.run_history);
      if (history.length !== sequence - (previous ? 1 : 0) || history.some((r, index) => r.runNumber !== index + 1 || ["queued", "running"].includes(r.state))) {
        throw new Error("Invalid stored run history.");
      }
      if (previous) history.push(previous);
      const runNumber = safe_run_number(sequence + 1);
      const requestedTime = this.now().toISOString();
      const run: CampaignRun = { runNumber, state: "queued", runMode, requestedTime, startedTime: null, heartbeatTime: null,
        completedTime: null, websiteIdUpperBound: safe_run_number(sites[0]!.upper_bound), failureCode: null, summary: null };
      const [result] = await connection.execute<ResultSetHeader>(
        `UPDATE OUTREACH_campaigns SET run_sequence = ?, run_state = 'queued', run_requested_time = ?, current_run = ?, run_history = ?
         WHERE campaign_id = ? AND run_sequence = ?`,
        [runNumber, sql_utc_time(requestedTime), JSON.stringify(run), JSON.stringify(history), campaignId, sequence]);
      if (result.affectedRows !== 1) throw new Error("Campaign changed before launch.");
      await connection.commit();
      return { campaignId, runNumber, runMode, status: "queued" };
    } catch (error) {
      try { await connection.rollback(); } catch { reusable = false; connection.destroy(); }
      if (error instanceof ImportError) throw error;
      if (missingSchema(error)) throw new ImportError(503, "SERVICE_UNAVAILABLE", "The launch service schema is unavailable.");
      throw new ImportError(500, "DATABASE_ERROR", "The launch could not be saved.");
    } finally { if (reusable) connection.release(); }
  }

  // Caller holds the global execution lock for selection, recovery, and execution.
  async next(): Promise<QueuedRun | undefined> {
    const connection = await this.pool.getConnection(); let reusable = true;
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute<CampaignRow[]>(
        `SELECT * FROM OUTREACH_campaigns WHERE run_state IN ('running', 'queued')
         ORDER BY (run_state = 'running') DESC, run_requested_time, campaign_id LIMIT 1 FOR UPDATE`);
      const row = rows[0];
      if (!row) { await connection.commit(); return undefined; }
      const run = current(row); const identity = { campaignId: safe_run_number(row.campaign_id), runNumber: run.runNumber };
      await connection.execute(
        `UPDATE OUTREACH_attempts a JOIN OUTREACH_websites w ON w.website_id = a.website_id
         SET a.execution_status = 'run_failed', a.completed_time = UTC_TIMESTAMP(3), a.outcome_reason = 'WORKER_INTERRUPTED'
         WHERE w.campaign_id = ? AND a.run_number = ? AND a.execution_status = 'running'`, [identity.campaignId, identity.runNumber]);
      const time = this.now().toISOString();
      const running: CampaignRun = { ...run, state: "running", startedTime: run.startedTime ?? time, heartbeatTime: time };
      await save_current(connection, identity, running, run.state);
      await connection.commit();
      return { ...reply(row, running), websiteIdUpperBound: run.websiteIdUpperBound };
    } catch (error) {
      try { await connection.rollback(); } catch { reusable = false; connection.destroy(); } throw error;
    } finally { if (reusable) connection.release(); }
  }

  private async updateRun(identity: RunIdentity, change: (connection: PoolConnection, run: CampaignRun) => Promise<CampaignRun>): Promise<void> {
    const connection = await this.pool.getConnection(); let reusable = true;
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute<CampaignRow[]>(
        "SELECT * FROM OUTREACH_campaigns WHERE campaign_id = ? AND run_sequence = ? AND run_state = 'running' FOR UPDATE",
        [identity.campaignId, identity.runNumber]);
      if (!rows[0]) throw new Error("Active campaign run was not found.");
      const run = current(rows[0]);
      if (run.state !== "running" || run.runNumber !== identity.runNumber) throw new Error("Campaign run changed.");
      await save_current(connection, identity, await change(connection, run), "running");
      await connection.commit();
    } catch (error) {
      try { await connection.rollback(); } catch { reusable = false; connection.destroy(); } throw error;
    } finally { if (reusable) connection.release(); }
  }
  async heartbeat(identity: RunIdentity): Promise<void> {
    await this.updateRun(identity, async (_, run) => ({ ...run, heartbeatTime: this.now().toISOString() }));
  }
  async finish(identity: RunIdentity, summary: DatabaseRunSummary | undefined): Promise<void> {
    await this.updateRun(identity, async (connection, run) => {
      if (!summary) await connection.execute(
        `UPDATE OUTREACH_attempts a JOIN OUTREACH_websites w ON w.website_id = a.website_id
         SET a.execution_status = 'run_failed', a.completed_time = UTC_TIMESTAMP(3), a.outcome_reason = 'RUN_FAILED'
         WHERE w.campaign_id = ? AND a.run_number = ? AND a.execution_status = 'running'`, [identity.campaignId, identity.runNumber]);
      if (summary) {
        const [attempts] = await connection.execute<RowDataPacket[]>(
          `SELECT a.execution_status, a.forms_result FROM OUTREACH_attempts a JOIN OUTREACH_websites w ON w.website_id = a.website_id
           WHERE w.campaign_id = ? AND a.run_number = ? AND NOT EXISTS (SELECT 1 FROM OUTREACH_attempts later
             WHERE later.website_id = a.website_id AND later.run_number = a.run_number AND later.attempt_id > a.attempt_id)`,
          [identity.campaignId, identity.runNumber]);
        const skipped = attempts.filter(a => a.execution_status === "skipped").length;
        const timedOut = attempts.filter(a => a.execution_status === "timed_out").length;
        const succeeded = attempts.filter(a => a.execution_status === "finished" && a.forms_result === "success").length;
        const partial = attempts.filter(a => a.execution_status === "finished" && ["partial", "inconclusive"].includes(a.forms_result)).length;
        const processed = attempts.length - skipped;
        summary = { ...summary, eligible: attempts.length, processed, skipped, timedOut, succeeded, partial,
          failed: processed - timedOut - succeeded - partial, confirmed: true };
      }
      const time = this.now().toISOString();
      return { ...run, state: summary ? "completed" : "failed", heartbeatTime: time, completedTime: time,
        failureCode: summary ? null : "RUN_FAILED", summary: summary ?? null };
    });
  }
}
