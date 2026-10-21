import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "mysql2/promise";
import { campaign_pool, fixture_campaign, fixture_run } from "./contact-us-run-fixtures.js";
import { work_once, type WorkerDependencies } from "../src/api/launch_worker.js";
import { MysqlLaunchRepository, type QueuedRun } from "../src/api/mysql_launch_repository.js";
import { acquire_execution_lock, EXECUTION_LOCK_NAME, type LockConnection } from "../src/contact_outreach_workflow/shared_files_orchestrator/execution_lock_(Integration).js";
import { claim_is_still_eligible, MysqlDatabaseCampaignRepository, type DatabaseCampaignRepository } from "../src/contact_outreach_workflow/shared_files_orchestrator/database_campaign_repository_(Integration).js";
import { run_database_campaign, type DatabaseRunSummary } from "../src/contact_outreach_workflow/database_outreach_runner.js";
import { run_contact_outreach_core } from "../src/contact_outreach_workflow/orchestrator/contact_outreach_core_(Integration).js";
import { create_form_failure_outcome } from "../src/contact_outreach_workflow/contact_channels/forms/pipeline/D_reporting/D1_form_reporting_(Support).js";
import { create_email_failure_outcome } from "../src/contact_outreach_workflow/contact_channels/emails/pipeline/E_reporting/E1_email_reporting_(Support).js";
import { create_meeting_failure_outcome } from "../src/contact_outreach_workflow/contact_channels/meetings/pipeline/C_reporting/C1_meeting_reporting_(Support).js";
import { create_contact_outreach_outcome } from "../src/contact_outreach_workflow/orchestrator/E_aggregate_reporting/E_aggregate_reporting_(Support).js";

const run = (id = 1): QueuedRun => ({ campaignId: id, runNumber: 1, runMode: "production", status: "running", websiteIdUpperBound: 50 });
const summary = (id = 1): DatabaseRunSummary => ({ campaignId: id, eligible: 1, processed: 1, succeeded: 0, partial: 0,
  failed: 1, timedOut: 0, skipped: 0, unavailable: 0, staleAttemptsRecovered: 0, confirmed: true });

test("global execution lock rejects a second owner and checks connection ownership", async () => {
  const calls: string[] = [];
  let owned = 1;
  let failure: ((error: Error) => void) | undefined;
  const connection: LockConnection = {
    query: async (sql, values) => { calls.push(sql); assert.equal(values?.[0], EXECUTION_LOCK_NAME); return [[{ acquired: 1, owned }]]; },
    on: (_, listener) => { failure = listener; }, end: async () => { calls.push("end"); }, destroy: () => { calls.push("destroy"); },
  };
  const lock = await acquire_execution_lock({}, async () => connection); assert.ok(lock);
  await lock.check(); owned = 0;
  await assert.rejects(lock.check()); assert.equal(lock.signal.aborted, true);
  await lock.release(); assert.equal(calls.at(-1), "destroy");
  assert.ok(failure);
  const busy = await acquire_execution_lock({}, async () => ({ ...connection, query: async () => [[{ acquired: 0 }]] }));
  assert.equal(busy, undefined);
});

test("CLI cannot take over durable API work while the worker is offline", async () => {
  let destroyed = false;
  const connection: LockConnection = { on: () => {}, end: async () => {}, destroy: () => { destroyed = true; },
    query: async sql => sql.includes("GET_LOCK") ? [[{ acquired: 1 }]] : [[{ run_number: 7 }]] };
  await assert.rejects(acquire_execution_lock({}, async () => connection, true), /Pending API runs/);
  assert.equal(destroyed, true);
});

