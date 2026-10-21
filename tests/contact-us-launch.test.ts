import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { request } from "node:http";
import type { Pool } from "mysql2/promise";
import { launchCampaign, parseLaunchJson, validateLaunchCampaign } from "../src/api/launch_service.js";
import { ImportError } from "../src/api/import_contract.js";
import { MysqlLaunchRepository, requireLaunchSchema } from "../src/api/mysql_launch_repository.js";
import { create_import_server } from "../src/api/http_server.js";
import { campaign_pool, fixture_campaign, fixture_run } from "./contact-us-run-fixtures.js";

const code = (status: number, value: string) => (error: unknown) => error instanceof ImportError && error.status === status && error.code === value;
test("launch defaults to production and rejects invalid input before database access", async () => {
  let calls = 0;
  const repository = { enqueue: async (campaignId: number, runMode: "production" | "deep-debug") => {
    calls++; return { campaignId, runNumber: 7, runMode, status: "queued" as const };
  } };
  assert.equal((await launchCampaign(123, {}, repository)).runMode, "production");
  assert.equal((await launchCampaign(123, { runMode: "deep-debug" }, repository)).runMode, "deep-debug");
  for (const value of [null, [], "", 1, { runMode: null }, { runMode: undefined }, { runMode: "debug" }, { runMode: 1 }, { secret: "x" }]) {
    await assert.rejects(launchCampaign(123, value, repository), code(400, "INVALID_REQUEST"));
  }
  for (const id of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) await assert.rejects(launchCampaign(id, {}, repository));
  assert.equal(calls, 2);
  for (const bytes of [Buffer.from("{"), Buffer.from([0xff]), Buffer.from('{"runMode":"\\ud800"}')]) {
    assert.throws(() => validateLaunchCampaign(parseLaunchJson(bytes)), code(400, "INVALID_REQUEST"));
  }
  assert.throws(() => parseLaunchJson(Buffer.alloc(4097)), code(413, "REQUEST_TOO_LARGE"));
});

test("launch stores its bounded current run and commits before returning", async () => {
  const db = campaign_pool(); const repository = new MysqlLaunchRepository(db.pool);
  assert.deepEqual(await repository.enqueue(123, "production"), { campaignId: 123, runNumber: 1, runMode: "production", status: "queued" });
  assert.equal(db.rows.get(123)?.current_run?.websiteIdUpperBound, 50);
  assert.deepEqual(db.rows.get(123)?.run_history, []);
  assert.equal(db.calls.at(-2)?.sql, "COMMIT");
  assert.equal(db.calls.at(-1)?.sql, "RELEASE");
  assert.equal(db.calls.filter(c => /^(INSERT|UPDATE)/.test(c.sql)).length, 1);
});

test("active launches are idempotent and rejected launches do not change sequence or history", async () => {
  const active = campaign_pool([fixture_campaign(123, fixture_run({ state: "running", completedTime: null }))]);
  const repository = new MysqlLaunchRepository(active.pool);
  assert.equal((await repository.enqueue(123, "production")).runNumber, 1);
  await assert.rejects(repository.enqueue(123, "deep-debug"), code(409, "RUN_MODE_CONFLICT"));
  assert.equal(active.calls.some(c => c.sql.startsWith("UPDATE")), false);
  for (const db of [campaign_pool([], {}), campaign_pool([fixture_campaign(123, fixture_run())], { eligible: 0 })]) {
    const previous = structuredClone([...db.rows]);
    await assert.rejects(new MysqlLaunchRepository(db.pool).enqueue(123, "production"));
    assert.deepEqual([...db.rows], previous);
  }
});

test("campaign run sequences are independent and history is archived once", async () => {
  const db = campaign_pool([fixture_campaign(123, fixture_run()), fixture_campaign(456)]);
  const repository = new MysqlLaunchRepository(db.pool);
  const [first, duplicate] = await Promise.all([repository.enqueue(123, "production"), repository.enqueue(123, "production")]);
  assert.equal(first.runNumber, 2); assert.deepEqual(first, duplicate);
  assert.deepEqual(db.rows.get(123)?.run_history, [fixture_run()]);
  assert.equal((await repository.enqueue(456, "production")).runNumber, 1);
  assert.equal(db.rows.get(123)?.run_sequence, 2);
  assert.equal(db.rows.get(456)?.run_sequence, 1);
});

test("SQL, commit and unsafe sequence failures roll back; failed rollback discards connection", async () => {
  for (const options of [{ failUpdate: true }, { failCommit: true }, { failUpdate: true, rollbackFailure: true }]) {
    const db = campaign_pool([fixture_campaign()], options);
    await assert.rejects(new MysqlLaunchRepository(db.pool).enqueue(123, "production"), code(500, "DATABASE_ERROR"));
    assert.equal(db.rows.get(123)?.run_sequence, 0);
    assert.ok(db.calls.some(c => c.sql === "ROLLBACK"));
    assert.equal(db.calls.at(-1)?.sql, options.rollbackFailure ? "DESTROY" : "RELEASE");
  }
  const row = fixture_campaign(123, fixture_run({ runNumber: Number.MAX_SAFE_INTEGER }));
  await assert.rejects(new MysqlLaunchRepository(campaign_pool([row]).pool).enqueue(123, "production"), code(500, "DATABASE_ERROR"));
  const db = campaign_pool([], { schemaMissing: true });
  await assert.rejects(new MysqlLaunchRepository(db.pool).enqueue(123, "production"), code(503, "SERVICE_UNAVAILABLE"));
  assert.equal(db.calls.length, 0);
  await assert.rejects(requireLaunchSchema({ query: async () => { throw new Error("secret connection"); } } as unknown as Pool), code(500, "DATABASE_ERROR"));
});

test("internal launch HTTP route checks token, method, media, streamed limits and valid JSON", async () => {
  let calls = 0;
  const server = create_import_server({ save: async () => { throw new Error("import called"); } }, "test-token", undefined,
    { enqueue: async (campaignId, runMode) => { calls++; return { campaignId, runNumber: 7, runMode, status: "queued" }; } });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/internal/contact-us/campaigns/123/runs`;
  const headers = { Authorization: "Bearer test-token", "Content-Type": "application/json" };
  try {
    const success = await fetch(url, { method: "POST", headers, body: "{}" });
    assert.equal(success.status, 202); assert.equal((await success.json()).runMode, "production");
    for (const [init, status] of [
      [{ method: "POST", body: "{}" }, 401], [{ method: "GET", headers }, 405],
      [{ method: "POST", headers: { ...headers, "Content-Type": "text/plain" }, body: "{}" }, 415],
      [{ method: "POST", headers: { ...headers, "Content-Encoding": "gzip" }, body: "{}" }, 415],
      [{ method: "POST", headers, body: "{" }, 400], [{ method: "POST", headers, body: "null" }, 400],
      [{ method: "POST", headers, body: " ".repeat(4097) }, 413],
    ] as const) assert.equal((await fetch(url, init)).status, status);
    const streamed = await new Promise<number>(resolve => {
      const outgoing = request(url, { method: "POST", headers }, response => { response.resume(); response.on("end", () => resolve(response.statusCode!)); });
      outgoing.write(" ".repeat(2500)); outgoing.end(" ".repeat(2500));
    });
    assert.equal(streamed, 413); assert.equal(calls, 1);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
