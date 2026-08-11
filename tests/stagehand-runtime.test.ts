import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  summarize_ai_assistance,
  write_ai_assistance_artifact,
} from "../src/contact_outreach_workflow/shared_files_orchestrator/ai_observability_(Support).js";
import {
  create_stagehand_runtime,
  load_stagehand_configuration,
  OpenRouterUsageTracker,
} from "../src/contact_outreach_workflow/shared_files_orchestrator/stagehand_client_(LLM).js";
import {
  open_target_website,
  resolve_automation_engine,
} from "../src/contact_outreach_workflow/orchestrator/B_browser/B_browser_session_(Integration).js";
import {
  create_contact_outreach_outcome,
  format_contact_outreach_outcome,
} from "../src/contact_outreach_workflow/orchestrator/E_aggregate_reporting/E_aggregate_reporting_(Support).js";
import { create_email_failure_outcome } from "../src/contact_outreach_workflow/contact_channels/emails/pipeline/E_reporting/E1_email_reporting_(Support).js";
import { create_meeting_failure_outcome } from "../src/contact_outreach_workflow/contact_channels/meetings/pipeline/C_reporting/C1_meeting_reporting_(Support).js";
import type { FormChannelOutcome } from "../src/contact_outreach_workflow/contact_channels/forms/shared_files_forms/forms_types_(Support).js";

function format_form_outcome(outcome: FormChannelOutcome): string {
  return format_contact_outreach_outcome(
    create_contact_outreach_outcome(
      outcome,
      create_email_failure_outcome(
        outcome.websiteUrl,
        "Email discovery was not run in this form-report unit test.",
      ),
      create_meeting_failure_outcome(
        outcome.websiteUrl,
        "Meeting discovery was not run in this form-report unit test.",
      ),
    ),
  );
}

test("automation engine defaults to Playwright and honors explicit precedence", () => {
  assert.equal(resolve_automation_engine(undefined, {}), "playwright");
  assert.equal(
    resolve_automation_engine(undefined, { CONTACT_FORM_ENGINE: "stagehand" }),
    "stagehand",
  );
  assert.equal(
    resolve_automation_engine("playwright", {
      CONTACT_FORM_ENGINE: "stagehand",
    }),
    "playwright",
  );
  assert.throws(
    () => resolve_automation_engine(undefined, { CONTACT_FORM_ENGINE: "other" }),
    /Expected "playwright" or "stagehand"/,
  );
});