test("worker serializes campaigns and a competing worker cannot execute", async () => {
  const pending = [run(1), run(2)];
  const starts: number[] = []; const finished: number[] = [];
  let held = false; let releaseExecution: (() => void) | undefined;
  const dependencies: WorkerDependencies = {
    acquireLock: async () => {
      if (held) return undefined;
      held = true; return { signal: new AbortController().signal, check: async () => {}, release: async () => { held = false; } };
    },
    queue: { next: async () => pending.shift(), heartbeat: async () => {}, finish: async id => { finished.push(id.campaignId); } },
    execute: async item => { starts.push(item.campaignId); await new Promise<void>(resolve => { releaseExecution = resolve; }); return summary(item.campaignId); },
  };
  const first = work_once(dependencies, new AbortController().signal);
  while (!releaseExecution) await new Promise(resolve => setImmediate(resolve));
  assert.equal(await work_once(dependencies, new AbortController().signal), false);
  assert.deepEqual(starts, [1]);
  releaseExecution(); await first; releaseExecution = undefined;
  const second = work_once(dependencies, new AbortController().signal);
  while (!releaseExecution) await new Promise(resolve => setImmediate(resolve));
  (releaseExecution as () => void)(); await second;
  assert.deepEqual(starts, [1, 2]); assert.deepEqual(finished, [1, 2]); assert.equal(held, false);
});

test("worker distinguishes terminal execution failure from shutdown and lock loss", async () => {
  for (const mode of ["failure", "shutdown", "lock-loss", "finish-failure"] as const) {
    const stop = new AbortController(); const lost = new AbortController(); let released = false;
    const finished: unknown[] = [];
    const dependencies: WorkerDependencies = {
      acquireLock: async () => ({ signal: lost.signal, check: async () => {}, release: async () => { released = true; } }),
      queue: { next: async () => run(), heartbeat: async () => {}, finish: async (_, result) => {
        if (mode === "finish-failure") throw new Error("Database disconnected"); finished.push(result);
      } },
      execute: async (_, signal) => {
        if (mode === "shutdown") stop.abort();
        if (mode === "lock-loss") lost.abort();
        signal.throwIfAborted();
        if (mode === "failure") throw new Error("secret runtime detail");
        return summary();
      },
    };
    if (mode === "failure") { await work_once(dependencies, stop.signal); assert.deepEqual(finished, [undefined]); }
    else { await assert.rejects(work_once(dependencies, stop.signal)); assert.deepEqual(finished, []); }
    assert.equal(released, true);
  }
});

test("queue resumes running work first and scopes recovery by campaign and run number", async () => {
  const db = campaign_pool([fixture_campaign(1, fixture_run({ state: "queued", completedTime: null })),
    fixture_campaign(2, fixture_run({ state: "running", completedTime: null }))]);
  const next = await new MysqlLaunchRepository(db.pool).next();
  assert.equal(next?.campaignId, 2); assert.equal(next?.runNumber, 1);
  const recovery = db.calls.find(call => call.sql.includes("WORKER_INTERRUPTED"))!;
  assert.deepEqual(recovery.values, [2, 1]);
  assert.match(recovery.sql, /w.campaign_id = \? AND a.run_number = \?/);
});

test("queue uses request time and campaign ID for ties", async () => {
  const db = campaign_pool([fixture_campaign(9, fixture_run({ state: "queued", completedTime: null })),
    fixture_campaign(3, fixture_run({ state: "queued", completedTime: null }))]);
  assert.equal((await new MysqlLaunchRepository(db.pool).next())?.campaignId, 3);
});

test("summary, heartbeat and stale-worker checks use both parts of run identity", async () => {
  const db = campaign_pool([fixture_campaign(1, fixture_run({ state: "running", completedTime: null })),
    fixture_campaign(2, fixture_run({ state: "running", completedTime: null }))]);
  db.attempts.push({ campaign_id: 1, run_number: 1, execution_status: "finished", forms_result: "success" },
    { campaign_id: 2, run_number: 1, execution_status: "run_failed", forms_result: null });
  const queue = new MysqlLaunchRepository(db.pool);
  await queue.heartbeat({ campaignId: 1, runNumber: 1 });
  assert.equal(db.rows.get(1)?.current_run?.state, "running");
  await queue.finish({ campaignId: 1, runNumber: 1 }, summary(1));
  const saved = db.rows.get(1)?.current_run?.summary as DatabaseRunSummary;
  assert.equal(saved.processed, 1); assert.equal(saved.succeeded, 1); assert.equal(saved.failed, 0);
  assert.equal(db.rows.get(2)?.run_state, "running");
  await assert.rejects(queue.heartbeat({ campaignId: 2, runNumber: 2 }));
  await assert.rejects(queue.finish({ campaignId: 1, runNumber: 1 }, undefined));
});

