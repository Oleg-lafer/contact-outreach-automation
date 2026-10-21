import assert from "node:assert/strict";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import test from "node:test";
import type { Pool } from "mysql2/promise";
import { import_websites, validate_csv, type WebsiteImportRepository } from "../src/api/csv_import_service.js";
import { create_import_server } from "../src/api/http_server.js";
import { ImportError, MAX_CSV_BYTES, parse_campaign_id } from "../src/api/import_contract.js";
import { MysqlWebsiteImportRepository } from "../src/api/mysql_import_repository.js";

const bytes = (text: string) => Buffer.from(text);
const csv = "any header\nhttps://example.com/contact\n";
const repository: WebsiteImportRepository = {
  save: async (_id, entries) => ({ imported: entries.length, alreadyInCampaign: 0 }),
};
function hasError(status: number, code: string) {
  return (error: unknown) => error instanceof ImportError && error.status === status && error.code === code;
}

test("CSV accepts arbitrary headers, BOM, quoted fields, blanks and line endings", () => {
  for (const ending of ["\n", "\r\n"]) {
    const parsed = validate_csv(bytes(["\uFEFFtyppo", '" https://WWW.Example.co.uk/contact "', "",
      '"https://other.net/path?a=1,b=2"', "https://contact.example.co.uk/", ""].join(ending)));
    assert.equal(parsed.received, 3);
    assert.equal(parsed.duplicatesInFile, 1);
    assert.equal(parsed.entries.length, 2);
    assert.equal(parsed.entries[0]?.normalizedDomain, "example.co.uk");
    assert.equal(parsed.entries[0]?.originalInputUrl, "https://WWW.Example.co.uk/contact");
  }
});

test("header is always a header, with no URL guessing", () => {
  assert.throws(() => validate_csv(bytes("https://example.com\n")), hasError(400, "INVALID_CSV"));
});

test("invalid rows are reported before the repository is called", async () => {
  let calls = 0;
  await assert.rejects(import_websites(1, bytes("header\nhttps://good.net\ngibberish\nhttps://other.org\n"), {
    save: async () => { calls++; return { imported: 0, alreadyInCampaign: 0 }; },
  }), (error: unknown) => {
    assert.ok(error instanceof ImportError);
    assert.deepEqual(error.rows, [{ row: 3, code: "INVALID_URL" }]);
    return true;
  });
  assert.equal(calls, 0);
});

test("URL checks reject bad schemes, missing hosts, credentials and control characters", () => {
  for (const value of ["gibberish", "ftp://example.com", "https://", "http:example.com",
    "https:///example.com", "https://a:b@example.com", "https://example.com/\tpath",
    "https://example.com\\path", "https://bad host.com", "https://.", "https://bad_label.com",
    "https://" + "x".repeat(64) + ".com", "https://" + ("x".repeat(60) + ".").repeat(5) + "com",
    "https://example.com/" + "x".repeat(2048)]) {
    assert.throws(() => validate_csv(bytes(`header\n"${value}"\n`)), hasError(400, "INVALID_CSV"), value);
  }
  const idn = validate_csv(bytes("header\nhttps://דוגמה.com/\n"));
  assert.match(idn.entries[0]!.normalizedDomain, /^xn--/);
});

test("row numbers count records including blank records and quoted newlines", () => {
  assert.throws(() => validate_csv(bytes('header\n\n"https://example.com/\npath"\nbad\n')), (error: unknown) => {
    assert.ok(error instanceof ImportError);
    assert.deepEqual(error.rows, [{ row: 3, code: "INVALID_URL" }, { row: 4, code: "INVALID_URL" }]);
    return true;
  });
});

test("malformed CSV, extra columns, missing header, empty data and invalid UTF-8 fail", () => {
  for (const value of ["", "header\n\n", "\nhttps://example.com", "a,b\nhttps://a.com,https://b.com",
    'header\n"https://example.com', "header\nhttps://example.com,extra"]) {
    assert.throws(() => validate_csv(bytes(value)), hasError(400, "INVALID_CSV"));
  }
  assert.throws(() => validate_csv(Buffer.from([0xff, 0xfe])), hasError(400, "INVALID_CSV"));
});

