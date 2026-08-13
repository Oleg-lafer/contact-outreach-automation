import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
  resolve_cli_options,
  run_contact_outreach_workflow,
} from "../src/contact_outreach_workflow/contact_outreach_orchestrator.js";
import { create_deep_debug_context } from "../src/contact_outreach_workflow/contact_channels/forms/shared_files_forms/deep_debug_observability_(Support).js";

const CONTACT_VALUES = {
  name: "Deep Debug Person",
  email: "deep-debug-secret@example.test",
  phone: "+1 202 555 0199",
  message: "This exact message must never appear in artifacts.",
};

let server: Server;
let origin: string;
let temporary_directory: string;

before(async () => {
  temporary_directory = await mkdtemp(join(tmpdir(), "contact-deep-debug-"));
  server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    if (request.method === "POST" && pathname === "/api/contact-no-ui") {
      response.statusCode = 204;
      response.end();
      return;
    }
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(page_for_path(pathname));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test server did not expose a TCP port");
  }
  origin = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()),
    );
  }
  if (temporary_directory) {
    await rm(temporary_directory, { recursive: true, force: true });
  }
});

test("deep-debug recorder and workflow artifacts", async (context) => {
  await context.test("redacts contact values and omits raw Stagehand prompts", async () => {
    assert.deepEqual(
      resolve_cli_options(["deep-debug", "input.json", "result.txt"]),
      {
        runMode: "deep-debug",
        inputPath: "input.json",
        outputPath: "result.txt",
      },
    );
    const output_path = join(temporary_directory, "recorder", "result.txt");
    const recorder = await create_deep_debug_context({
      outputPath: output_path,
      targetUrl: `${origin}/success?email=${encodeURIComponent(CONTACT_VALUES.email)}`,
      engine: "stagehand",
      redactionValues: Object.values(CONTACT_VALUES),
      environment: { OPENROUTER_MODEL: "test-model" },
    });
    recorder.record({
      stage: "population",
      substage: "test",
      operation: "secret-redaction",
      outcome: "observed",
      data: CONTACT_VALUES,
    });
    recorder.recordAiOperations("population", CONTACT_VALUES.message, [{
      placeholderInstruction: `raw provider prompt ${CONTACT_VALUES.message}`,
      selector: `[value="${CONTACT_VALUES.email}"]`,
      method: "fill",
      acceptance: "rejected",
      acceptanceReason: CONTACT_VALUES.phone,
      result: "notRun",
      model: "test-model",
      durationMs: 1,
    }]);
    const summary = await recorder.finalize({
      outcome: { status: "FAILED", reason: CONTACT_VALUES.message },
    });

    const text = await read_text_artifacts(summary.artifactDirectory);
    assert_no_contact_values(text);
    assert.doesNotMatch(text, /raw provider prompt/i);
    assert.match(text, /instructionTemplateId/);
    assert.match(text, /redacted-contact-value/);
  });

  await context.test("captures successful population, handoff, submit, DOM, and confirmation evidence", async () => {
    const outcome = await run_deep_debug("/success", "success");
    assert.equal(outcome.status, "SUCCESS", JSON.stringify(outcome));
    assert.equal(outcome.submissionAttempted, true);
    assert.equal(outcome.submissionConfirmed, true);
    assert.ok(outcome.deepDebug);
    assert.equal(outcome.deepDebug.artifactErrorCount, 0);

    const timeline = await readFile(outcome.deepDebug.timelinePath, "utf8");
    assert.match(timeline, /population-completed/);
    assert.match(timeline, /population-to-submission-handoff/);
    assert.match(timeline, /prepare-submit-control/);
    assert.match(timeline, /activate-submit-control/);
    assert.match(timeline, /dom-event/);
    assert.match(timeline, /submission-assessment-completed/);
    assert_chronological(timeline);
    assert_no_contact_values(await read_text_artifacts(outcome.deepDebug.artifactDirectory));
  });

  await context.test("captures native validation blockage before submit activation", async () => {
    const outcome = await run_deep_debug("/validation", "validation");
    assert.equal(outcome.failureKind, "submission.validation", JSON.stringify(outcome));
    assert.equal(outcome.submissionAttempted, false);
    const timeline = await readFile(outcome.deepDebug!.timelinePath, "utf8");
    assert.match(timeline, /assess-effective-native-validity/);
    assert.match(timeline, /deterministic-population-recovery/);
    assert.equal(
      count_occurrences(
        timeline,
        '"operation":"activate-submit-control","outcome":"started"',
      ),
      0,
    );
    const submission_debug = JSON.parse(
      await readFile(
        join(outcome.deepDebug!.artifactDirectory, "submission-debug.json"),
        "utf8",
      ),
    ) as {
      preSubmitValidation: {
        initial: { applicability: string; valid: boolean };
        final: { applicability: string; valid: boolean };
        recovery: { attempted: boolean; succeeded: boolean };
      };
      invalidControls: Array<Record<string, unknown>>;
    };
    assert.equal(
      submission_debug.preSubmitValidation.initial.applicability,
      "applicable",
    );
    assert.equal(submission_debug.preSubmitValidation.initial.valid, false);
    assert.equal(submission_debug.preSubmitValidation.final.valid, false);
    assert.equal(submission_debug.preSubmitValidation.recovery.attempted, true);
    assert.equal(submission_debug.preSubmitValidation.recovery.succeeded, false);
    assert.equal("value" in (submission_debug.invalidControls[0] ?? {}), false);
    assert.match(
      await read_text_artifacts(outcome.deepDebug!.artifactDirectory),
      /"valueMissing": true/,
    );
  });

  await context.test("records inactive hidden conditional disabling and restoration", async () => {
    const outcome = await run_deep_debug(
      "/hidden-conditional",
      "hidden-conditional",
    );
    assert.equal(outcome.status, "SUCCESS", JSON.stringify(outcome));
    assert.equal(outcome.submissionConfirmed, true);
    assert.equal(
      outcome.submissionDebug?.inactiveConditionalControlsDisabled,
      1,
    );

    const evidence = JSON.parse(
      await readFile(
        join(
          outcome.deepDebug!.artifactDirectory,
          "submission",
          "inactive-conditional-controls.json",
        ),
        "utf8",
      ),
    ) as {
      checkpoints: Array<{ disabledControls: unknown[] }>;
      restorations: Array<{
        label: string;
        result: { restored: number; failed: number };
      }>;
    };
    assert.equal(
      evidence.checkpoints.some(
        (checkpoint) => checkpoint.disabledControls.length === 1,
      ),
      true,
    );
    assert.equal(
      evidence.restorations.some(
        (restoration) =>
          restoration.label === "terminal-finally" &&
          restoration.result.restored === 1 &&
          restoration.result.failed === 0,
      ),
      true,
    );
    assert_no_contact_values(
      await read_text_artifacts(outcome.deepDebug!.artifactDirectory),
    );
  });

  await context.test(
    "keeps network confirmation authoritative over post-submit invalid controls",
    async () => {
      const outcome = await run_deep_debug(
        "/network-success-reset",
        "network-success-reset",
      );
      assert.equal(outcome.status, "SUCCESS", JSON.stringify(outcome));
      assert.equal(outcome.submissionConfirmed, true);
      assert.equal(outcome.submissionDebug?.confirmationEvidence, "network");

      const submission_debug = JSON.parse(
        await readFile(
          join(outcome.deepDebug!.artifactDirectory, "submission-debug.json"),
          "utf8",
        ),
      ) as {
        confirmed: boolean;
        confirmationEvidence: string;
        invalidControls: unknown[];
      };
      const manifest = JSON.parse(
        await readFile(outcome.deepDebug!.manifestPath, "utf8"),
      ) as {
        outcome: {
          status: string;
          submissionConfirmed: boolean;
          failureKind?: string;
        };
      };
      assert.equal(submission_debug.confirmed, true);
      assert.equal(submission_debug.confirmationEvidence, "network");
      assert.equal(submission_debug.invalidControls.length > 0, true);
      assert.equal(manifest.outcome.status, "SUCCESS");
      assert.equal(manifest.outcome.submissionConfirmed, true);
      assert.equal(manifest.outcome.failureKind, undefined);

      const artifacts = await read_text_artifacts(
        outcome.deepDebug!.artifactDirectory,
      );
      assert.match(artifacts, /"confirmationEvidence": "network"/);
      assert.doesNotMatch(artifacts, /"failureKind": "submission\.validation"/);
    },
  );

  await context.test(
    "records a reset without evidence as unconfirmed rather than validation",
    async () => {
      const outcome = await run_deep_debug(
        "/reset-without-evidence",
        "reset-without-evidence",
      );
      assert.equal(outcome.failureKind, "submission.inconclusive", JSON.stringify(outcome));
      assert.equal(outcome.submissionAttempted, true);
      assert.equal(outcome.submissionConfirmed, false);

      const artifacts = await read_text_artifacts(
        outcome.deepDebug!.artifactDirectory,
      );
      assert.doesNotMatch(artifacts, /"failureKind": "submission\.validation"/);
    },
  );

  await context.test("captures submit-control loss and obstruction preflight", async () => {
    const missing = await run_deep_debug("/remove-submit", "remove-submit");
    assert.equal(missing.failureKind, "submission.no_control", JSON.stringify(missing));
    assert.match(
      await readFile(missing.deepDebug!.timelinePath, "utf8"),
      /no enabled submit control was found/,
    );

    const obstructed = await run_deep_debug("/overlay", "overlay");
    assert.equal(obstructed.failureKind, "submission.preflight", JSON.stringify(obstructed));
    const timeline = await readFile(obstructed.deepDebug!.timelinePath, "utf8");
    assert.match(timeline, /preflight-hit-test/);
    assert.match(timeline, /intercepted the submit control/);
  });

  await context.test("captures unconfirmed and passive-CAPTCHA outcomes without a second submit", async () => {
    const unconfirmed = await run_deep_debug("/unconfirmed", "unconfirmed");
    assert.equal(unconfirmed.failureKind, "submission.inconclusive", JSON.stringify(unconfirmed));
    const unconfirmed_timeline = await readFile(
      unconfirmed.deepDebug!.timelinePath,
      "utf8",
    );
    assert.equal(count_occurrences(unconfirmed_timeline, '"operation":"activate-submit-control","outcome":"started"'), 1);
    assert.match(unconfirmed_timeline, /deterministic-evidence/);

    const captcha = await run_deep_debug("/passive-captcha", "passive-captcha");
    assert.equal(captcha.status, "SUCCESS", JSON.stringify(captcha));
    assert.equal(captcha.submissionConfirmed, true);
    assert.equal(captcha.submissionDebug?.captchaBlocked, false);
  });

  await context.test("keeps rejection, contradiction, and artifacts in agreement", async () => {
    const rejected = await run_deep_debug(
      "/round3-visible-rejection",
      "round3-visible-rejection",
    );
    assert.equal(rejected.status, "FAILED", JSON.stringify(rejected));
    assert.equal(rejected.failureKind, "submission.rejected");
    assert.equal(rejected.submissionDebug?.postClickDisposition, "rejected");

    const contradictory = await run_deep_debug(
      "/round3-contradictory",
      "round3-contradictory",
    );
    assert.equal(contradictory.status, "INCONCLUSIVE", JSON.stringify(contradictory));
    assert.equal(
      contradictory.failureKind,
      "submission.inconclusive",
    );
    assert.equal(
      contradictory.submissionDebug?.postClickDisposition,
      "contradictory",
    );
    assert.equal(contradictory.submissionDebug?.confirmationEvidence, "network");

    for (const outcome of [rejected, contradictory]) {
      const artifacts = await read_text_artifacts(
        outcome.deepDebug!.artifactDirectory,
      );
      assert.match(
        artifacts,
        new RegExp(`"postClickDisposition": "${outcome.submissionDebug!.postClickDisposition}"`),
      );
      assert.match(
        artifacts,
        new RegExp(`"failureKind": "${outcome.failureKind!.replace(".", "\\.")}"`),
      );
      assert_no_contact_values(artifacts);
      assert.equal(
        count_occurrences(
          await readFile(outcome.deepDebug!.timelinePath, "utf8"),
          '"operation":"activate-submit-control","outcome":"started"',
        ),
        1,
      );
    }
  });
});

