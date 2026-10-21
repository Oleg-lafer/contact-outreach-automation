import { setTimeout as delay } from "node:timers/promises";
import type { DatabaseRunSummary } from "../contact_outreach_workflow/database_outreach_runner.js";
import type { ExecutionLock } from "../contact_outreach_workflow/shared_files_orchestrator/execution_lock_(Integration).js";
import type { QueuedRun, RunQueue } from "./mysql_launch_repository.js";

export interface WorkerDependencies {
  queue: RunQueue;
  acquireLock(): Promise<ExecutionLock | undefined>;
  execute(run: QueuedRun, signal: AbortSignal): Promise<DatabaseRunSummary>;
}
export async function work_once(dependencies: WorkerDependencies, stop: AbortSignal): Promise<boolean> {
  stop.throwIfAborted();
  const lock = await dependencies.acquireLock();
  if (!lock) return false;
  const signal = AbortSignal.any([stop, lock.signal]);
  try {
    signal.throwIfAborted();
    await lock.check();
    const run = await dependencies.queue.next();
    if (!run) return false;
    signal.throwIfAborted();
    let summary: DatabaseRunSummary | undefined;
    let heartbeatFailure: unknown;
    let pendingHeartbeat: Promise<void> | undefined;
    const failedHeartbeat = new AbortController();
    const executionSignal = AbortSignal.any([signal, failedHeartbeat.signal]);
    const heartbeat = setInterval(() => {
      if (!pendingHeartbeat) pendingHeartbeat = dependencies.queue.heartbeat(run)
        .catch(error => { heartbeatFailure = error; failedHeartbeat.abort(); })
        .finally(() => { pendingHeartbeat = undefined; });
    }, 5_000);
    try {
      summary = await dependencies.execute(run, executionSignal);
    } catch (error) {
      // Infrastructure interruption leaves the run active for automatic resume.
      if (executionSignal.aborted) throw error;
      console.error(`ContactUs campaign ${run.campaignId} run ${run.runNumber} failed.`);
    } finally {
      clearInterval(heartbeat);
      await pendingHeartbeat;
    }
    executionSignal.throwIfAborted();
    if (heartbeatFailure) throw new Error("Run heartbeat failed.");
    await lock.check();
    await dependencies.queue.finish(run, summary);
    return true;
  } finally { await lock.release(); }
}
export async function run_worker(dependencies: WorkerDependencies, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    await work_once(dependencies, signal);
    await delay(2_000, undefined, { signal }).catch(error => { if (!signal.aborted) throw error; });
  }
}