test("API website claim records run identity and refuses websites outside its saved boundary", async () => {
  const statements: Array<[string, unknown[] | undefined]> = [];
  const connection = { beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {},
    execute: async (sql: string, values?: unknown[]) => {
      statements.push([sql, values]);
      if (sql.includes("SELECT website_id")) return [[{ website_id: values![1], original_input_url: "http://127.0.0.1" }]];
      if (sql.includes("SELECT attempt_id")) return [[{ attempt_id: 1, execution_status: "run_failed", forms_result: null,
        run_number: 7, outcome_reason: "WORKER_INTERRUPTED" }]];
      return [{ insertId: 2 }];
    } };
  const repository = new MysqlDatabaseCampaignRepository({ getConnection: async () => connection } as unknown as Pool);
  const campaign = { campaignId: 123, campaignName: "test", senderDetails: { name: "Jane", email: "jane@example.com",
    phone: "555", company: "Example", role: "", website: "", country: "" }, messageToSend: "hello", preventResend: true };
  const claim = await repository.claimWebsite(campaign, 4, "api-run", { runNumber: 7, websiteIdUpperBound: 50 });
  assert.equal(claim.action, "run");
  const insert = statements.find(([sql]) => sql.startsWith("INSERT"))!;
  assert.match(insert[0], /website_id, run_number/); assert.deepEqual(insert[1], [4, 7]);
  statements.length = 0;
  assert.equal((await repository.claimWebsite(campaign, 51, "api-run", { runNumber: 7, websiteIdUpperBound: 50 })).action, "unavailable");
  assert.equal(statements.some(([sql]) => sql.startsWith("INSERT")), false);
});

test("terminal failure closes only this campaign run's unfinished attempts", async () => {
  const db = campaign_pool([fixture_campaign(7, fixture_run({ state: "running", completedTime: null }))]);
  await new MysqlLaunchRepository(db.pool).finish({ campaignId: 7, runNumber: 1 }, undefined);
  assert.equal(db.rows.get(7)?.run_state, "failed");
  const close = db.calls.find(call => call.sql.includes("outcome_reason = 'RUN_FAILED'"))!;
  assert.deepEqual(close.values, [7, 1]);
  assert.equal(db.rows.get(7)?.current_run?.failureCode, "RUN_FAILED");
});

test("API candidate rules retry only interrupted work from the same run", async () => {
  assert.equal(claim_is_still_eligible([], "api-run", 7), true);
  const interrupted = { execution_status: "run_failed", forms_result: null, run_number: 7, outcome_reason: "WORKER_INTERRUPTED" };
  assert.equal(claim_is_still_eligible([interrupted], "api-run", 7), true);
  assert.equal(claim_is_still_eligible([interrupted], "api-run", 8), false);
  for (const value of [{ ...interrupted, execution_status: "running" }, { ...interrupted, outcome_reason: "ordinary failure" },
    { ...interrupted, execution_status: "timed_out" }, { ...interrupted, execution_status: "finished", forms_result: "partial" }]) {
    assert.equal(claim_is_still_eligible([value], "api-run", 7), false);
  }
  const queries: Array<[string, unknown[] | undefined]> = [];
  const repository = new MysqlDatabaseCampaignRepository({ execute: async (sql: string, values?: unknown[]) => {
    queries.push([sql, values]); return [[]];
  } } as unknown as Pool);
  await repository.snapshotCandidates(123, "api-run", { runNumber: 7, websiteIdUpperBound: 50 });
  assert.match(queries[0]![0], /website.website_id <= \?/);
  assert.deepEqual(queries[0]![1], [123, 50, 7]);
});

