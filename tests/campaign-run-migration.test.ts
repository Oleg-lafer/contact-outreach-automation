import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { Connection } from "mysql2/promise";
import { convert_legacy_runs, migrate_campaign_run_storage, type RunStorageSnapshot } from "../src/database/migrate_campaign_run_storage.js";
import { campaign_content_requires_migration } from "../src/database/run_database_migrations.js";

type Row = Record<string, unknown>;
function fixture(legacy = true) {
  const campaigns: Row[] = [{ campaign_id: 2, campaign_name: "Agriculture", sender_details: { name: "Jane" }, message_to_send: "  Hello\n\n", prevent_resend: 1, created_time: "2026-01-01 00:00:00.000" },
    { campaign_id: 3, campaign_name: "Economics", sender_details: { name: "Doe" }, message_to_send: "Message", prevent_resend: 1, created_time: "2026-01-01 00:00:00.000" }];
  const websites = [{ website_id: 1, campaign_id: 2 }, { website_id: 2, campaign_id: 3 }];
  const runs: Row[] = [
    { run_id: 10, campaign_id: 2, state: "completed", run_mode: "production" },
    { run_id: 20, campaign_id: 3, state: "failed", run_mode: "deep-debug" },
    { run_id: 30, campaign_id: 2, state: "completed", run_mode: "production" },
  ].map(row => ({ ...row, created_time: "2026-01-01 00:00:00.000", started_time: "2026-01-01 00:00:01.000",
    heartbeat_time: "2026-01-01 00:00:02.000", completed_time: "2026-01-01 00:00:02.000", website_id_upper_bound: 50,
    failure_code: row.state === "failed" ? "RUN_FAILED" : null, summary: row.state === "completed" ? { processed: 1 } : null }));
  const attempts: Row[] = [{ attempt_id: 1, website_id: 1, execution_status: "finished", forms_result: "success", run_id: legacy ? 10 : null },
    { attempt_id: 2, website_id: 2, execution_status: "run_failed", forms_result: null, run_id: legacy ? 20 : null },
    { attempt_id: 3, website_id: 1, execution_status: "finished", forms_result: "partial", run_id: legacy ? 30 : null },
    { attempt_id: 4, website_id: 1, execution_status: "finished", forms_result: "failed", run_id: null }];
  if (!legacy) for (const row of attempts) delete row.run_id;
  const tables = new Map<string, Row[]>([["OUTREACH_campaigns", campaigns], ["OUTREACH_websites", websites], ["OUTREACH_attempts", attempts]]);
  if (legacy) tables.set("OUTREACH_runs", runs);
  const columns = new Map([...tables].map(([table, rows]) => [table, new Set(Object.keys(rows[0] ?? {}))]));
  const indexes = new Set(legacy ? ["idx_outreach_attempt_run"] : []);
  let foreign = legacy;
  let saved: Map<string, Row[]> | undefined;
  const events: string[] = [];
  let fail: ((sql: string) => boolean) | undefined;
  const connection = {
    beginTransaction: async () => { saved = structuredClone(tables); events.push("begin"); },
    commit: async () => { saved = undefined; events.push("commit"); },
    rollback: async () => { if (saved) { tables.clear(); for (const entry of saved) tables.set(...entry); } saved = undefined; events.push("rollback"); },
    query: async (sql: string, values: unknown[] = []) => {
      if (fail?.(sql)) { fail = undefined; throw new Error("injected interruption"); }
      if (sql.includes("SELECT DATABASE()")) return [[{ name: "leadspot_main", utcOffset: 0 }]];
      if (sql.includes("GET_LOCK")) return [[{ acquired: "1" }]];
      if (sql.includes("RELEASE_LOCK")) return [[{ released: 1 }]];
      if (sql.includes("SELECT COUNT(*)")) return [[{ count: tables.get("OUTREACH_attempts")!.filter(row => ["queued", "running"].includes(String(row.execution_status))).length }]];
      if (sql.startsWith("SELECT attempt_id, execution_status")) return [tables.get("OUTREACH_attempts")!.filter(row => ["queued", "running"].includes(String(row.execution_status))).map(row => ({ ...row, age_seconds: row.age_seconds ?? 0 }))];
      if (sql.includes("information_schema.KEY_COLUMN_USAGE")) return [foreign ? [{ name: "fk_outreach_attempt_run" }] : []];
      if (sql.includes("information_schema.TABLES")) return [tables.has(String(values[0])) ? [{ present: 1 }] : []];
      if (sql.includes("information_schema.COLUMNS")) return [columns.get(String(values[0]))?.has(String(values[1])) ? [{ present: 1 }] : []];
      if (sql.includes("information_schema.STATISTICS")) return [indexes.has(String(values[1])) ? [{ present: 1 }] : []];
      if (sql.startsWith("SHOW CREATE TABLE")) return [[{ "Create Table": sql.replace("SHOW CREATE TABLE", "CREATE TABLE") }]];
      if (sql.startsWith("SELECT * FROM")) {
        const name = /FROM `([^`]+)`/.exec(sql)![1]!;
        return [structuredClone(tables.get(name)!)];
      }
      events.push(sql);
      const add = /^ALTER TABLE `([^`]+)` ADD (COLUMN|INDEX) `([^`]+)`/.exec(sql);
      if (add) {
        if (add[2] === "INDEX") indexes.add(add[3]!);
        else { columns.get(add[1]!)!.add(add[3]!); for (const row of tables.get(add[1]!)!) row[add[3]!] = add[3] === "run_sequence" ? 0 : null; }
        return [[]];
      }
      if (sql.includes("DROP FOREIGN KEY")) { foreign = false; return [[]]; }
      if (sql.includes("DROP INDEX")) { indexes.delete("idx_outreach_attempt_run"); return [[]]; }
      if (sql.includes("DROP COLUMN")) { columns.get("OUTREACH_attempts")!.delete("run_id"); for (const row of tables.get("OUTREACH_attempts")!) delete row.run_id; return [[]]; }
      if (sql === "DROP TABLE OUTREACH_runs") { tables.delete("OUTREACH_runs"); columns.delete("OUTREACH_runs"); return [[]]; }
      throw new Error("Unhandled migration fixture query: " + sql);
    },
    execute: async (sql: string, values: unknown[]) => {
      if (fail?.(sql)) { fail = undefined; throw new Error("injected interruption"); }
      events.push(sql);
      if (sql.startsWith("UPDATE OUTREACH_campaigns SET run_sequence")) {
        const row = tables.get("OUTREACH_campaigns")!.find(row => row.campaign_id === values[5])!;
        Object.assign(row, { run_sequence: values[0], run_state: values[1], run_requested_time: values[2], current_run: JSON.parse(String(values[3])), run_history: JSON.parse(String(values[4])) });
      } else if (sql.startsWith("UPDATE OUTREACH_campaigns")) {
        const row = tables.get("OUTREACH_campaigns")!.find(row => row.campaign_id === values[0])!; row.run_history ??= [];
      } else {
        tables.get("OUTREACH_attempts")!.find(row => row.attempt_id === values[1])!.run_number = values[0];
      }
      return [{ affectedRows: 1 }];
    },
  } as unknown as Connection;
  return { connection, tables, columns, events, setFailure: (value: (sql: string) => boolean) => { fail = value; } };
}
const options = { maintenanceConfirmed: true, backup: async (_snapshot: RunStorageSnapshot) => {} };

test("fresh schema creates no runs table and keeps all existing content", async () => {
  const db = fixture(false);
  const result = await migrate_campaign_run_storage(db.connection, options);
  assert.equal(result.legacyRunsCopied, 0); assert.equal(db.tables.has("OUTREACH_runs"), false);
  for (const row of db.tables.get("OUTREACH_campaigns")!) { assert.equal(row.run_sequence, 0); assert.deepEqual(row.run_history, []); assert.equal(row.current_run, null); }
  assert.equal(db.tables.get("OUTREACH_campaigns")![0]!.message_to_send, "  Hello\n\n");
  assert.ok(db.tables.get("OUTREACH_attempts")!.every(row => row.run_number === null));
});

test("legacy migration preserves history and links attempts using campaign-specific numbers", async () => {
  const db = fixture();
  let backedUp = false;
  const result = await migrate_campaign_run_storage(db.connection, { maintenanceConfirmed: true, backup: async snapshot => {
    assert.equal(snapshot.runs.length, 3); assert.equal(db.events.some(sql => sql.startsWith("ALTER")), false); backedUp = true;
  } });
  assert.equal(backedUp, true); assert.equal(result.legacyRunsCopied, 3); assert.equal(result.linkedAttemptsConverted, 3);
  const [agriculture, economics] = db.tables.get("OUTREACH_campaigns")!;
  assert.equal(agriculture!.run_sequence, 2); assert.equal(economics!.run_sequence, 1);
  const history = agriculture!.run_history as Array<{ legacyRunId: number; runNumber: number }>;
  assert.equal(history[0]?.legacyRunId, 10); assert.equal(history[0]?.runNumber, 1);
  assert.equal((agriculture!.current_run as { legacyRunId: number }).legacyRunId, 30);
  assert.deepEqual(db.tables.get("OUTREACH_attempts")!.map(row => row.run_number), [1, 1, 2, null]);
  assert.equal(db.tables.has("OUTREACH_runs"), false); assert.equal(db.columns.get("OUTREACH_attempts")!.has("run_id"), false);
  const saved = structuredClone([...db.tables]);
  await migrate_campaign_run_storage(db.connection, options);
  assert.deepEqual([...db.tables], saved);
});

test("migration recovers from partial schema, rolled-back data, and cleanup interruptions", async () => {
  for (const failure of ["ADD COLUMN `current_run`", "UPDATE OUTREACH_attempts SET run_number", "DROP TABLE OUTREACH_runs"]) {
    const db = fixture(); db.setFailure(sql => sql.includes(failure));
    await assert.rejects(migrate_campaign_run_storage(db.connection, options), /injected interruption/);
    assert.equal(db.tables.has("OUTREACH_runs"), true);
    await migrate_campaign_run_storage(db.connection, options);
    assert.equal(db.tables.has("OUTREACH_runs"), false);
    assert.deepEqual(db.tables.get("OUTREACH_attempts")!.map(row => row.run_number), [1, 1, 2, null]);
    assert.equal((db.tables.get("OUTREACH_campaigns")![0]!.run_history as unknown[]).length, 1);
  }
});

test("maintenance, active work, backup failures and conflicting links stop before schema writes", async () => {
  const denied = fixture(); await assert.rejects(migrate_campaign_run_storage(denied.connection, { ...options, maintenanceConfirmed: false }));
  assert.equal(denied.events.length, 0);
  const active = fixture(); active.tables.get("OUTREACH_attempts")![0]!.execution_status = "running";
  await assert.rejects(migrate_campaign_run_storage(active.connection, options), /Unfinished/);
  assert.equal(active.events.some(sql => sql.startsWith("ALTER")), false);
  const conflict = fixture(); conflict.tables.get("OUTREACH_attempts")![0]!.run_id = 20;
  await assert.rejects(migrate_campaign_run_storage(conflict.connection, options), /Conflicting/);
  assert.equal(conflict.events.some(sql => sql.startsWith("ALTER")), false);
  const backup = fixture();
  await assert.rejects(migrate_campaign_run_storage(backup.connection, { maintenanceConfirmed: true, backup: async () => { throw new Error("backup failed"); } }), /backup failed/);
  assert.equal(backup.events.some(sql => sql.startsWith("ALTER")), false);
});

test("backup contains schema and data and passes its saved SHA-256 check", async () => {
  const directory = await mkdtemp(join(tmpdir(), "campaign-backup-test-"));
  try {
    const db = fixture(); const result = await migrate_campaign_run_storage(db.connection, { maintenanceConfirmed: true, backupDirectory: directory });
    assert.ok(result.backupPath);
    const data = await readFile(result.backupPath, "utf8");
    assert.equal(createHash("sha256").update(data).digest("hex"), (await readFile(result.backupPath + ".sha256", "utf8")).trim());
    const saved = JSON.parse(data) as RunStorageSnapshot;
    assert.equal(saved.runs.length, 3); assert.equal(saved.attempts[0]?.run_id, 10); assert.ok(saved.schema.OUTREACH_runs);
    assert.equal((await readdir(directory)).length, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("explicit old unlinked attempts can be preserved without changing their outcomes", async () => {
  const db = fixture();
  const stale = db.tables.get("OUTREACH_attempts")![3]!;
  Object.assign(stale, { execution_status: "running", age_seconds: 100_000 });
  const saved = structuredClone(stale);
  await migrate_campaign_run_storage(db.connection, { ...options, preserveStaleAttemptIds: [4] });
  const converted = db.tables.get("OUTREACH_attempts")![3]!;
  delete saved.run_id; saved.run_number = null;
  assert.deepEqual(converted, saved);
  for (const change of [{ age_seconds: 100 }, { run_id: 30 }, { execution_status: "queued" }]) {
    const denied = fixture(); Object.assign(denied.tables.get("OUTREACH_attempts")![3]!, { execution_status: "running", age_seconds: 100_000 }, change);
    await assert.rejects(migrate_campaign_run_storage(denied.connection, { ...options, preserveStaleAttemptIds: [4] }), /Unfinished/);
    assert.equal(denied.events.some(sql => sql.startsWith("ALTER")), false);
  }
});

test("conversion orders old IDs within each campaign and rejects active runs", () => {
  assert.throws(() => convert_legacy_runs([{ run_id: 1, campaign_id: 2, state: "running" }]), /Pause/);
  assert.equal(campaign_content_requires_migration([{ name: "sender_details", type: "json" }, { name: "message_to_send", type: "text" }]), false);
  assert.equal(campaign_content_requires_migration([{ name: "sender_details", type: "longtext" }, { name: "message_to_send", type: "varchar" }]), true);
});
