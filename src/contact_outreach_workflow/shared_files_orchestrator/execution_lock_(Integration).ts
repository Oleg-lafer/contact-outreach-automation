import mysql from "mysql2/promise";
import { database_config_from_environment } from "./outreach_database_(Integration).js";

export const EXECUTION_LOCK_NAME = "leadspot_main.contact_outreach.execution";
export interface ExecutionLock {
  signal: AbortSignal;
  check(): Promise<void>;
  release(): Promise<void>;
}
export interface LockConnection {
  query(sql: string, values?: unknown[]): Promise<unknown>;
  end(): Promise<void>;
  destroy(): void;
  on(event: "error", listener: (error: Error) => void): unknown;
}
export async function acquire_execution_lock(
  environment: NodeJS.ProcessEnv = process.env,
  connect: () => Promise<LockConnection> = () => mysql.createConnection({
    ...database_config_from_environment(environment), connectTimeout: 10_000,
  }),
  forCli = false,
): Promise<ExecutionLock | undefined> {
  const connection = await connect();
  const controller = new AbortController();
  const abort = () => controller.abort(new Error("Execution lock connection was lost."));
  connection.on("error", abort);
  let interval: NodeJS.Timeout | undefined;
  let checking: Promise<void> | undefined;
  let released = false;
  try {
    const [rows] = await connection.query("SELECT GET_LOCK(?, 0) AS acquired", [EXECUTION_LOCK_NAME]) as [Array<{ acquired: number | null }>];
    if (rows[0]?.acquired !== 1) { await connection.end(); return undefined; }
    if (forCli) {
      // An offline worker can still own durable work. A manual CLI must not
      // replace its recovery markers or process the queue out of order.
      let pending: unknown[];
      try {
        [pending] = await connection.query("SELECT campaign_id FROM OUTREACH_campaigns WHERE run_state IN ('queued', 'running') LIMIT 1") as [unknown[]];
      } catch (error) {
        if ((error as { code?: string }).code !== "ER_BAD_FIELD_ERROR") throw error;
        pending = []; // Pre-migration CLI remains supported.
      }
      if (pending.length) throw new Error("Pending API runs must be handled by the ContactUs worker.");
    }
    const check = (): Promise<void> => {
      if (checking) return checking;
      checking = (async () => {
        if (released || controller.signal.aborted) throw new Error("Execution lock is unavailable.");
        let timer: NodeJS.Timeout | undefined;
        try {
          const [state] = await Promise.race([
            connection.query("SELECT IS_USED_LOCK(?) = CONNECTION_ID() AS owned", [EXECUTION_LOCK_NAME]),
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Lock check timed out.")), 5_000); }),
          ]) as [Array<{ owned: number }>];
          if (state[0]?.owned !== 1) throw new Error("Execution lock is unavailable.");
        } catch (error) { abort(); throw error; }
        finally { if (timer) clearTimeout(timer); }
      })().finally(() => { checking = undefined; });
      return checking;
    };
    interval = setInterval(() => { void check().catch(() => undefined); }, 5_000);
    return {
      signal: controller.signal, check,
      async release() {
        released = true;
        clearInterval(interval);
        await checking?.catch(() => undefined);
        if (controller.signal.aborted) { connection.destroy(); return; }
        try { await connection.query("SELECT RELEASE_LOCK(?)", [EXECUTION_LOCK_NAME]); await connection.end(); }
        catch { connection.destroy(); }
      },
    };
  } catch (error) { if (interval) clearInterval(interval); connection.destroy(); throw error; }
}
