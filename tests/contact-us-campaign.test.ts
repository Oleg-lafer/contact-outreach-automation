import assert from "node:assert/strict";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import test from "node:test";
import type { Pool } from "mysql2/promise";
import { campaignSenderDetails, CampaignValidationError, createCampaign, MAX_CAMPAIGN_BYTES,
  parseCampaignJson, validateCreateCampaign, type CreateCampaignRequest } from "../src/api/campaign_service.js";
import { ImportError } from "../src/api/import_contract.js";
import { MysqlCampaignRepository } from "../src/api/mysql_campaign_repository.js";
import { create_import_server } from "../src/api/http_server.js";
import { campaign_from_database_row, contact_request_from_database } from
  "../src/contact_outreach_workflow/shared_files_orchestrator/database_campaign_repository_(Integration).js";

function input(): CreateCampaignRequest {
  return { campaignName: " October campaign ",
    sender: { firstName: " Jane ", lastName: " van Doe ", email: "jane@example.com",
      companyName: " Acme Ltd ", phoneNumber: "+1 (555) 123-4567" },
    outreachMessage: "  שלום 👋\r\n\r\nA complete message.\n  " };
}
const errorCode = (status: number, code: string) => (error: unknown) =>
  error instanceof ImportError && error.status === status && error.code === code;

test("campaign validation preserves accepted values and omits empty optional text", () => {
  const request = input();
  request.sender.companyWebsiteUrl = "https://דוגמה.com/about";
  request.sender.countryOfOrigin = " Israel ";
  request.sender.companyIndustry = " Software ";
  assert.deepEqual(validateCreateCampaign(request), request);
  const empty = input();
  empty.sender.companyWebsiteUrl = "  "; empty.sender.countryOfOrigin = ""; empty.sender.companyIndustry = "\t";
  assert.deepEqual(validateCreateCampaign(empty), input());
});

test("required fields and wrong types fail before any database call", async () => {
  let calls = 0;
  const repository = { insertCampaign: async () => { calls++; return 1; } };
  for (const key of ["campaignName", "outreachMessage"] as const) {
    for (const value of [undefined, null, 123, "", " \n "]) {
      const request: Record<string, unknown> = { ...input(), [key]: value };
      await assert.rejects(createCampaign(request, repository), errorCode(400, "INVALID_CAMPAIGN"));
    }
  }
  for (const key of ["firstName", "lastName", "email", "companyName", "phoneNumber"]) {
    for (const value of [undefined, null, false, {}, "", " \n "]) {
      const request = { ...input(), sender: { ...input().sender, [key]: value } };
      await assert.rejects(createCampaign(request, repository), errorCode(400, "INVALID_CAMPAIGN"));
    }
  }
  for (const sender of [undefined, null, [], "sender"]) {
    await assert.rejects(createCampaign({ ...input(), sender }, repository), errorCode(400, "INVALID_CAMPAIGN"));
  }
  assert.equal(calls, 0);
});

test("optional types, email, websites and unknown fields are rejected safely", () => {
  for (const key of ["companyWebsiteUrl", "countryOfOrigin", "companyIndustry"]) {
    for (const value of [null, 123, false, [], {}]) {
      assert.throws(() => validateCreateCampaign({ ...input(), sender: { ...input().sender, [key]: value } }),
        errorCode(400, "INVALID_CAMPAIGN"));
    }
  }
  for (const [key, value, code] of [
    ["email", "secret-invalid-email", "INVALID_EMAIL"],
    ["companyWebsiteUrl", "ftp://example.com", "INVALID_URL"],
    ["companyWebsiteUrl", "https://user:pass@example.com", "INVALID_URL"],
    ["companyWebsiteUrl", "https://bad_label.com", "INVALID_URL"],
    ["companyWebsiteUrl", "https:///example.com", "INVALID_URL"],
  ]) {
    assert.throws(() => validateCreateCampaign({ ...input(), sender: { ...input().sender, [key!]: value } }), (error: unknown) => {
      assert.ok(error instanceof CampaignValidationError);
      assert.deepEqual(error.fields, [{ field: `sender.${key}`, code }]);
      assert.ok(!JSON.stringify(error.toJSON()).includes("secret")); return true;
    });
  }
  for (const request of [{ ...input(), "secret-arbitrary-field": "secret" },
    { ...input(), sender: { ...input().sender, "secret-arbitrary-field": "secret" } }]) {
    assert.throws(() => validateCreateCampaign(request), (error: unknown) => {
      assert.ok(error instanceof CampaignValidationError);
      assert.equal(error.fields[0]?.code, "UNKNOWN_FIELD");
      assert.ok(!JSON.stringify(error.toJSON()).includes("secret")); return true;
    });
  }
});

