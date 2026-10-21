import { existsSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { Connection, RowDataPacket } from "mysql2/promise";
import { json_value, read_run, run_history, safe_run_number, sql_utc_time, type CampaignRun } from "../api/campaign_run.js";
import { EXECUTION_LOCK_NAME } from "../contact_outreach_workflow/shared_files_orchestrator/execution_lock_(Integration).js";

const campaignColumns = ["run_sequence", "run_state", "run_requested_time", "current_run", "run_history"];
type Row = Record<string, unknown>;
export interface RunStorageSnapshot {
  schema: Record<string, string>;
  campaigns: Row[];
  websites: Row[];
  attempts: Row[];
  runs: Row[];
}
export interface MigrationOptions {
  maintenanceConfirmed: boolean;
  backupDirectory?: string;
  preserveStaleAttemptIds?: number[];
  // Offline tests can replace file I/O. Production uses the verified disk backup.
  backup?: (snapshot: RunStorageSnapshot) => Promise<void>;
}
function identifier(name: string): string {
  if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error("Unexpected schema identifier.");
  return `\`${name}\``;
}
async function exists(connection: Connection, kind: "TABLES" | "COLUMNS" | "STATISTICS", table: string, name?: string): Promise<boolean> {
  const field = kind === "COLUMNS" ? "COLUMN_NAME" : "INDEX_NAME";
  const [rows] = await connection.query<RowDataPacket[]>(
    `SELECT 1 AS present FROM information_schema.${kind} WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?${name ? ` AND ${field} = ?` : ""} LIMIT 1`,
    name ? [table, name] : [table]);
  return rows.length > 0;
}
async function snapshot(connection: Connection): Promise<RunStorageSnapshot> {
  const result: RunStorageSnapshot = { schema: {}, campaigns: [], websites: [], attempts: [], runs: [] };
  const tables = { campaigns: "OUTREACH_campaigns", websites: "OUTREACH_websites", attempts: "OUTREACH_attempts", runs: "OUTREACH_runs" } as const;
  await connection.beginTransaction();
  try {
    for (const [key, table] of Object.entries(tables) as Array<[keyof typeof tables, string]>) {
      if (!(await exists(connection, "TABLES", table))) continue;
      const [ddl] = await connection.query<RowDataPacket[]>(`SHOW CREATE TABLE ${identifier(table)}`);
      result.schema[table] = String(ddl[0]?.["Create Table"] ?? "");
      const primary = key === "campaigns" ? "campaign_id" : key === "websites" ? "website_id" : key === "attempts" ? "attempt_id" : "run_id";
      const [rows] = await connection.query<RowDataPacket[]>(`SELECT * FROM ${identifier(table)} ORDER BY ${identifier(primary)}`);
      result[key] = rows;
    }
    await connection.commit(); return result;
  } catch (error) { await connection.rollback(); throw error; }
}
async function disk_backup(value: RunStorageSnapshot, directory: string | undefined): Promise<string> {
  if (!directory) throw new Error("A backup directory outside the repositories is required.");
  const backupRoot = resolve(directory);
  const repositoryRoot = resolve(".").toLowerCase();
  if (backupRoot.toLowerCase() === repositoryRoot || backupRoot.toLowerCase().startsWith(repositoryRoot + "\\") ||
      backupRoot.toLowerCase().startsWith(repositoryRoot + "/")) throw new Error("Backups must be outside the repository.");
  for (let parent = backupRoot; ; parent = dirname(parent)) {
    if (existsSync(join(parent, ".git"))) throw new Error("Backups must be outside Git repositories.");
    if (dirname(parent) === parent) break;
  }
  await mkdir(backupRoot, { recursive: true });
  const path = join(backupRoot, `campaign-runs-${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${randomUUID()}.json`);
  const data = JSON.stringify(value, null, 2);
  const digest = createHash("sha256").update(data).digest("hex");
  await writeFile(path, data, { encoding: "utf8", flag: "wx" });
  const saved = await readFile(path, "utf8");
  if (createHash("sha256").update(saved).digest("hex") !== digest) throw new Error("Backup verification failed.");
  await writeFile(path + ".sha256", digest + "\n", { encoding: "utf8", flag: "wx" });
  if (!isDeepStrictEqual(JSON.parse(saved), JSON.parse(data))) throw new Error("Backup data verification failed.");
  return path;
}
function legacy_time(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "string") throw new Error("Invalid historical timestamp.");
  const date = new Date(value.includes("T") ? value : value.replace(" ", "T") + "Z");
  if (!Number.isFinite(date.getTime())) throw new Error("Invalid historical timestamp.");
  return date.toISOString();
}
export function convert_legacy_runs(rows: Row[]): Map<number, CampaignRun[]> {
  const grouped = new Map<number, CampaignRun[]>();
  const ids = new Set<number>();
  const ordered = [...rows].sort((a, b) => safe_run_number(a.run_id) - safe_run_number(b.run_id));
  for (const row of ordered) {
    const legacyRunId = safe_run_number(row.run_id); const campaignId = safe_run_number(row.campaign_id);
    if (ids.has(legacyRunId)) throw new Error("Duplicate historical run ID.");
    ids.add(legacyRunId);
    if (row.state !== "completed" && row.state !== "failed") throw new Error("Pause active runs before migration.");
    const list = grouped.get(campaignId) ?? [];
    const requestedTime = legacy_time(row.created_time); const completedTime = legacy_time(row.completed_time);
    if (!requestedTime || !completedTime) throw new Error("Historical terminal run has missing timestamps.");
    const run = read_run({ runNumber: list.length + 1, state: row.state, runMode: row.run_mode,
      requestedTime, startedTime: legacy_time(row.started_time), heartbeatTime: legacy_time(row.heartbeat_time), completedTime,
      websiteIdUpperBound: safe_run_number(row.website_id_upper_bound), failureCode: row.failure_code ?? null,
      summary: json_value(row.summary), legacyRunId });
    list.push(run); grouped.set(campaignId, list);
  }
  return grouped;
}
function campaign_runs(row: Row): CampaignRun[] {
  const history = run_history(row.run_history);
  const current = json_value(row.current_run) == null ? undefined : read_run(row.current_run);
  const all = current ? [...history, current] : history;
  const sequence = safe_run_number(row.run_sequence ?? 0, true);
  if (all.length !== sequence || all.some((run, i) => run.runNumber !== i + 1) ||
      (current?.state ?? null) !== (row.run_state ?? null) ||
      history.some(run => run.state === "queued" || run.state === "running") || (!current && sequence !== 0)) {
    throw new Error("Campaign run history is inconsistent.");
  }
  return all;
}
export function verify_conversion(before: RunStorageSnapshot, after: RunStorageSnapshot): void {
  const unchanged = (rows: Row[], remove: string[]) => rows.map(row => Object.fromEntries(Object.entries(row).filter(([name]) => !remove.includes(name))));
  if (!isDeepStrictEqual(unchanged(before.campaigns, campaignColumns), unchanged(after.campaigns, campaignColumns)) ||
      !isDeepStrictEqual(unchanged(before.attempts, ["run_id", "run_number"]), unchanged(after.attempts, ["run_id", "run_number"])) ||
      !isDeepStrictEqual(before.websites, after.websites)) throw new Error("Existing campaign, website, or attempt data changed.");
  const expected = convert_legacy_runs(before.runs);
  const campaigns = new Map(after.campaigns.map(row => [safe_run_number(row.campaign_id), campaign_runs(row)]));
  for (const [campaignId, runs] of expected) {
    const stored = campaigns.get(campaignId);
    if (!stored || runs.some(run => !isDeepStrictEqual(stored[run.runNumber - 1], run))) throw new Error("Historical run verification failed.");
  }
  const websiteCampaign = new Map(after.websites.map(row => [String(row.website_id), safe_run_number(row.campaign_id)]));
  const byLegacyId = new Map([...expected].flatMap(([campaignId, runs]) => runs.map(run => [String(run.legacyRunId), { campaignId, runNumber: run.runNumber }] as const)));
  const afterAttempts = new Map(after.attempts.map(row => [String(row.attempt_id), row]));
  for (const attempt of before.attempts) {
    if (attempt.run_id == null) continue;
    const identity = byLegacyId.get(String(attempt.run_id));
    const converted = afterAttempts.get(String(attempt.attempt_id));
    if (!identity || identity.campaignId !== websiteCampaign.get(String(attempt.website_id)) ||
        Number(converted?.run_number) !== identity.runNumber) throw new Error("Attempt run mapping verification failed.");
  }
  for (const attempt of after.attempts) {
    if (attempt.run_number == null) continue;
    const campaignId = websiteCampaign.get(String(attempt.website_id));
    const number = safe_run_number(attempt.run_number);
    if (!campaignId || !campaigns.get(campaignId)?.some(run => run.runNumber === number)) throw new Error("Attempt has no matching campaign run.");
  }
}
async function add_schema(connection: Connection): Promise<void> {
  const sql = await readFile(resolve("database/migrations/007_store_runs_in_campaigns.sql"), "utf8");
  const statements = sql.replace(/^--.*$/gm, "").split(";").map(value => value.trim()).filter(Boolean);
  for (const statement of statements) {
    const match = /^ALTER TABLE `(OUTREACH_campaigns|OUTREACH_attempts)` ADD (COLUMN|INDEX) `([a-z_]+)`/.exec(statement);
    if (!match) throw new Error("Unexpected migration statement.");
    if (!(await exists(connection, match[2] === "COLUMN" ? "COLUMNS" : "STATISTICS", match[1]!, match[3]!))) await connection.query(statement);
  }
}
export async function assert_no_active_attempts(connection: Connection, preservedIds: number[] = []): Promise<void> {
  const allowed = new Set(preservedIds.map(id => safe_run_number(id)));
  const oldColumn = await exists(connection, "COLUMNS", "OUTREACH_attempts", "run_id");
  const [attempts] = await connection.query<RowDataPacket[]>(
    `SELECT attempt_id, execution_status, ${oldColumn ? "run_id" : "NULL AS run_id"},
     TIMESTAMPDIFF(SECOND, COALESCE(started_time, created_time), UTC_TIMESTAMP()) AS age_seconds
     FROM OUTREACH_attempts WHERE execution_status IN ('queued','running')`);
  for (const attempt of attempts) {
    // An operator must confirm maintenance and name each old record explicitly.
    // This does not edit or retry it. Recent, queued, and linked work still stops.
    if (!allowed.has(safe_run_number(attempt.attempt_id)) || attempt.execution_status !== "running" ||
        attempt.run_id != null || !Number.isFinite(Number(attempt.age_seconds)) || Number(attempt.age_seconds) < 86_400) {
      throw new Error("Unfinished outreach attempts exist. Migration stopped.");
    }
  }
}
export async function migrate_campaign_run_storage(connection: Connection, options: MigrationOptions): Promise<{
  legacyRunsCopied: number; linkedAttemptsConverted: number; backupPath?: string;
}> {
  if (!options.maintenanceConfirmed) throw new Error("Pause API, worker, and scheduled outreach before confirming maintenance.");
  const [database] = await connection.query<RowDataPacket[]>("SELECT DATABASE() AS name, TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(), NOW()) AS utcOffset");
  if (database[0]?.name !== "leadspot_main" || Number(database[0]?.utcOffset) !== 0) throw new Error("Migration requires leadspot_main and UTC database session time.");
  const [lock] = await connection.query<RowDataPacket[]>("SELECT GET_LOCK(?, 0) AS acquired", [EXECUTION_LOCK_NAME]);
  if (Number(lock[0]?.acquired) !== 1) throw new Error("Outreach execution is active. Migration stopped.");
  try {
    await assert_no_active_attempts(connection, options.preserveStaleAttemptIds);
    const before = await snapshot(connection);
    if (before.runs.some(row => row.state === "queued" || row.state === "running") ||
        before.campaigns.some(row => row.run_state === "queued" || row.run_state === "running")) throw new Error("Pending runs exist. Migration stopped.");
    const converted = convert_legacy_runs(before.runs);
    const byLegacy = new Map([...converted].flatMap(([campaignId, runs]) => runs.map(run => [String(run.legacyRunId), { campaignId, runNumber: run.runNumber }] as const)));
    const websiteCampaign = new Map(before.websites.map(row => [String(row.website_id), safe_run_number(row.campaign_id)]));
    for (const attempt of before.attempts) {
      if (attempt.run_id == null) continue;
      const identity = byLegacy.get(String(attempt.run_id));
      if (!identity || identity.campaignId !== websiteCampaign.get(String(attempt.website_id)) ||
          (attempt.run_number != null && Number(attempt.run_number) !== identity.runNumber)) throw new Error("Conflicting historical attempt mapping.");
    }
    for (const campaignId of converted.keys()) {
      if (!before.campaigns.some(row => Number(row.campaign_id) === campaignId)) throw new Error("Historical run has no campaign.");
    }
    let backupPath: string | undefined;
    if (options.backup) await options.backup(before);
    else backupPath = await disk_backup(before, options.backupDirectory);
    await add_schema(connection);
    await connection.beginTransaction();
    try {
      for (const row of before.campaigns) {
        const campaignId = safe_run_number(row.campaign_id); const runs = converted.get(campaignId);
        if (runs) {
          const previousSequence = safe_run_number(row.run_sequence ?? 0, true);
          if (previousSequence !== 0 && !isDeepStrictEqual(campaign_runs(row), runs)) throw new Error("Existing campaign run data conflicts with historical runs.");
          if (previousSequence === 0 && (json_value(row.current_run) != null || run_history(row.run_history).length)) throw new Error("Unexpected existing run JSON.");
          const last = runs.at(-1)!;
          await connection.execute(
            "UPDATE OUTREACH_campaigns SET run_sequence = ?, run_state = ?, run_requested_time = ?, current_run = ?, run_history = ? WHERE campaign_id = ?",
            [runs.length, last.state, sql_utc_time(last.requestedTime), JSON.stringify(last), JSON.stringify(runs.slice(0, -1)), campaignId]);
        } else {
          campaign_runs(row);
          await connection.execute("UPDATE OUTREACH_campaigns SET run_history = COALESCE(run_history, JSON_ARRAY()) WHERE campaign_id = ?", [campaignId]);
        }
      }
      for (const attempt of before.attempts) {
        if (attempt.run_id == null) continue;
        const identity = byLegacy.get(String(attempt.run_id))!;
        await connection.execute("UPDATE OUTREACH_attempts SET run_number = ? WHERE attempt_id = ?", [identity.runNumber, safe_run_number(attempt.attempt_id)]);
      }
      await connection.commit();
    } catch (error) { await connection.rollback(); throw error; }
    verify_conversion(before, await snapshot(connection));
    const [foreignKeys] = await connection.query<RowDataPacket[]>(
      "SELECT CONSTRAINT_NAME AS name FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'OUTREACH_attempts' AND COLUMN_NAME = 'run_id' AND REFERENCED_TABLE_NAME = 'OUTREACH_runs'");
    for (const key of foreignKeys) await connection.query(`ALTER TABLE OUTREACH_attempts DROP FOREIGN KEY ${identifier(String(key.name))}`);
    if (await exists(connection, "STATISTICS", "OUTREACH_attempts", "idx_outreach_attempt_run")) await connection.query("ALTER TABLE OUTREACH_attempts DROP INDEX idx_outreach_attempt_run");
    if (await exists(connection, "COLUMNS", "OUTREACH_attempts", "run_id")) await connection.query("ALTER TABLE OUTREACH_attempts DROP COLUMN run_id");
    // Recheck data before the last destructive schema step. A restart after the
    // preceding DDL can still verify run_number against the copied legacy IDs.
    verify_conversion(before, await snapshot(connection));
    if (await exists(connection, "TABLES", "OUTREACH_runs")) await connection.query("DROP TABLE OUTREACH_runs");
    verify_conversion(before, await snapshot(connection));
    return { legacyRunsCopied: before.runs.length, linkedAttemptsConverted: before.attempts.filter(row => row.run_id != null).length,
      ...(backupPath ? { backupPath } : {}) };
  } finally { await connection.query("SELECT RELEASE_LOCK(?)", [EXECUTION_LOCK_NAME]); }
}
