import type { Pool } from "mysql2/promise";
import type { CampaignRun } from "../src/api/campaign_run.js";

export const fixture_run = (overrides: Partial<CampaignRun> = {}): CampaignRun => ({
  runNumber: 1, state: "completed", runMode: "production", requestedTime: "2026-01-01T00:00:00.000Z",
  startedTime: "2026-01-01T00:00:01.000Z", heartbeatTime: "2026-01-01T00:00:02.000Z",
  completedTime: "2026-01-01T00:00:02.000Z", websiteIdUpperBound: 50, failureCode: null, summary: null, ...overrides,
});
export interface FixtureCampaign {
  campaign_id: number; run_sequence: number; run_state: CampaignRun["state"] | null;
  run_requested_time: string | null; current_run: CampaignRun | null; run_history: CampaignRun[] | null;
}
export const fixture_campaign = (id = 123, run: CampaignRun | null = null, history: CampaignRun[] = []): FixtureCampaign => ({
  campaign_id: id, run_sequence: run?.runNumber ?? 0, run_state: run?.state ?? null,
  run_requested_time: run?.requestedTime ?? null, current_run: run, run_history: history,
});
export function campaign_pool(initial: FixtureCampaign[] = [fixture_campaign()], options: {
  eligible?: number; failUpdate?: boolean; failCommit?: boolean; rollbackFailure?: boolean; schemaMissing?: boolean;
} = {}) {
  const rows = new Map(initial.map(row => [row.campaign_id, structuredClone(row)]));
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const attempts: Array<{ campaign_id: number; run_number: number; execution_status: string; forms_result: string | null; outcome_reason?: string }> = [];
  let gate = Promise.resolve();
  const pool = {
    query: async () => { if (options.schemaMissing) throw Object.assign(new Error("secret schema"), { code: "ER_BAD_FIELD_ERROR" }); return [[{ ready: 2, obsolete: 0 }]]; },
    getConnection: async () => {
      let unlock: (() => void) | undefined;
      let locked = false;
      const pending = new Map<number, FixtureCampaign>();
      const get = (id: number) => pending.get(id) ?? rows.get(id);
      const end = () => { unlock?.(); unlock = undefined; };
      return {
        beginTransaction: async () => { calls.push({ sql: "BEGIN", values: [] }); },
        commit: async () => {
          calls.push({ sql: "COMMIT", values: [] }); if (options.failCommit) throw new Error("secret commit");
          for (const [id, row] of pending) rows.set(id, row); pending.clear(); end();
        },
        rollback: async () => { calls.push({ sql: "ROLLBACK", values: [] }); pending.clear(); end(); if (options.rollbackFailure) throw new Error("secret rollback"); },
        release: () => { calls.push({ sql: "RELEASE", values: [] }); end(); },
        destroy: () => { calls.push({ sql: "DESTROY", values: [] }); end(); },
        execute: async (sql: string, values: unknown[] = []) => {
          calls.push({ sql, values });
          if (sql.startsWith("SELECT * FROM OUTREACH_campaigns")) {
            if (!locked) { const previous = gate; gate = new Promise<void>(resolve => { unlock = resolve; }); await previous; locked = true; }
            if (sql.includes("ORDER BY")) {
              const active = [...rows.values()].filter(row => ["queued", "running"].includes(row.run_state ?? ""))
                .sort((a, b) => Number(b.run_state === "running") - Number(a.run_state === "running") ||
                  (a.run_requested_time ?? "").localeCompare(b.run_requested_time ?? "") || a.campaign_id - b.campaign_id);
              return [structuredClone(active.slice(0, 1))];
            }
            const row = get(Number(values[0]));
            return [row && (values.length === 1 || (row.run_sequence === Number(values[1]) && row.run_state === "running")) ? [structuredClone(row)] : []];
          }
          if (sql.startsWith("SELECT MAX")) return [[{ upper_bound: 50, eligible: options.eligible ?? 2 }]];
          if (sql.startsWith("SELECT a.execution_status")) return [attempts.filter(a => a.campaign_id === values[0] && a.run_number === values[1])];
          if (sql.startsWith("UPDATE OUTREACH_attempts")) return [{ affectedRows: 1 }];
          if (sql.startsWith("UPDATE OUTREACH_campaigns")) {
            if (options.failUpdate) throw new Error("secret SQL");
            if (sql.includes("SET run_sequence")) {
              const [number, time, run, history, id, previous] = values;
              const row = get(Number(id)); if (!row || row.run_sequence !== previous) return [{ affectedRows: 0 }];
              pending.set(Number(id), { ...row, run_sequence: Number(number), run_state: "queued", run_requested_time: String(time),
                current_run: JSON.parse(String(run)), run_history: JSON.parse(String(history)) });
            } else {
              const [state, run, id, number, previous] = values;
              const row = get(Number(id)); if (!row || row.run_sequence !== number || row.run_state !== previous) return [{ affectedRows: 0 }];
              pending.set(Number(id), { ...row, run_state: state as CampaignRun["state"], current_run: JSON.parse(String(run)) });
            }
            return [{ affectedRows: 1 }];
          }
          throw new Error("Unhandled fixture SQL: " + sql);
        },
      };
    },
  } as unknown as Pool;
  return { pool, rows, calls, attempts };
}