test("byte and non-empty row limits are enforced, including duplicate rows", () => {
  assert.throws(() => validate_csv(Buffer.alloc(MAX_CSV_BYTES + 1)), hasError(413, "UPLOAD_TOO_LARGE"));
  assert.throws(() => validate_csv(bytes("header\n" + "https://example.com\n".repeat(10001))),
    hasError(413, "TOO_MANY_ROWS"));
  assert.equal(validate_csv(bytes("header\n" + "https://example.com\n".repeat(10000))).received, 10000);
});

test("campaign IDs must be positive safe integers", () => {
  for (const value of ["0", "-1", "1.2", "01", "1e3", "9007199254740992", "", "abc"]) {
    assert.throws(() => parse_campaign_id(value), hasError(400, "INVALID_REQUEST"));
  }
  assert.equal(parse_campaign_id("9007199254740991"), Number.MAX_SAFE_INTEGER);
});

function databaseFixture(options: {
  missingCampaign?: boolean;
  existing?: Array<{ normalized_domain: string; campaign_id: number | string }>;
  failInsertAt?: number;
  failCommit?: boolean;
  failRollback?: boolean;
  failureCode?: string;
} = {}) {
  const sql: Array<{ statement: string; values: unknown[] }> = [];
  let commits = 0, rollbacks = 0, releases = 0, inserts = 0, begins = 0;
  let destroys = 0;
  const connection = {
    beginTransaction: async () => { begins++; },
    execute: async (statement: string, values: unknown[]) => {
      sql.push({ statement, values });
      if (statement.includes("FROM OUTREACH_campaigns")) return [options.missingCampaign ? [] : [{ campaign_id: 123 }]];
      if (statement.includes("SELECT normalized_domain")) return [options.existing ?? []];
      if (statement.startsWith("INSERT")) {
        inserts++;
        if (options.failInsertAt === inserts) throw Object.assign(new Error("secret SQL failure"), { code: options.failureCode });
        return [{ affectedRows: values.length / 3 }];
      }
      throw new Error("Unexpected SQL");
    },
    commit: async () => { if (options.failCommit) throw new Error("secret commit"); commits++; },
    rollback: async () => { rollbacks++; if (options.failRollback) throw new Error("rollback unavailable"); },
    destroy: () => { destroys++; },
    release: () => { releases++; },
  };
  const pool = { getConnection: async () => connection } as unknown as Pick<Pool, "getConnection">;
  return { repository: new MysqlWebsiteImportRepository(pool), sql,
    destroyed: () => destroys,
    state: () => ({ commits, rollbacks, releases, inserts, begins }) };
}

test("import commits new websites, skips existing domains and keeps the first supplied URL", async () => {
  const db = databaseFixture({ existing: [{ normalized_domain: "existing.net", campaign_id: "123" }] });
  const result = await import_websites(123, bytes("header\nhttps://example.com/first\nhttps://www.example.com/second\nhttps://existing.net\n"), db.repository);
  assert.deepEqual(result, { campaignId: 123, received: 3, duplicatesInFile: 1, imported: 1, alreadyInCampaign: 1 });
  assert.deepEqual(db.sql.find(call => call.statement.startsWith("INSERT"))?.values,
    [123, "example.com", "https://example.com/first"]);
  assert.deepEqual(db.state(), { commits: 1, rollbacks: 0, releases: 1, inserts: 1, begins: 1 });
  assert.ok(db.sql.every(call => !/OUTREACH_attempts|DELETE|UPDATE|browser/i.test(call.statement.replaceAll("FOR UPDATE", ""))));
});

test("all-existing upload commits with zero inserts", async () => {
  const db = databaseFixture({ existing: [{ normalized_domain: "example.com", campaign_id: 123 }] });
  assert.equal((await import_websites(123, bytes(csv), db.repository)).imported, 0);
  assert.equal(db.state().inserts, 0);
  assert.equal(db.state().commits, 1);
});

test("missing campaign and cross-campaign conflicts roll back before inserts", async () => {
  for (const [db, status, code] of [
    [databaseFixture({ missingCampaign: true }), 404, "CAMPAIGN_NOT_FOUND"],
    [databaseFixture({ existing: [{ normalized_domain: "example.com", campaign_id: 456 }] }), 409, "DOMAIN_CONFLICT"],
  ] as const) {
    await assert.rejects(import_websites(123, bytes(csv), db.repository), hasError(status, code));
    assert.equal(db.state().inserts, 0);
    assert.equal(db.state().rollbacks, 1);
    assert.equal(db.state().releases, 1);
  }
});

