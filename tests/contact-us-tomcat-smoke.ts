import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createServer as createPortReservation } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, relative, resolve } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { CreateCampaignRequest } from "../src/api/campaign_service.js";
import { MAX_CAMPAIGN_BYTES } from "../src/api/campaign_service.js";
import { create_import_server } from "../src/api/http_server.js";
import { ImportError, type ImportResult } from "../src/api/import_contract.js";

const tomcatHome = process.env.CONTACT_US_TOMCAT_HOME ?? process.env.CATALINA_HOME;
const warPath = process.env.CONTACT_US_TOMCAT_WAR;
const keepArtifacts = process.env.CONTACT_US_TOMCAT_KEEP === "1";

interface Reply extends Partial<ImportResult> {
  error?: { code: string; fields?: Array<{ field: string; code: string }> };
}
const campaignInput: CreateCampaignRequest = {
  campaignName: "Tomcat smoke campaign",
  sender: { firstName: "Jane", lastName: "Doe", email: "jane@example.com",
    companyName: "Example Ltd", phoneNumber: "+1 (555) 123-4567",
    companyWebsiteUrl: "https://example.org", countryOfOrigin: "Israel", companyIndustry: "Software" },
  outreachMessage: "  Hello שלום 👋\r\n\r\nA full message with preserved spacing.\n  ",
};

