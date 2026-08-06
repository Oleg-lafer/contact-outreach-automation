import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { run_contact_outreach_workflow } from "../src/contact_outreach_workflow/contact_outreach_orchestrator.js";

test("real Stagehand fills one local contact form exactly once", async () => {
  assert.ok(
    process.env.OPENROUTER_MODEL?.trim(),
    "OPENROUTER_MODEL is required for the cost-incurring Stagehand smoke test",
  );

  let post_count = 0;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "POST" && url.pathname === "/submit") {
      post_count += 1;
      request.resume();
      response.writeHead(204).end();
      return;
    }

    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html>
      <html><body>
        <form>
          <h1>Contact our team</h1>
          <label>Email <input type="email" name="email" required></label>
          <label>How can our team assist? <input id="note-for-team" name="note" required></label>
          <button type="submit">Send</button>
        </form>
        <div id="status" role="status"></div>
        <script>
          document.querySelector('form').addEventListener('submit', async (event) => {
            event.preventDefault();
            await fetch('/submit', { method: 'POST', body: new FormData(event.currentTarget) });
            document.querySelector('#status').textContent = 'Thank you. Your message has been received.';
          });
        </script>
      </body></html>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const directory = await mkdtemp(join(tmpdir(), "stagehand-smoke-"));
  const input_path = join(directory, "input.json");
  const output_path = join(directory, "production.txt");
  await writeFile(
    input_path,
    JSON.stringify({
      websiteUrl: `http://127.0.0.1:${address.port}/contact`,
      name: "Stagehand Smoke User",
      email: "stagehand-smoke@example.com",
      phone: "050-0000000",
      message: "Please contact me about this local smoke test.",
    }),
    "utf8",
  );

  try {
    const outcome = await run_contact_outreach_workflow(
      input_path,
      {
        engine: "stagehand",
        runMode: "production",
        outputPath: output_path,
      },
    );

    assert.equal(outcome.status, "SUCCESS", JSON.stringify(outcome));
    assert.equal(post_count, 1, "the local form must be submitted exactly once");
    assert.ok(
      outcome.channels.forms.aiAssistance?.actions.some(
        (action) => action.stage === "population" && action.result === "succeeded",
      ),
      "the smoke fixture must exercise the Stagehand population fallback",
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
});