test("keeps Hebrew success evidence bounded and redacted", async () => {
  const outcome = await run_deep_debug("/hebrew-success", "hebrew-success");
  assert.equal(outcome.status, "SUCCESS", JSON.stringify(outcome));
  assert.equal(outcome.submissionConfirmed, true);
  assert.equal(outcome.deepDebug?.artifactErrorCount, 0);
  const artifacts = await read_text_artifacts(outcome.deepDebug!.artifactDirectory);
  assert.match(artifacts, /פנייתך התקבלה/u);
  assert_no_contact_values(artifacts);
});

async function run_deep_debug(path: string, name: string) {
  const directory = join(temporary_directory, name);
  const input_path = join(directory, "input.json");
  const output_path = join(directory, "result.txt");
  await writeFile(
    input_path,
    `${JSON.stringify({ websiteUrl: `${origin}${path}`, ...CONTACT_VALUES }, null, 2)}\n`,
    { encoding: "utf8", flag: "w" },
  ).catch(async (error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const { mkdir } = await import("node:fs/promises");
    await mkdir(directory, { recursive: true });
    await writeFile(
      input_path,
      `${JSON.stringify({ websiteUrl: `${origin}${path}`, ...CONTACT_VALUES }, null, 2)}\n`,
      "utf8",
    );
  });
  const outcome = await run_contact_outreach_workflow(input_path, {
    runMode: "deep-debug",
    outputPath: output_path,
    engine: "playwright",
  });
  return outcome.channels.forms;
}