test("insert errors, concurrent uniqueness and commit errors never report success", async () => {
  for (const code of ["ER_DUP_ENTRY", "ER_LOCK_DEADLOCK", "ER_LOCK_WAIT_TIMEOUT", "ER_UNKNOWN_ERROR"]) {
    const db = databaseFixture({ failInsertAt: 1, failureCode: code });
    await assert.rejects(import_websites(123, bytes(csv), db.repository),
      hasError(code === "ER_UNKNOWN_ERROR" ? 500 : 409, code === "ER_UNKNOWN_ERROR" ? "DATABASE_ERROR" : "IMPORT_CONFLICT"));
    assert.equal(db.state().commits, 0);
    assert.equal(db.state().rollbacks, 1);
    assert.equal(db.state().releases, 1);
  }
  const db = databaseFixture({ failCommit: true });
  await assert.rejects(import_websites(123, bytes(csv), db.repository), hasError(500, "DATABASE_ERROR"));
  assert.equal(db.state().rollbacks, 1);
});

test("failure in a later insert batch rolls back the complete import", async () => {
  const db = databaseFixture({ failInsertAt: 2 });
  const source = "header\n" + Array.from({ length: 251 }, (_, i) => `https://site${i}.com`).join("\n");
  await assert.rejects(import_websites(123, bytes(source), db.repository), hasError(500, "DATABASE_ERROR"));
  assert.equal(db.state().inserts, 2);
  assert.equal(db.state().rollbacks, 1);
  assert.equal(db.state().commits, 0);
});

test("failed rollback discards the connection instead of returning it to the pool", async () => {
  const db = databaseFixture({ failInsertAt: 1, failRollback: true });
  await assert.rejects(import_websites(123, bytes(csv), db.repository), hasError(500, "DATABASE_ERROR"));
  assert.equal(db.destroyed(), 1);
  assert.equal(db.state().releases, 0);
  assert.equal(db.state().commits, 0);
});

async function withServer(run: (url: string) => Promise<void>, repo = repository) {
  const server = create_import_server(repo, "test-token");
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try { await run(`http://127.0.0.1:${address.port}`); }
  finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}
const path = "/internal/contact-us/campaigns/123/websites/import";
const headers = { Authorization: "Bearer test-token", "Content-Type": "text/csv; charset=utf-8" };

test("HTTP requires a token and maps routes, media types and validation errors", async () => {
  for (const token of ["", "has spaces", "non-ascii-א", "control\n"]) {
    assert.throws(() => create_import_server(repository, token));
  }
  await withServer(async url => {
    for (const [suffix, method, requestHeaders, body, status] of [
      [path, "POST", {}, csv, 401],
      [path, "POST", { ...headers, Authorization: "Bearer incorrect" }, csv, 401],
      ["/missing", "POST", headers, csv, 404],
      [path, "GET", headers, undefined, 405],
      [path, "POST", { ...headers, "Content-Type": "application/json" }, csv, 415],
      [path, "POST", { ...headers, "Content-Type": "text/csv; charset=latin1" }, csv, 415],
      [path.replace("123", "0"), "POST", headers, csv, 400],
      [path, "POST", headers, "header\nbad", 400],
      [path, "POST", headers, csv, 200],
      [path, "POST", headers, "x".repeat(MAX_CSV_BYTES + 1), 413],
    ] as const) {
      const response = await fetch(url + suffix, { method, headers: requestHeaders, ...(body === undefined ? {} : { body }) });
      assert.equal(response.status, status, `${method} ${suffix}`);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.match(response.headers.get("content-type")!, /application\/json/);
      const result = await response.json();
      if (status === 200) assert.equal(result.imported, 1);
      else assert.ok(result.error.code);
    }
  });
});

test("chunked HTTP uploads cannot bypass the byte limit", async () => {
  await withServer(async url => {
    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(url + path, { method: "POST", headers }, response => {
        response.resume(); response.on("end", () => resolve(response.statusCode!));
      });
      request.on("error", reject);
      request.write(Buffer.alloc(MAX_CSV_BYTES));
      request.end("x");
    });
    assert.equal(status, 413);
  });
});

test("HTTP hides raw repository errors", async () => {
  await withServer(async url => {
    const response = await fetch(url + path, { method: "POST", headers, body: csv });
    assert.equal(response.status, 500);
    assert.ok(!(await response.text()).includes("secret"));
  }, { save: async () => { throw new Error("secret database password"); } });
});