test("JSON, Unicode, campaign name and UTF-8 message byte limits are enforced", () => {
  for (const value of [null, [], "string", 1]) assert.throws(() => validateCreateCampaign(value), errorCode(400, "INVALID_REQUEST"));
  for (const value of ["{", "", "{} trailing", '{"message":NaN}']) {
    assert.throws(() => parseCampaignJson(Buffer.from(value)), errorCode(400, "INVALID_REQUEST"));
  }
  assert.throws(() => parseCampaignJson(Buffer.from([0xff])), errorCode(400, "INVALID_REQUEST"));
  assert.throws(() => parseCampaignJson(Buffer.alloc(MAX_CAMPAIGN_BYTES + 1)), errorCode(413, "REQUEST_TOO_LARGE"));
  for (const bad of ["\ud800", "\udc00", "test\ud800x"]) {
    assert.throws(() => validateCreateCampaign({ ...input(), outreachMessage: bad }), errorCode(400, "INVALID_CAMPAIGN"));
    assert.throws(() => validateCreateCampaign({ ...input(), sender: { ...input().sender, companyIndustry: bad } }), errorCode(400, "INVALID_CAMPAIGN"));
  }
  const request = input();
  request.campaignName = "😀".repeat(255);
  request.outreachMessage = "😀".repeat(16383) + "abc";
  assert.equal(Buffer.byteLength(validateCreateCampaign(request).outreachMessage), 65535);
  assert.throws(() => validateCreateCampaign({ ...request, outreachMessage: request.outreachMessage + "x" }), errorCode(400, "INVALID_CAMPAIGN"));
  assert.throws(() => validateCreateCampaign({ ...request, campaignName: request.campaignName + "x" }), errorCode(400, "INVALID_CAMPAIGN"));
  assert.throws(() => validateCreateCampaign(parseCampaignJson(Buffer.from('{"campaignName":"\\ud800"}'))), errorCode(400, "INVALID_CAMPAIGN"));
});

function database(options: { id?: unknown; failInsert?: boolean; failCommit?: boolean; failRollback?: boolean } = {}) {
  const calls: string[] = [];
  let values: unknown[] = [];
  const connection = {
    beginTransaction: async () => { calls.push("begin"); },
    execute: async (sql: string, parameters: unknown[]) => {
      calls.push(sql); values = parameters;
      if (options.failInsert) throw new Error("secret SQL error");
      return [{ insertId: options.id === undefined ? 123 : options.id }];
    },
    commit: async () => { calls.push("commit"); if (options.failCommit) throw new Error("secret commit"); },
    rollback: async () => { calls.push("rollback"); if (options.failRollback) throw new Error("secret rollback"); },
    release: () => { calls.push("release"); },
    destroy: () => { calls.push("destroy"); },
  };
  const pool = { getConnection: async () => connection } as unknown as Pick<Pool, "getConnection">;
  return { repository: new MysqlCampaignRepository(pool), calls, values: () => values };
}