test("API runner keeps website failure as a completed result and bypasses age recovery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "contact-us-run-"));
  let completed = 0; let calls = 0;
  const campaign = { campaignId: 123, campaignName: "test", senderDetails: { name: "Jane Doe", email: "jane@example.com",
    phone: "555", company: "Example", role: "", website: "", country: "" }, messageToSend: "hello", preventResend: true };
  const repository: DatabaseCampaignRepository = {
    loadCampaign: async () => campaign,
    snapshotCandidates: async (_, mode, context) => { assert.equal(mode, "api-run"); assert.equal(context?.websiteIdUpperBound, 50);
      return [{ websiteId: 4, websiteUrl: "http://127.0.0.1" }]; },
    claimWebsite: async (_, __, mode, context) => { assert.equal(mode, "api-run"); assert.equal(context?.runNumber, 7);
      return { action: "run", attemptId: 1, website: { websiteId: 4, websiteUrl: "http://127.0.0.1" } }; },
    completeAttempt: async () => { completed++; }, recoverStaleAttempts: async () => { throw new Error("age recovery called"); }, close: async () => {},
  };
  try {
    const result = await run_database_campaign({ campaignId: 123, runNumber: 7, websiteIdUpperBound: 50, runMode: "production",
      preview: false, confirmed: true, retryUnsuccessful: false, outputRoot: directory }, {
      repository, now: () => new Date(), runCore: async request => {
        calls++; return create_contact_outreach_outcome(create_form_failure_outcome(request.websiteUrl, "fixture", "input.invalid"),
          create_email_failure_outcome(request.websiteUrl, "fixture"), create_meeting_failure_outcome(request.websiteUrl, "fixture"), "RUN_FAILED");
      },
    });
    assert.equal(result.failed, 1); assert.equal(completed, 1); assert.equal(calls, 1);
    const stop = new AbortController();
    await assert.rejects(run_database_campaign({ campaignId: 123, runNumber: 7, websiteIdUpperBound: 50, runMode: "production",
      preview: false, confirmed: true, retryUnsuccessful: false, outputRoot: directory, signal: stop.signal }, {
      repository, now: () => new Date(), runCore: async (_, options) => {
        stop.abort(); assert.equal(options?.signal, stop.signal); options!.signal!.throwIfAborted(); throw new Error("unreachable");
      },
    }));
    assert.equal(completed, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("core cancellation rejects before browser initialization", async () => {
  const stop = new AbortController(); stop.abort();
  await assert.rejects(run_contact_outreach_core({ websiteUrl: "http://127.0.0.1", name: "Jane", email: "jane@example.com",
    phone: "555", company: "Example", message: "hello" }, { signal: stop.signal }));
});

test("core cancellation closes an active browser during navigation", async () => {
  const stop = new AbortController();
  let closed = false;
  const server = createServer(request => {
    request.socket.on("close", () => { closed = true; });
    stop.abort(new Error("fixture cancellation"));
    // Leave navigation pending. Cancellation must close the browser and socket.
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  try {
    await assert.rejects(run_contact_outreach_core({ websiteUrl: `http://127.0.0.1:${address.port}`, name: "Jane",
      email: "jane@example.com", phone: "555", company: "Example", message: "hello" }, { signal: stop.signal, engine: "playwright" }), /fixture cancellation/);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(closed, true);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("heartbeat failure aborts active work and leaves it available for restart", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let entered = false; let finished = false; let released = false;
  const dependencies: WorkerDependencies = {
    acquireLock: async () => ({ signal: new AbortController().signal, check: async () => {}, release: async () => { released = true; } }),
    queue: { next: async () => run(), heartbeat: async () => { throw new Error("database offline"); }, finish: async () => { finished = true; } },
    execute: async (_, signal) => {
      entered = true;
      return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
    },
  };
  const operation = work_once(dependencies, new AbortController().signal);
  while (!entered) await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(5_000);
  await assert.rejects(operation);
  assert.equal(finished, false); assert.equal(released, true);
});
