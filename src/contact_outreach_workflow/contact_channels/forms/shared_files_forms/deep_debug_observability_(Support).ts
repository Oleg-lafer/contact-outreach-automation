import { createHash, randomBytes } from "node:crypto";
import {
  appendFile,
  mkdir,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import type { Locator, Page } from "playwright";
import { with_masked_page_values } from "../../../shared_files_orchestrator/page_value_redaction_(Integration).js";
import type {
  DeepDebugArtifactSummary,
  DeepDebugContext,
  DeepDebugCreateOptions,
  DeepDebugEventInput,
  DeepDebugFinalizeInput,
} from "./deep_debug_types_(Support).js";
import { install_deep_debug_page_instrumentation } from "./deep_debug_page_instrumentation_(Integration).js";

const SCHEMA_VERSION = 1;
const MAX_ARTIFACT_BYTES = 250 * 1024 * 1024;
const MAX_TIMELINE_EVENTS = 100_000;
const MAX_NETWORK_EVENTS = 25_000;
const MAX_MUTATION_EVENTS = 20_000;
const MAX_CONTROLS_PER_SNAPSHOT = 500;
const MAX_SCREENSHOTS = 30;
const MAX_TEXT_LENGTH = 4_000;

interface ArtifactError {
  at: string;
  operation: string;
  path?: string;
  error: string;
}

interface Counters {
  timelineEvents: number;
  networkEvents: number;
  mutationEvents: number;
  screenshots: number;
  truncatedEvents: number;
  droppedNetworkEvents: number;
  droppedMutationEvents: number;
  droppedScreenshots: number;
  truncatedStrings: number;
  scheduledBytes: number;
}

export async function create_deep_debug_context(
  options: DeepDebugCreateOptions,
): Promise<DeepDebugContext> {
  const run_id = create_run_id();
  const artifact_directory = resolve(
    dirname(options.outputPath),
    "deep-debug",
    run_id,
  );
  await mkdir(artifact_directory, { recursive: true });

  const manifest_path = join(artifact_directory, "manifest.json");
  const timeline_path = join(artifact_directory, "timeline.jsonl");
  const summary_path = join(artifact_directory, "summary.txt");
  const started_at = new Date().toISOString();
  const monotonic_started_at = performance.now();
  const artifact_errors: ArtifactError[] = [];
  const ai_operations: unknown[] = [];
  const cleanup_callbacks: Array<() => void | Promise<void>> = [];
  const counters: Counters = {
    timelineEvents: 0,
    networkEvents: 0,
    mutationEvents: 0,
    screenshots: 0,
    truncatedEvents: 0,
    droppedNetworkEvents: 0,
    droppedMutationEvents: 0,
    droppedScreenshots: 0,
    truncatedStrings: 0,
    scheduledBytes: 0,
  };
  const redaction_values = [...new Set(options.redactionValues.filter(Boolean))]
    .sort((left, right) => right.length - left.length);
  let write_queue: Promise<void> = Promise.resolve();
  let finalized = false;
  let final_summary: DeepDebugArtifactSummary | undefined;

  const sanitize_text = (value: string): string => {
    let redacted = value;
    for (const secret of redaction_values) {
      if (secret.trim().length < 2) continue;
      redacted = redacted.replace(
        new RegExp(escape_regexp(secret), "gi"),
        "[redacted-contact-value]",
      );
    }
    redacted = redacted
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
      .replace(
        /(?:\+\d[\d\s().-]{6,}\d|\(\d{2,4}\)[\d\s.-]{4,}\d|\d{2,4}[ -]\d{3,4}[ -]\d{3,4})/g,
        "[redacted-phone]",
      )
      .replace(
        /((?:authorization|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|password|secret|session|cookie)\s*[:=]\s*)[^\s,;]+/gi,
        "$1[redacted-secret]",
      )
      .replace(
        /\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
        "[redacted-token]",
      )
      .replace(/\b(?:[a-f0-9]{40,}|[A-Za-z0-9+/=_-]{64,})\b/gi, "[redacted-high-entropy]");
    if (redacted.length > MAX_TEXT_LENGTH) {
      counters.truncatedStrings += 1;
      return `${redacted.slice(0, MAX_TEXT_LENGTH)}...[truncated]`;
    }
    return redacted;
  };

  const sanitize = (value: unknown, key = "", seen = new WeakSet<object>()): unknown => {
    if (value === null || value === undefined || typeof value === "boolean" || typeof value === "number") {
      return value;
    }
    if (typeof value === "string") {
      if (/placeholderInstruction|prompt|completion/i.test(key)) {
        return "[omitted-model-content]";
      }
      if (/authorization|cookie|token|password|secret|api.?key|session/i.test(key)) {
        return "[redacted-secret]";
      }
      return sanitize_text(value);
    }
    if (typeof value === "bigint") return value.toString();
    if (typeof value === "function" || typeof value === "symbol") {
      return `[${typeof value}]`;
    }
    if (Array.isArray(value)) {
      return value.map((item) => sanitize(item, key, seen));
    }
    if (typeof value === "object") {
      if (seen.has(value)) return "[circular]";
      seen.add(value);
      const output: Record<string, unknown> = {};
      for (const [child_key, child_value] of Object.entries(value)) {
        output[child_key] = sanitize(child_value, child_key, seen);
      }
      seen.delete(value);
      return output;
    }
    return String(value);
  };

  const report_artifact_error = (
    operation: string,
    error: unknown,
    path?: string,
  ): void => {
    artifact_errors.push({
      at: new Date().toISOString(),
      operation,
      ...(path ? { path } : {}),
      error: sanitize_text(error instanceof Error ? error.message : String(error)),
    });
  };

  const queue_append = (relative_path: string, content: string): void => {
    const byte_length = Buffer.byteLength(content);
    if (counters.scheduledBytes + byte_length > MAX_ARTIFACT_BYTES) {
      counters.truncatedEvents += 1;
      return;
    }
    counters.scheduledBytes += byte_length;
    const absolute_path = join(artifact_directory, relative_path);
    write_queue = write_queue
      .then(async () => {
        await mkdir(dirname(absolute_path), { recursive: true });
        await appendFile(absolute_path, content, "utf8");
      })
      .catch((error: unknown) => {
        report_artifact_error("append", error, absolute_path);
      });
  };

  const record = (input: DeepDebugEventInput): void => {
    if (finalized) return;
    if (counters.timelineEvents >= MAX_TIMELINE_EVENTS) {
      counters.truncatedEvents += 1;
      return;
    }
    if (input.stage === "runtime" && input.substage === "network") {
      if (counters.networkEvents >= MAX_NETWORK_EVENTS) {
        counters.droppedNetworkEvents += 1;
        return;
      }
      counters.networkEvents += 1;
    }
    if (input.stage === "runtime" && input.substage === "mutation") {
      if (counters.mutationEvents >= MAX_MUTATION_EVENTS) {
        counters.droppedMutationEvents += 1;
        return;
      }
      counters.mutationEvents += 1;
    }

    counters.timelineEvents += 1;
    const sequence = counters.timelineEvents;
    const event = sanitize({
      sequence,
      timestamp: new Date().toISOString(),
      monotonicOffsetMs: Number((performance.now() - monotonic_started_at).toFixed(3)),
      ...input,
    });
    const line = `${JSON.stringify(event)}\n`;
    queue_append("timeline.jsonl", line);
    queue_append(`${input.stage}/events.jsonl`, line);
    if (input.stage === "runtime") {
      queue_append(`runtime/${safe_filename(input.substage)}.jsonl`, line);
    }
  };

  const write_json = async (
    relative_path: string,
    value: unknown,
  ): Promise<string | undefined> => {
    const normalized_path = normalize_relative_path(relative_path);
    const absolute_path = join(artifact_directory, normalized_path);
    try {
      await write_queue;
      const content = `${JSON.stringify(sanitize(value), null, 2)}\n`;
      if (counters.scheduledBytes + Buffer.byteLength(content) > MAX_ARTIFACT_BYTES) {
        counters.truncatedEvents += 1;
        return undefined;
      }
      counters.scheduledBytes += Buffer.byteLength(content);
      await mkdir(dirname(absolute_path), { recursive: true });
      await writeFile(absolute_path, content, "utf8");
      return absolute_path;
    } catch (error) {
      report_artifact_error("writeJson", error, absolute_path);
      return undefined;
    }
  };

  const context: DeepDebugContext = {
    runId: run_id,
    artifactDirectory: artifact_directory,
    redactionValues: redaction_values,
    record,
    writeJson: write_json,
    captureFormSnapshot: async ({ stage, label, form, expectedValues, extra }) => {
      const started = performance.now();
      try {
        const snapshot = await collect_form_snapshot(
          form,
          expectedValues ?? [],
          MAX_CONTROLS_PER_SNAPSHOT,
        );
        const document = sanitize({
          schemaVersion: SCHEMA_VERSION,
          capturedAt: new Date().toISOString(),
          label,
          snapshot,
          ...(extra === undefined ? {} : { extra }),
        });
        const path = await write_json(
          `${stage}/snapshots/${safe_filename(label)}.json`,
          document,
        );
        record({
          stage,
          substage: "snapshot",
          operation: label,
          outcome: path ? "succeeded" : "failed",
          durationMs: performance.now() - started,
          frameUrl: form.page().url(),
          data: {
            path: path ?? null,
            controlCount: snapshot.controlCount,
            capturedControlCount: snapshot.controls.length,
            controlsTruncated: snapshot.controlCount > snapshot.controls.length,
          },
        });
        return document;
      } catch (error) {
        report_artifact_error("captureFormSnapshot", error);
        record({
          stage,
          substage: "snapshot",
          operation: label,
          outcome: "failed",
          reason: error instanceof Error ? error.message : String(error),
          durationMs: performance.now() - started,
        });
        return undefined;
      }
    },
    captureScreenshot: async (page, stage, label) => {
      if (counters.screenshots >= MAX_SCREENSHOTS) {
        counters.droppedScreenshots += 1;
        record({
          stage,
          substage: "screenshot",
          operation: label,
          outcome: "skipped",
          reason: "screenshot cap reached",
        });
        return undefined;
      }
      counters.screenshots += 1;
      const relative_path = `${stage}/screenshots/${safe_filename(label)}.png`;
      const absolute_path = join(artifact_directory, relative_path);
      try {
        await set_browser_instrumentation_paused(page, true);
        await mkdir(dirname(absolute_path), { recursive: true });
        await with_masked_page_values(page, redaction_values, () =>
          page.screenshot({
            path: absolute_path,
            fullPage: true,
            animations: "disabled",
          }),
        );
        record({
          stage,
          substage: "screenshot",
          operation: label,
          outcome: "succeeded",
          data: { path: absolute_path, contactValuesMasked: true },
        });
        return absolute_path;
      } catch (error) {
        report_artifact_error("captureScreenshot", error, absolute_path);
        record({
          stage,
          substage: "screenshot",
          operation: label,
          outcome: "failed",
          reason: error instanceof Error ? error.message : String(error),
        });
        return undefined;
      } finally {
        await set_browser_instrumentation_paused(page, false);
      }
    },
    attachPage: async (page) => {
      const cleanup = await install_deep_debug_page_instrumentation({
        page,
        record,
        sanitizeText: sanitize_text,
      });
      cleanup_callbacks.push(cleanup);
      record({
        stage: "runtime",
        substage: "instrumentation",
        operation: "attach-page-observers",
        outcome: "succeeded",
        url: page.url(),
      });
    },
    recordAiOperations: (stage, trigger, operations) => {
      const normalized = operations.map((operation) =>
        normalize_ai_operation(operation, trigger, sanitize_text),
      );
      ai_operations.push(...normalized);
      record({
        stage: "ai",
        substage: stage,
        operation: "bounded-stagehand-fallback",
        outcome: normalized.length > 0 ? "observed" : "skipped",
        reason: trigger,
        data: { operations: normalized },
      });
    },
    finalize: async (input: DeepDebugFinalizeInput) => {
      if (final_summary) return final_summary;
      finalized = true;
      for (const cleanup of cleanup_callbacks.splice(0)) {
        await Promise.resolve(cleanup()).catch((error: unknown) =>
          report_artifact_error("pageInstrumentationCleanup", error),
        );
      }
      await write_queue;
      await write_json("ai/operations.json", {
        schemaVersion: SCHEMA_VERSION,
        operations: ai_operations,
      });

      const finished_at = new Date().toISOString();
      const outcome_record = sanitize(input.outcome ?? null) as Record<string, unknown> | null;
      const summary_lines = build_summary_lines({
        runId: run_id,
        artifactDirectory: artifact_directory,
        startedAt: started_at,
        finishedAt: finished_at,
        outcome: outcome_record,
        ...(input.failure ? { failure: sanitize_text(input.failure) } : {}),
        counters,
        artifactErrors: artifact_errors,
      });
      try {
        await writeFile(summary_path, `${summary_lines.join("\n")}\n`, "utf8");
      } catch (error) {
        report_artifact_error("writeSummary", error, summary_path);
      }

      const inventory = await collect_artifact_inventory(artifact_directory).catch(
        (error: unknown) => {
          report_artifact_error("inventory", error, artifact_directory);
          return [];
        },
      );
      const manifest = {
        schemaVersion: SCHEMA_VERSION,
        runId: run_id,
        startedAt: started_at,
        finishedAt: finished_at,
        durationMs: Number((performance.now() - monotonic_started_at).toFixed(3)),
        targetUrl: sanitize_text(options.targetUrl),
        engine: options.engine,
        runtime: {
          node: process.version,
          platform: process.platform,
          arch: process.arch,
          pid: process.pid,
          stagehandModelConfigured: Boolean(options.environment?.OPENROUTER_MODEL),
        },
        limits: {
          maxArtifactBytes: MAX_ARTIFACT_BYTES,
          maxTimelineEvents: MAX_TIMELINE_EVENTS,
          maxNetworkEvents: MAX_NETWORK_EVENTS,
          maxMutationEvents: MAX_MUTATION_EVENTS,
          maxControlsPerSnapshot: MAX_CONTROLS_PER_SNAPSHOT,
          maxScreenshots: MAX_SCREENSHOTS,
          maxTextLength: MAX_TEXT_LENGTH,
        },
        counters,
        artifactErrors: artifact_errors,
        artifacts: inventory,
        outcome: outcome_record,
        aiUsage: sanitize(input.aiUsage ?? null),
        failure: input.failure ? sanitize_text(input.failure) : null,
      };
      try {
        await writeFile(manifest_path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      } catch (error) {
        report_artifact_error("writeManifest", error, manifest_path);
      }

      final_summary = {
        runId: run_id,
        artifactDirectory: artifact_directory,
        manifestPath: manifest_path,
        timelinePath: timeline_path,
        summaryPath: summary_path,
        eventCount: counters.timelineEvents,
        artifactErrorCount: artifact_errors.length,
        truncatedEventCount:
          counters.truncatedEvents +
          counters.droppedNetworkEvents +
          counters.droppedMutationEvents +
          counters.droppedScreenshots,
      };
      return final_summary;
    },
    summary: () =>
      final_summary ?? {
        runId: run_id,
        artifactDirectory: artifact_directory,
        manifestPath: manifest_path,
        timelinePath: timeline_path,
        summaryPath: summary_path,
        eventCount: counters.timelineEvents,
        artifactErrorCount: artifact_errors.length,
        truncatedEventCount:
          counters.truncatedEvents +
          counters.droppedNetworkEvents +
          counters.droppedMutationEvents +
          counters.droppedScreenshots,
      },
  };

  record({
    stage: "orchestrator",
    substage: "run",
    operation: "deep-debug-created",
    outcome: "succeeded",
    url: options.targetUrl,
    data: {
      runId: run_id,
      artifactDirectory: artifact_directory,
      engine: options.engine,
      contactValueCount: redaction_values.length,
    },
  });
  return context;
}

async function collect_form_snapshot(
  form: Locator,
  expected_values: readonly string[],
  max_controls: number,
): Promise<{
  frameUrl: string;
  pageUrl: string;
  form: unknown;
  controlCount: number;
  controls: unknown[];
}> {
  const data = await form.evaluate(
    (root, input) => {
      const html = root as HTMLElement;
      const form_element = root instanceof HTMLFormElement ? root : null;
      const all_controls = Array.from(
        root.querySelectorAll<HTMLElement>(
          "input, textarea, select, button, [role=button], [contenteditable=true]",
        ),
      );
      const describe_element = (element: Element): string => {
        const current = element as HTMLElement;
        const tag = element.tagName.toLowerCase();
        const id = current.id ? `#${current.id}` : "";
        const name = element.getAttribute("name");
        return `${tag}${id}${name ? `[name=\"${name}\"]` : ""}`;
      };
      const visible = (element: HTMLElement): boolean => {
        const box = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return box.width > 0 && box.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      };
      return {
        form: {
          identity: describe_element(root),
          tag: root.tagName.toLowerCase(),
          id: html.id,
          className: typeof html.className === "string" ? html.className : "",
          action: form_element?.action ?? root.getAttribute("action") ?? "",
          method: form_element?.method ?? root.getAttribute("method") ?? "",
          target: form_element?.target ?? root.getAttribute("target") ?? "",
          noValidate: form_element?.noValidate ?? false,
          connected: root.isConnected,
          visible: visible(html),
          boundingBox: (() => {
            const box = html.getBoundingClientRect();
            return { x: box.x, y: box.y, width: box.width, height: box.height };
          })(),
        },
        controlCount: all_controls.length,
        controls: all_controls.slice(0, input.maxControls).map((element, index) => {
          const control = element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLButtonElement;
          const box = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          const value = "value" in control ? String(control.value ?? "") : "";
          const validity = "validity" in control ? control.validity : undefined;
          const labels = "labels" in control && control.labels
            ? Array.from(control.labels).map((label) => (label.textContent ?? "").trim().replace(/\s+/g, " "))
            : [];
          return {
            index,
            identity: describe_element(element),
            tag: element.tagName.toLowerCase(),
            type: element.getAttribute("type") ?? "",
            role: element.getAttribute("role") ?? "",
            name: element.getAttribute("name") ?? "",
            id: element.id,
            className: typeof element.className === "string" ? element.className : "",
            placeholder: element.getAttribute("placeholder") ?? "",
            ariaLabel: element.getAttribute("aria-label") ?? "",
            autocomplete: element.getAttribute("autocomplete") ?? "",
            labels,
            text: element instanceof HTMLButtonElement || element.getAttribute("role") === "button"
              ? (element.innerText || element.textContent || "").trim().replace(/\s+/g, " ")
              : "",
            required: "required" in control ? Boolean(control.required) : element.getAttribute("aria-required") === "true",
            disabled: "disabled" in control ? Boolean(control.disabled) : element.getAttribute("aria-disabled") === "true",
            readOnly: "readOnly" in control ? Boolean(control.readOnly) : false,
            checked: "checked" in control ? Boolean(control.checked) : undefined,
            selectedIndex: element instanceof HTMLSelectElement ? element.selectedIndex : undefined,
            selectedOptions: element instanceof HTMLSelectElement
              ? Array.from(element.selectedOptions).map((option) => ({ text: option.text, value: option.value }))
              : undefined,
            visible: visible(element),
            connected: element.isConnected,
            boundingBox: { x: box.x, y: box.y, width: box.width, height: box.height },
            computedStyle: {
              display: style.display,
              visibility: style.visibility,
              opacity: style.opacity,
              pointerEvents: style.pointerEvents,
              position: style.position,
              zIndex: style.zIndex,
            },
            valueState: {
              present: value.length > 0,
              length: value.length,
              matchesExpected: value.length > 0 && input.expectedValues.some((expected) => expected === value),
            },
            willValidate: "willValidate" in control ? control.willValidate : false,
            validationMessage: "validationMessage" in control ? control.validationMessage : "",
            validity: validity
              ? {
                  valid: validity.valid,
                  valueMissing: validity.valueMissing,
                  typeMismatch: validity.typeMismatch,
                  patternMismatch: validity.patternMismatch,
                  tooLong: validity.tooLong,
                  tooShort: validity.tooShort,
                  rangeUnderflow: validity.rangeUnderflow,
                  rangeOverflow: validity.rangeOverflow,
                  stepMismatch: validity.stepMismatch,
                  badInput: validity.badInput,
                  customError: validity.customError,
                }
              : undefined,
          };
        }),
      };
    },
    { expectedValues: [...expected_values], maxControls: max_controls },
  );
  return {
    frameUrl: form.page().url(),
    pageUrl: form.page().url(),
    ...data,
  };
}

function normalize_ai_operation(
  value: unknown,
  trigger: string,
  sanitize_text: (value: string) => string,
): unknown {
  const source = value && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
  const instruction = typeof source.placeholderInstruction === "string"
    ? source.placeholderInstruction
    : "";
  return {
    recordedAt: new Date().toISOString(),
    trigger: sanitize_text(trigger),
    instructionTemplateId: instruction
      ? createHash("sha256").update(instruction).digest("hex").slice(0, 16)
      : "none",
    stage: source.stage ?? null,
    selector: typeof source.selector === "string" ? sanitize_text(source.selector) : "",
    method: source.method ?? null,
    argumentCount: source.argumentCount ?? 0,
    acceptance: source.acceptance ?? null,
    acceptanceReason:
      typeof source.acceptanceReason === "string"
        ? sanitize_text(source.acceptanceReason)
        : null,
    result: source.result ?? null,
    resultMessage:
      typeof source.resultMessage === "string"
        ? sanitize_text(source.resultMessage)
        : null,
    model: source.model ?? null,
    durationMs: source.durationMs ?? null,
    normalization: source.normalization ?? null,
  };
}

async function set_browser_instrumentation_paused(
  page: Page,
  paused: boolean,
): Promise<void> {
  await Promise.all(
    page.frames().map((frame) =>
      frame
        .evaluate((value) => {
          (globalThis as typeof globalThis & { __contactDeepDebugPaused?: boolean })
            .__contactDeepDebugPaused = value;
        }, paused)
        .catch(() => undefined),
    ),
  );
}

function build_summary_lines(input: {
  runId: string;
  artifactDirectory: string;
  startedAt: string;
  finishedAt: string;
  outcome: Record<string, unknown> | null;
  failure?: string;
  counters: Counters;
  artifactErrors: ArtifactError[];
}): string[] {
  return [
    "DEEP POPULATION-TO-SUBMISSION DEBUG",
    "===================================",
    `Run ID: ${input.runId}`,
    `Started: ${input.startedAt}`,
    `Finished: ${input.finishedAt}`,
    `Status: ${String(input.outcome?.status ?? "unknown")}`,
    `Failure kind: ${String(input.outcome?.failureKind ?? "none")}`,
    `Reason: ${String(input.failure ?? input.outcome?.reason ?? "none")}`,
    `Submission attempted: ${String(input.outcome?.submissionAttempted ?? false)}`,
    `Submission confirmed: ${String(input.outcome?.submissionConfirmed ?? false)}`,
    `Timeline events: ${input.counters.timelineEvents}`,
    `Network events: ${input.counters.networkEvents}`,
    `Mutation events: ${input.counters.mutationEvents}`,
    `Screenshots: ${input.counters.screenshots}`,
    `Dropped/truncated: ${input.counters.truncatedEvents + input.counters.droppedNetworkEvents + input.counters.droppedMutationEvents + input.counters.droppedScreenshots}`,
    `Artifact errors: ${input.artifactErrors.length}`,
    `Artifact directory: ${input.artifactDirectory}`,
    "",
    "Start with timeline.jsonl, then inspect handoff/, population/, and submission/.",
  ];
}

async function collect_artifact_inventory(
  directory: string,
  root = directory,
): Promise<Array<{ path: string; bytes: number }>> {
  const entries = await readdir(directory, { withFileTypes: true });
  const inventory: Array<{ path: string; bytes: number }> = [];
  for (const entry of entries) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) {
      inventory.push(...await collect_artifact_inventory(absolute, root));
    } else if (entry.isFile()) {
      inventory.push({
        path: absolute.slice(root.length + 1).replace(/\\/g, "/"),
        bytes: (await stat(absolute)).size,
      });
    }
  }
  return inventory.sort((left, right) => left.path.localeCompare(right.path));
}

function create_run_id(): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${timestamp}_${randomBytes(4).toString("hex")}`;
}

function safe_filename(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
  return normalized || "capture";
}

function normalize_relative_path(value: string): string {
  const clean = value.replace(/\\/g, "/").replace(/^\/+/, "");
  const segments = clean.split("/").filter((segment) => segment && segment !== "." && segment !== "..");
  const normalized = segments.join("/");
  return normalized || `artifact${extname(value) || ".json"}`;
}

function escape_regexp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