function page_for_path(path: string): string {
  if (path === "/hebrew-success") {
    return `<!doctype html><html dir="rtl"><body><main><h1>צור קשר</h1>
      <form id="contact">
        <label>שם מלא <input name="x1" required></label>
        <label>אימייל <input name="x2" required></label>
        <label>טלפון <input name="x3"></label>
        <label>הודעה <textarea name="x4" required></textarea></label>
        <button type="submit">שליחת הודעה</button>
      </form><div id="status" role="status"></div></main>
      <script>document.querySelector('#contact').addEventListener('submit', event => {
        event.preventDefault();
        document.querySelector('#status').textContent = 'תודה, פנייתך התקבלה';
      });</script></body></html>`;
  }
  const hidden_required =
    path === "/validation"
      ? '<input id="hidden-required" name="security_quiz" required style="display:none">'
      : path === "/hidden-conditional"
        ? '<section hidden><label>Other topic <input id="inactive-required" name="inactive_other_topic" required></label></section>'
        : "";
  const captcha = path === "/passive-captcha"
    ? '<div class="g-recaptcha" data-sitekey="test"></div>'
    : "";
  const submit_behavior =
    path === "/success" || path === "/passive-captcha"
      ? "status.textContent = 'Thank you. Your message has been sent successfully.';"
      : path === "/hidden-conditional"
        ? `if (!new FormData(form).has('inactive_other_topic') &&
               form.elements.inactive_other_topic.disabled) {
             status.textContent = 'Thank you. Your message has been sent successfully.';
           }`
      : path === "/network-success-reset"
        ? `fetch('/api/contact-no-ui', {
             method: 'POST',
             body: new FormData(form),
           }).then(() => form.reset());`
        : path === "/round3-visible-rejection"
          ? "status.textContent = 'Please complete this required field.';"
          : path === "/round3-contradictory"
            ? `fetch('/api/contact-no-ui', {
                 method: 'POST',
                 body: new FormData(form),
               }).then(() => {
                 status.textContent = 'Please complete this required field.';
               });`
        : path === "/reset-without-evidence"
          ? "form.reset();"
          : "";
  const input_behavior = path === "/remove-submit"
      ? "form.querySelector('button')?.remove();"
      : path === "/overlay"
        ? `if (!document.querySelector('#overlay')) {
             const overlay = document.createElement('div');
             overlay.id = 'overlay';
             overlay.textContent = 'blocking overlay';
             overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.1)';
             document.body.appendChild(overlay);
           }`
        : "";
  return `<!doctype html>
    <html><body><main><h1>Contact our team</h1>
      <form id="contact" action="/contact" method="post">
        <label>Name <input name="name" autocomplete="name" required></label>
        <label>Email <input name="email" type="email" required></label>
        <label>Phone <input name="phone" type="tel"></label>
        <label>Message <textarea name="message" required></textarea></label>
        ${hidden_required}${captcha}
        <button type="submit">Send message</button>
      </form><div id="status" role="status"></div></main>
      <script>
        const form = document.querySelector('#contact');
        const status = document.querySelector('#status');
        form.addEventListener('input', () => { ${input_behavior} }, { once: true });
        form.addEventListener('submit', event => {
          event.preventDefault();
          ${submit_behavior}
        });
      </script>
    </body></html>`;
}

async function read_text_artifacts(directory: string): Promise<string> {
  const files = await list_files(directory);
  const text_files = files.filter((file) => /\.(?:json|jsonl|txt)$/i.test(file));
  return (await Promise.all(text_files.map((file) => readFile(file, "utf8")))).join("\n");
}

async function list_files(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await list_files(path));
    if (entry.isFile()) files.push(path);
  }
  return files;
}

function assert_no_contact_values(value: string): void {
  for (const secret of Object.values(CONTACT_VALUES)) {
    assert.equal(value.includes(secret), false, `artifact leaked contact value: ${secret}`);
  }
}

function assert_chronological(timeline: string): void {
  const events = timeline.trim().split(/\r?\n/).map(
    (line) => JSON.parse(line) as { sequence: number; monotonicOffsetMs: number },
  );
  for (let index = 1; index < events.length; index += 1) {
    assert.equal(events[index]!.sequence, events[index - 1]!.sequence + 1);
    assert.ok(events[index]!.monotonicOffsetMs >= events[index - 1]!.monotonicOffsetMs);
  }
}

function count_occurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}