test("campaign insert commits one row with the exact sender mapping and message", async () => {
  const request = input(); request.sender.companyIndustry = "Software";
  const db = database({ id: "123" });
  assert.deepEqual(await createCampaign(request, db.repository), { campaignId: 123 });
  assert.deepEqual(db.calls, ["begin",
    "INSERT INTO OUTREACH_campaigns (campaign_name, sender_details, message_to_send)\n         VALUES (?, ?, ?)", "commit", "release"]);
  const [name, sender, message] = db.values();
  assert.equal(name, request.campaignName);
  assert.equal(message, request.outreachMessage);
  assert.deepEqual(JSON.parse(sender as string), {
    firstName: " Jane ", lastName: " van Doe ", name: "Jane van Doe", email: "jane@example.com",
    company: " Acme Ltd ", phone: "+1 (555) 123-4567", website: "", country: "", industry: "Software",
  });
  assert.equal("role" in campaignSenderDetails(request), false);
  assert.equal("industry" in campaignSenderDetails(input()), false);
  assert.ok(db.calls.every(call => !/OUTREACH_websites|OUTREACH_attempts|UPDATE|DELETE/.test(call)));
});

test("insert, commit and generated ID failures roll back before returning a safe error", async () => {
  for (const options of [{ failInsert: true }, { failCommit: true },
    ...[0, -1, null, "not-an-id", "9007199254740992", 9007199254740992, "18446744073709551617"].map(id => ({ id }))]) {
    const db = database(options);
    await assert.rejects(createCampaign(input(), db.repository), (error: unknown) => {
      assert.ok(error instanceof ImportError); assert.equal(error.status, 500);
      assert.equal(error.code, "DATABASE_ERROR"); assert.ok(!JSON.stringify(error.toJSON()).includes("secret")); return true;
    });
    assert.equal(db.calls.at(-2), "rollback"); assert.equal(db.calls.at(-1), "release");
    if (!("failCommit" in options)) assert.ok(!db.calls.includes("commit"));
  }
  const db = database({ failInsert: true, failRollback: true });
  await assert.rejects(createCampaign(input(), db.repository), errorCode(500, "DATABASE_ERROR"));
  assert.equal(db.calls.at(-1), "destroy"); assert.ok(!db.calls.includes("release"));
  const unavailable = new MysqlCampaignRepository({ getConnection: async () => {
    throw new Error("secret connection details");
  } } as unknown as Pick<Pool, "getConnection">);
  await assert.rejects(createCampaign(input(), unavailable), (error: unknown) => {
    assert.ok(error instanceof ImportError); assert.equal(error.code, "DATABASE_ERROR");
    assert.ok(!JSON.stringify(error.toJSON()).includes("secret")); return true;
  });
});