test("Stagehand mode keeps deterministic browsing independent of AI configuration", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<main>deterministic page</main>");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");

  let session;
  try {
    session = await open_target_website(
      {
        websiteUrl: `http://127.0.0.1:${address.port}`,
        name: "Test Person",
        email: "test@example.com",
        phone: "+1 555 0100",
        message: "Test message",
      },
      { engine: "stagehand", environment: {} },
    );
    assert.equal(await session.page.locator("main").innerText(), "deterministic page");
    assert.equal(session.pageIntelligence, undefined);
    assert.equal(
      typeof Object.getOwnPropertyDescriptor(session, "pageIntelligence")?.get,
      "function",
    );
  } finally {
    await session?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("Stagehand configuration reads one raw external token", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stagehand-config-"));
  const key_path = join(directory, ".env");
  const fake_key = "sk-or-v1-test-token-that-is-never-used";

  try {
    await writeFile(key_path, `${fake_key}\n`, "utf8");
    const configuration = await load_stagehand_configuration({
      OPENROUTER_MODEL: "provider/structured-model",
      OPENROUTER_API_KEY_FILE: key_path,
    });

    assert.equal(configuration.apiKey, fake_key);
    assert.equal(configuration.apiKeyFile, key_path);
    assert.equal(configuration.model, "provider/structured-model");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Stagehand configuration rejects missing model and dotenv assignments", async () => {
  await assert.rejects(
    load_stagehand_configuration({}),
    /OPENROUTER_MODEL is required/,
  );

  const directory = await mkdtemp(join(tmpdir(), "stagehand-invalid-config-"));
  const key_path = join(directory, ".env");
  try {
    await writeFile(key_path, "OPENROUTER_API_KEY=secret-value\n", "utf8");
    await assert.rejects(
      load_stagehand_configuration({
        OPENROUTER_MODEL: "provider/structured-model",
        OPENROUTER_API_KEY_FILE: key_path,
      }),
      (error: unknown) => {
        assert.match(String(error), /must contain one non-empty raw token/);
        assert.doesNotMatch(String(error), /secret-value/);
        return true;
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Stagehand configuration rejects invalid models, missing keys, and empty keys", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stagehand-bad-config-"));
  const missing_key_path = join(directory, "missing.env");
  const empty_key_path = join(directory, "empty.env");
  try {
    await writeFile(empty_key_path, "  \n", "utf8");
    await assert.rejects(
      load_stagehand_configuration({
        OPENROUTER_MODEL: "not-a-provider-model",
        OPENROUTER_API_KEY_FILE: empty_key_path,
      }),
      /valid OpenRouter model identifier/,
    );
    await assert.rejects(
      load_stagehand_configuration({
        OPENROUTER_MODEL: "provider/model",
        OPENROUTER_API_KEY_FILE: missing_key_path,
      }),
      /Could not read the OpenRouter API key file/,
    );
    await assert.rejects(
      load_stagehand_configuration({
        OPENROUTER_MODEL: "provider/model",
        OPENROUTER_API_KEY_FILE: empty_key_path,
      }),
      /must contain one non-empty raw token/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Stagehand rejects ambient flow-log sinks before browser launch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stagehand-log-config-"));
  const key_path = join(directory, ".env");
  try {
    await writeFile(key_path, "sk-or-v1-test-token\n", "utf8");
    await assert.rejects(
      create_stagehand_runtime({
        cdpUrl: "ws://127.0.0.1:1/devtools/browser/not-used",
        environment: {
          OPENROUTER_MODEL: "provider/model",
          OPENROUTER_API_KEY_FILE: key_path,
          BROWSERBASE_CONFIG_DIR: join(directory, "unsafe-flow-logs"),
        },
      }),
      /Stagehand flow logging must be disabled/,
    );
    await assert.rejects(
      create_stagehand_runtime({
        cdpUrl: "ws://127.0.0.1:1/devtools/browser/not-used",
        environment: {
          OPENROUTER_MODEL: "provider/model",
          OPENROUTER_API_KEY_FILE: key_path,
          BROWSERBASE_FLOW_LOGS: "1",
        },
      }),
      /Stagehand flow logging must be disabled/,
    );
    await assert.rejects(
      create_stagehand_runtime({
        cdpUrl: "ws://127.0.0.1:1/devtools/browser/not-used",
        environment: {
          OPENROUTER_MODEL: "provider/model",
          OPENROUTER_API_KEY_FILE: key_path,
          BROWSERBASE_CONFIG_DIR: "   ",
        },
      }),
      /Stagehand flow logging must be disabled/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("AI action artifacts preserve placeholders and redact contact values", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stagehand-artifact-"));
  const sensitive_value = "private@example.com";
  try {
    const summary = summarize_ai_assistance([
      {
        stage: "population",
        placeholderInstruction: `fill %email%, never ${sensitive_value}`,
        selector: "input[type=email]",
        method: `fill-${sensitive_value}`,
        acceptance: "accepted",
        acceptanceReason: "approved contact variable",
        result: "succeeded",
        resultMessage: `filled ${sensitive_value}`,
        model: `provider/${sensitive_value}`,
        durationMs: 12,
      },
    ]);
    const persisted = await write_ai_assistance_artifact(summary, directory, [
      sensitive_value,
    ]);

    assert.equal(persisted?.actionCount, 1);
    assert.equal(persisted?.acceptedActionCount, 1);
    const artifact_text = await readFile(join(directory, "ai-actions.json"), "utf8");
    assert.doesNotMatch(artifact_text, /private@example\.com/);
    assert.match(artifact_text, /%email%/);
    assert.match(artifact_text, /\[redacted contact value\]/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("AI reporting appends telemetry without changing status and reason lines", () => {
  const report = format_form_outcome({
    websiteUrl: "https://example.test/contact",
    contactPageFound: true,
    formFound: true,
    populatedFields: ["email", "message"],
    submissionAttempted: true,
    submissionConfirmed: false,
    status: "PARTIAL",
    reason: "submission was attempted, but no explicit confirmation appeared",
    failureKind: "submission.unconfirmed",
    aiAssistance: {
      actionCount: 1,
      acceptedActionCount: 1,
      rejectedActionCount: 0,
      actions: [],
      usage: {
        model: "provider/example",
        requestCount: 2,
        completedRequestCount: 1,
        failedRequestCount: 1,
        promptTokens: 120,
        completionTokens: 30,
        reasoningTokens: 4,
        cachedInputTokens: 10,
        totalTokens: 150,
        costUsd: 0.00012345,
        costUnavailableRequestCount: 0,
      },
    },
  });

  assert.match(report, /^Status: PARTIAL$/m);
  assert.match(
    report,
    /^Reason: submission was attempted, but no explicit confirmation appeared$/m,
  );
  assert.match(report, /^Failure kind: submission\.unconfirmed$/m);
  assert.match(report, /==================== AI ASSISTANCE ====================/);
  assert.match(report, /LLM workflow invoked: yes/);
  assert.match(report, /LLM operations attempted: 1/);
  assert.match(report, /LLM requests: 2/);
  assert.match(report, /LLM requests attempted: 2/);
  assert.match(report, /LLM requests completed: 1/);
  assert.match(report, /LLM requests failed: 1/);
  assert.match(report, /Model: provider\/example/);
  assert.match(report, /Total tokens: 150/);
  assert.match(report, /Cost \(USD\): \$0\.00012345/);
});

test("full reporting includes the evidence-based discovery classification", () => {
  const report = format_form_outcome({
    websiteUrl: "https://example.test/contact",
    contactPageFound: true,
    formFound: true,
    discovery: {
      assessment: "confirmed_form_present",
      presenceEvidenceStrength: "strong",
      searchCoverage: "complete",
      description: "Validated contact form found on /contact.",
      assessedAt: "2026-07-19T12:00:00.000Z",
    },
    populatedFields: ["email", "message"],
    submissionAttempted: true,
    submissionConfirmed: true,
    status: "SUCCESS",
  });

  assert.match(report, /^Assessment: confirmed_form_present$/m);
  assert.match(report, /^Presence evidence strength: strong$/m);
  assert.match(report, /^Search coverage: complete$/m);
  assert.match(
    report,
    /^Discovery description: Validated contact form found on \/contact\.$/m,
  );
});

test("LLM usage counts dispatch, completion, and failure separately", async () => {
  const usage = new OpenRouterUsageTracker("unused-test-key", "provider/model");
  usage.begin_request();
  usage.fail_request();
  usage.begin_request();
  await usage.complete_request(
    {
      inputTokens: 12,
      outputTokens: 4,
      reasoningTokens: 1,
      cachedInputTokens: 2,
      totalTokens: 16,
    },
    "",
  );

  assert.deepEqual(usage.snapshot(), {
    model: "provider/model",
    requestCount: 2,
    completedRequestCount: 1,
    failedRequestCount: 1,
    promptTokens: 12,
    completionTokens: 4,
    reasoningTokens: 1,
    cachedInputTokens: 2,
    totalTokens: 16,
    costUnavailableRequestCount: 1,
  });
});

test("AI reporting explicitly states when the LLM workflow was not invoked", () => {
  const report = format_form_outcome({
    websiteUrl: "https://example.test/contact",
    contactPageFound: true,
    formFound: true,
    populatedFields: ["email", "message"],
    submissionAttempted: true,
    submissionConfirmed: true,
    status: "SUCCESS",
  });

  assert.match(report, /==================== AI ASSISTANCE ====================/);
  assert.match(report, /LLM workflow invoked: no/);
  assert.match(report, /LLM operations attempted: 0/);
  assert.doesNotMatch(report, /LLM requests:/);
});

test("AI reporting counts failed LLM operations without provider usage", () => {
  const report = format_form_outcome({
    websiteUrl: "https://example.test/contact",
    contactPageFound: true,
    formFound: false,
    populatedFields: [],
    submissionAttempted: false,
    submissionConfirmed: false,
    status: "FAILED",
    reason: "LLM observation timed out",
    aiAssistance: {
      actionCount: 1,
      acceptedActionCount: 0,
      rejectedActionCount: 1,
      actions: [
        {
          stage: "discovery",
          placeholderInstruction: "Locate a contact form",
          selector: "",
          method: "observe",
          acceptance: "rejected",
          acceptanceReason: "observation timed out",
          result: "failed",
          model: "provider/example",
          durationMs: 30_000,
        },
      ],
    },
  });

  assert.match(report, /LLM workflow invoked: yes/);
  assert.match(report, /LLM operations attempted: 1/);
  assert.match(report, /Model: provider\/example/);
  assert.doesNotMatch(report, /LLM requests:/);
});