test("ContactUs through real Tomcat, JSP, Java and Node with an in-memory database substitute", {
  skip: tomcatHome && warPath ? false : "Set CONTACT_US_TOMCAT_HOME and CONTACT_US_TOMCAT_WAR to run this opt-in test.",
  timeout: 180_000,
}, async t => {
  assert.ok(tomcatHome && warPath);
  const workRoot = resolve(process.env.CONTACT_US_TOMCAT_WORK_DIR ?? join(tmpdir(), "contact-us-smoke"));
  await mkdir(workRoot, { recursive: true });
  const base = await mkdtemp(join(workRoot, "tomcat-"));
  const campaigns = new Map<number, CreateCampaignRequest>();
  const websites = new Map<string, number>();
  let campaignCalls = 0;
  let importCalls = 0;
  let databaseFailure = false;
  let slow = false;
  let releaseSlow: (() => void) | undefined;
  const token = randomBytes(32).toString("hex");
  const api = create_import_server({ save: async (campaignId, entries) => {
    importCalls++;
    if (!campaigns.has(campaignId)) throw new ImportError(404, "CAMPAIGN_NOT_FOUND", "The campaign does not exist.");
    if (entries.some(entry => websites.has(entry.normalizedDomain) && websites.get(entry.normalizedDomain) !== campaignId)) {
      throw new ImportError(409, "DOMAIN_CONFLICT", "A domain belongs to another campaign.");
    }
    let imported = 0;
    for (const entry of entries) {
      if (!websites.has(entry.normalizedDomain)) { websites.set(entry.normalizedDomain, campaignId); imported++; }
    }
    return { imported, alreadyInCampaign: entries.length - imported };
  } }, token, { insertCampaign: async campaign => {
    campaignCalls++;
    if (databaseFailure) throw new Error("fixture-private-database-error");
    if (slow) {
      await new Promise<void>(resolveWait => { releaseSlow = resolveWait; });
      throw new Error("fixture timeout released during cleanup");
    }
    const id = campaigns.size + 1;
    campaigns.set(id, structuredClone(campaign));
    return id;
  } });
  let java: ReturnType<typeof spawn> | undefined;
  let stdout = "";
  let stderr = "";
  let apiClosed = false;
  try {
    await mkdir(join(base, "conf"), { recursive: true });
    for (const directory of ["webapps", "logs", "temp", "work"]) await mkdir(join(base, directory));
    await copyFile(join(tomcatHome, "conf", "web.xml"), join(base, "conf", "web.xml"));
    await copyFile(join(tomcatHome, "conf", "logging.properties"), join(base, "conf", "logging.properties"));
    await writeFile(join(base, "conf", "context.xml"), "<Context/>\n");
    await writeFile(join(base, "conf", "catalina.properties"),
      'common.loader="${catalina.home}/lib","${catalina.home}/lib/*.jar"\nserver.loader=\nshared.loader=\n');
    await copyFile(resolve(warPath), join(base, "webapps", "LSAPI.war"));
    await new Promise<void>(resolveListen => api.listen(0, "127.0.0.1", resolveListen));
    const apiAddress = api.address(); assert.ok(apiAddress && typeof apiAddress !== "string");
    const reservation = createPortReservation();
    await new Promise<void>(resolveListen => reservation.listen(0, "127.0.0.1", resolveListen));
    const tomcatAddress = reservation.address(); assert.ok(tomcatAddress && typeof tomcatAddress !== "string");
    const tomcatPort = tomcatAddress.port;
    await new Promise<void>(resolveClose => reservation.close(() => resolveClose()));
    await writeFile(join(base, "conf", "server.xml"), `<?xml version="1.0" encoding="UTF-8"?>
<Server port="-1"><Service name="Catalina">
  <Connector address="127.0.0.1" port="${tomcatPort}" protocol="HTTP/1.1"
    connectionTimeout="20000" maxPostSize="6291456" maxSwallowSize="6291456" />
  <Engine name="Catalina" defaultHost="localhost"><Host name="localhost" appBase="webapps"
    unpackWARs="true" autoDeploy="false" deployOnStartup="true" /></Engine>
</Service></Server>\n`);
    java = spawn(process.env.JAVA_HOME ? join(process.env.JAVA_HOME, "bin", "java") : "java", [
      `-Dcatalina.home=${resolve(tomcatHome)}`, `-Dcatalina.base=${base}`,
      `-Djava.io.tmpdir=${join(base, "temp")}`,
      `-Djava.util.logging.config.file=${join(base, "conf", "logging.properties")}`,
      "-Djava.util.logging.manager=org.apache.juli.ClassLoaderLogManager",
      "-cp", [join(tomcatHome, "bin", "bootstrap.jar"), join(tomcatHome, "bin", "tomcat-juli.jar")].join(delimiter),
      "org.apache.catalina.startup.Bootstrap", "start",
    ], {
      cwd: base, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CATALINA_HOME: resolve(tomcatHome), CATALINA_BASE: base,
        CONTACT_US_SERVICE_URL: `http://127.0.0.1:${apiAddress.port}`,
        CONTACT_US_SERVICE_TOKEN: token, CONTACT_US_ALLOWED_ORIGINS: "https://frontend.example.test" },
    });
    java.stdout?.on("data", chunk => { stdout += String(chunk); });
    java.stderr?.on("data", chunk => { stderr += String(chunk); });
    let spawnFailure: Error | undefined;
    java.on("error", error => { spawnFailure = error; });
    const endpoint = `http://127.0.0.1:${tomcatPort}/LSAPI/ContactUs.jsp`;
    t.diagnostic(`Tomcat test base: ${base}`);
    const start = Date.now();
    let ready = false;
    while (Date.now() - start < 90_000) {
      if (spawnFailure) throw spawnFailure;
      if (java.exitCode !== null) throw new Error(`Tomcat exited during startup.\n${stderr.slice(-8000)}`);
      let response: Response | undefined;
      try { response = await fetch(endpoint, { signal: AbortSignal.timeout(3000) }); } catch { /* Wait for the connector. */ }
      if (response) {
        const text = await response.text();
        if (response.status === 405) {
          assert.equal((JSON.parse(text) as Reply).error?.code, "METHOD_NOT_ALLOWED"); ready = true; break;
        }
        if (response.status >= 500) throw new Error(`Tomcat JSP startup failed (${response.status}).\n${text.slice(0, 2500)}\n${stderr.slice(-8000)}`);
      }
      await delay(500);
    }
    assert.ok(ready, `Tomcat did not become ready.\n${stderr.slice(-8000)}`);
    const createUrl = endpoint + "?Command=CreateCampaign";
    const json = (body: unknown): RequestInit => ({ method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" }, body: JSON.stringify(body) });
    async function call(url: string, init: RequestInit, status: number): Promise<Reply> {
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(40_000) });
      const text = await response.text();
      assert.equal(response.status, status, text.slice(0, 2000));
      assert.match(response.headers.get("content-type") ?? "", /application\/json/);
      assert.equal(response.headers.get("cache-control"), "no-store");
      return JSON.parse(text) as Reply;
    }
    const upload = (source: string, name = "file") => {
      const form = new FormData(); form.append(name, new Blob([source], { type: "text/csv" }), "websites.csv");
      return { method: "POST", body: form } satisfies RequestInit;
    };
    await t.test("Tomcat compiles the JSP and supports the configured CORS preflight", async () => {
      const response = await fetch(endpoint, { method: "OPTIONS", headers: { Origin: "https://frontend.example.test",
        "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "Content-Type" } });
      assert.equal(response.status, 204);
      assert.equal(response.headers.get("access-control-allow-origin"), "https://frontend.example.test");
    });
    let campaignId = 0;
    await t.test("CreateCampaign returns 201 and preserves all sender fields and the Unicode message", async () => {
      const created = await call(createUrl, json(campaignInput), 201);
      campaignId = created.campaignId!; assert.ok(campaignId > 0);
      assert.deepEqual(campaigns.get(campaignId), campaignInput);
    });
    await t.test("invalid campaign fields and malformed JSON produce 400 without a repository call", async () => {
      const before = campaignCalls;
      const invalid = await call(createUrl, json({ ...campaignInput, sender: { ...campaignInput.sender, email: "invalid" } }), 400);
      assert.equal(invalid.error?.code, "INVALID_CAMPAIGN");
      assert.deepEqual(invalid.error?.fields, [{ field: "sender.email", code: "INVALID_EMAIL" }]);
      assert.equal((await call(createUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" }, 400)).error?.code, "INVALID_REQUEST");
      assert.equal(campaignCalls, before);
    });
    await t.test("wrong media types return 415", async () => {
      assert.equal((await call(createUrl, { method: "POST", headers: { "Content-Type": "text/csv" }, body: "header" }, 415)).error?.code, "UNSUPPORTED_MEDIA_TYPE");
    });
    await t.test("chunked campaign bodies cannot bypass the 256 KiB limit", async () => {
      const before = campaignCalls;
      const response = await new Promise<{ status: number; body: Reply }>((resolveResponse, reject) => {
        const request = httpRequest(createUrl, { method: "POST", headers: { "Content-Type": "application/json" } }, incoming => {
          let body = ""; incoming.setEncoding("utf8"); incoming.on("data", chunk => { body += String(chunk); });
          incoming.on("end", () => {
            try { resolveResponse({ status: incoming.statusCode!, body: JSON.parse(body) as Reply }); }
            catch (error) { reject(error); }
          });
        });
        request.setTimeout(10_000, () => request.destroy(new Error("Chunked request timed out.")));
        request.on("error", reject); request.write(Buffer.alloc(MAX_CAMPAIGN_BYTES, 32)); request.end("x");
      });
      assert.equal(response.status, 413); assert.equal(response.body.error?.code, "REQUEST_TOO_LARGE");
      assert.equal(campaignCalls, before);
    });
    const importUrl = endpoint + `?Command=ImportWebsites&CampaignId=${campaignId}`;
    const csv = "\uFEFFany header\r\nhttps://example.com/contact\r\nhttps://www.example.com/\r\nhttps://example.org/\r\n";
    await t.test("multipart CSV upload imports into the newly created campaign", async () => {
      assert.deepEqual(await call(importUrl, upload(csv), 200),
        { campaignId, received: 3, duplicatesInFile: 1, imported: 2, alreadyInCampaign: 0 });
    });
    await t.test("an invalid CSV row rejects the full file without a repository call", async () => {
      const before = importCalls;
      assert.equal((await call(importUrl, upload("header\nhttps://new.example.net\ngibberish\n"), 400)).error?.code, "INVALID_CSV");
      assert.equal(importCalls, before); assert.equal(websites.size, 2);
    });
    await t.test("repeat uploads skip websites already in the same campaign", async () => {
      const repeated = await call(importUrl, upload(csv), 200);
      assert.equal(repeated.imported, 0); assert.equal(repeated.alreadyInCampaign, 2);
    });
    await t.test("unknown campaigns and domain ownership conflicts map to 404 and 409", async () => {
      assert.equal((await call(endpoint + "?Command=ImportWebsites&CampaignId=999", upload(csv), 404)).error?.code, "CAMPAIGN_NOT_FOUND");
      const second = await call(createUrl, json({ ...campaignInput, campaignName: "Second campaign" }), 201);
      assert.equal((await call(endpoint + `?Command=ImportWebsites&CampaignId=${second.campaignId}`, upload(csv), 409)).error?.code, "DOMAIN_CONFLICT");
    });
    await t.test("wrong multipart file fields are rejected by LSApi", async () => {
      const before = importCalls;
      assert.equal((await call(importUrl, upload(csv, "wrong"), 400)).error?.code, "INVALID_REQUEST");
      assert.equal(importCalls, before);
    });
    await t.test("repository failures return a safe 500", async () => {
      databaseFailure = true;
      try {
        const failed = await call(createUrl, json(campaignInput), 500);
        assert.equal(failed.error?.code, "INTERNAL_ERROR");
        assert.ok(!JSON.stringify(failed).includes("fixture-private"));
      } finally { databaseFailure = false; }
    });
    await t.test("the real 30-second service deadline returns 504 without retrying creation", async () => {
      slow = true; const before = campaignCalls;
      try { assert.equal((await call(createUrl, json(campaignInput), 504)).error?.code, "SERVICE_TIMEOUT"); }
      finally { slow = false; releaseSlow?.(); }
      assert.equal(campaignCalls, before + 1);
    });
    await t.test("a stopped internal service returns 502", async () => {
      api.closeAllConnections(); await new Promise<void>(resolveClose => api.close(() => resolveClose())); apiClosed = true;
      assert.equal((await call(createUrl, json(campaignInput), 502)).error?.code, "SERVICE_UNAVAILABLE");
    });
  } finally {
    releaseSlow?.();
    if (java && java.exitCode === null && java.pid !== undefined) {
      const exited = once(java, "close"); java.kill();
      await Promise.race([exited, delay(5000)]);
      if (java.exitCode === null) java.kill("SIGKILL");
    }
    if (!apiClosed) {
      api.closeAllConnections(); await new Promise<void>(resolveClose => api.close(() => resolveClose()));
    }
    // The token must not be written into fixture logs or diagnostics.
    await writeFile(join(base, "stdout.log"), stdout.replaceAll(token, "[redacted]"));
    await writeFile(join(base, "stderr.log"), stderr.replaceAll(token, "[redacted]"));
    if (!keepArtifacts) {
      const withinRoot = relative(workRoot, base);
      assert.ok(withinRoot && !withinRoot.startsWith("..") && !isAbsolute(withinRoot));
      await rm(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  }
});