test("new and legacy campaigns load; empty optional run fields and metadata are omitted", () => {
  const request = input(); request.sender.companyIndustry = "Software";
  const campaign = campaign_from_database_row({ campaign_id: 123, campaign_name: request.campaignName,
    sender_details: JSON.stringify(campaignSenderDetails(request)), message_to_send: request.outreachMessage, prevent_resend: 1 });
  assert.equal(campaign.senderDetails.firstName, request.sender.firstName);
  assert.equal(campaign.senderDetails.lastName, request.sender.lastName);
  assert.equal(campaign.senderDetails.industry, "Software");
  assert.equal(campaign.messageToSend, request.outreachMessage);
  assert.equal(campaign.senderDetails.role, "");
  const run = contact_request_from_database(campaign, { websiteId: 2, websiteUrl: "https://target.example.com" });
  assert.equal(run.name, "Jane van Doe"); assert.equal(run.message, request.outreachMessage);
  assert.equal(run.company, request.sender.companyName);
  assert.equal(run.phone, request.sender.phoneNumber);
  assert.equal(run.email, request.sender.email);
  for (const field of ["role", "website", "country", "industry", "firstName", "lastName"]) assert.equal(field in run, false);
  const legacy = campaign_from_database_row({ campaign_id: 1, campaign_name: "Legacy", message_to_send: " Message ",
    sender_details: { name: "Legacy Sender", email: "legacy@example.com", phone: "+1", company: "Acme",
      role: "CEO", website: "example.com", country: "USA" }, prevent_resend: 1 });
  assert.equal(contact_request_from_database(legacy, { websiteId: 2, websiteUrl: "https://target.example.com" }).role, "CEO");
  assert.equal(legacy.messageToSend, " Message ");
  const minimalSender = { name: "Jane Doe", email: "jane@example.com", company: "Acme", phone: "+1" };
  const minimal = campaign_from_database_row({ campaign_id: 2, campaign_name: "Minimal", message_to_send: "Message",
    sender_details: minimalSender, prevent_resend: 1 });
  const minimalRun = contact_request_from_database(minimal, { websiteId: 2, websiteUrl: "https://target.example.com" });
  assert.equal("industry" in minimal.senderDetails, false);
  for (const field of ["role", "website", "country"]) assert.equal(field in minimalRun, false);
  for (const field of ["name", "email", "company", "phone"]) {
    const incomplete: Record<string, unknown> = { ...minimalSender }; delete incomplete[field];
    assert.throws(() => campaign_from_database_row({ campaign_id: 3, campaign_name: "Invalid", message_to_send: "Message",
      sender_details: incomplete, prevent_resend: 1 }));
  }
});

test("internal campaign HTTP contract, limits and create-then-import sequence", async () => {
  const saved: CreateCampaignRequest[] = [];
  const imported: number[] = [];
  const server = create_import_server({ save: async (id, entries) => {
    imported.push(id); return { imported: entries.length, alreadyInCampaign: 0 };
  } }, "test-token", { insertCampaign: async campaign => { saved.push(campaign); return 321; } });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/internal/contact-us/campaigns`;
  const headers = { Authorization: "Bearer test-token", "Content-Type": "application/json; charset=utf-8" };
  try {
    for (const [body, requestHeaders, status] of [
      [JSON.stringify(input()), {}, 401], ["{}", headers, 400], ["{", headers, 400],
      [JSON.stringify(input()), { ...headers, "Content-Type": "text/csv" }, 415],
      [JSON.stringify(input()), { ...headers, "Content-Type": "application/json; charset=latin1" }, 415],
      [" ".repeat(MAX_CAMPAIGN_BYTES + 1), headers, 413],
    ] as const) {
      const response = await fetch(url, { method: "POST", headers: requestHeaders, body });
      assert.equal(response.status, status); assert.ok((await response.json()).error.code);
    }
    const malformed = await fetch(url, { method: "POST", headers, body: Buffer.from([0xff]) });
    assert.equal(malformed.status, 400); await malformed.arrayBuffer();
    const get = await fetch(url, { headers }); assert.equal(get.status, 405); await get.arrayBuffer();
    assert.equal(saved.length, 0);
    const created = await fetch(url, { method: "POST", headers, body: JSON.stringify(input()) });
    assert.equal(created.status, 201); assert.equal(created.headers.get("cache-control"), "no-store");
    assert.deepEqual(await created.json(), { campaignId: 321 }); assert.deepEqual(saved, [input()]);
    const importedResponse = await fetch(url + "/321/websites/import", { method: "POST",
      headers: { ...headers, "Content-Type": "text/csv" }, body: "header\nhttps://example.com\n" });
    assert.equal(importedResponse.status, 200); assert.equal((await importedResponse.json()).imported, 1);
    assert.deepEqual(imported, [321]);
    const streamedStatus = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(url, { method: "POST", headers }, response => {
        response.resume(); response.on("end", () => resolve(response.statusCode!));
      });
      request.on("error", reject); request.write(Buffer.alloc(MAX_CAMPAIGN_BYTES)); request.end("x");
    });
    assert.equal(streamedStatus, 413); assert.equal(saved.length, 1);
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
