import type {
  ConsoleMessage,
  Dialog,
  Download,
  Frame,
  Page,
  Request,
  Response,
} from "playwright";
import type { DeepDebugEventInput } from "./deep_debug_types_(Support).js";

interface InstallOptions {
  page: Page;
  record: (event: DeepDebugEventInput) => void;
  sanitizeText: (value: string) => string;
}

export async function install_deep_debug_page_instrumentation({
  page,
  record,
  sanitizeText,
}: InstallOptions): Promise<() => void> {
  const binding_name = `__contactDeepDebugEmit_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const request_ids = new WeakMap<Request, number>();
  let request_sequence = 0;

  await page.exposeBinding(binding_name, ({ frame }, payload: unknown) => {
    const source = payload && typeof payload === "object"
      ? payload as Record<string, unknown>
      : { payload };
    const kind = typeof source.kind === "string" ? source.kind : "browser-event";
    record({
      stage: "runtime",
      substage: kind === "mutation" ? "mutation" : "dom-event",
      operation: kind,
      outcome: "observed",
      frameUrl: frame.url(),
      data: source,
    });
  });

  const installation_script = [
    "globalThis.__name ||= ((target) => target);",
    `(${browser_instrumentation_install.toString()})(${JSON.stringify(binding_name)});`,
  ].join("\n");
  await page.addInitScript({ content: installation_script });
  await Promise.all(
    page.frames().map((frame) =>
      frame.evaluate(installation_script).catch((error: unknown) => {
        record({
          stage: "runtime",
          substage: "instrumentation",
          operation: "install-current-frame",
          outcome: "failed",
          frameUrl: frame.url(),
          reason: error instanceof Error ? error.message : String(error),
        });
      }),
    ),
  );

  const on_console = (message: ConsoleMessage): void => {
    record({
      stage: "runtime",
      substage: "console",
      operation: message.type(),
      outcome: "observed",
      url: page.url(),
      data: {
        text: sanitizeText(message.text()),
        location: message.location(),
        argumentCount: message.args().length,
      },
    });
  };
  const on_page_error = (error: Error): void => {
    record({
      stage: "runtime",
      substage: "page-error",
      operation: "uncaught-page-error",
      outcome: "failed",
      url: page.url(),
      reason: sanitizeText(error.message),
      data: { name: error.name, stack: sanitizeText(error.stack ?? "") },
    });
  };
  const on_request = (request: Request): void => {
    request_sequence += 1;
    request_ids.set(request, request_sequence);
    record({
      stage: "runtime",
      substage: "network",
      operation: "request",
      outcome: "started",
      correlationId: `request-${request_sequence}`,
      url: safe_url(request.url()),
      frameUrl: request.frame()?.url(),
      data: {
        method: request.method(),
        resourceType: request.resourceType(),
        isNavigationRequest: request.isNavigationRequest(),
        redirectedFrom: request.redirectedFrom()
          ? request_ids.get(request.redirectedFrom()!) ?? null
          : null,
        headers: safe_headers(request.headers()),
        payloadSchema: describe_request_payload(request),
      },
    });
  };
  const on_response = (response: Response): void => {
    const request = response.request();
    const id = request_ids.get(request);
    record({
      stage: "runtime",
      substage: "network",
      operation: "response",
      outcome: response.ok() ? "succeeded" : "failed",
      ...(id ? { correlationId: `request-${id}` } : {}),
      url: safe_url(response.url()),
      data: {
        status: response.status(),
        statusText: response.statusText(),
        fromServiceWorker: response.fromServiceWorker(),
        headers: safe_headers(response.headers()),
      },
    });
  };
  const on_request_failed = (request: Request): void => {
    const id = request_ids.get(request);
    record({
      stage: "runtime",
      substage: "network",
      operation: "request-failed",
      outcome: "failed",
      ...(id ? { correlationId: `request-${id}` } : {}),
      url: safe_url(request.url()),
      reason: sanitizeText(request.failure()?.errorText ?? "unknown request failure"),
    });
  };
  const on_frame_navigated = (frame: Frame): void => {
    record({
      stage: "runtime",
      substage: "navigation",
      operation: "frame-navigated",
      outcome: "observed",
      frameUrl: safe_url(frame.url()),
      data: { name: frame.name(), isMainFrame: frame === page.mainFrame() },
    });
  };
  const on_frame_attached = (frame: Frame): void => {
    record({
      stage: "runtime",
      substage: "frame",
      operation: "frame-attached",
      outcome: "observed",
      frameUrl: safe_url(frame.url()),
      data: { name: frame.name() },
    });
  };
  const on_frame_detached = (frame: Frame): void => {
    record({
      stage: "runtime",
      substage: "frame",
      operation: "frame-detached",
      outcome: "observed",
      frameUrl: safe_url(frame.url()),
      data: { name: frame.name() },
    });
  };
  const on_dialog = (dialog: Dialog): void => {
    record({
      stage: "runtime",
      substage: "dialog",
      operation: dialog.type(),
      outcome: "observed",
      url: page.url(),
      data: {
        message: sanitizeText(dialog.message()),
        defaultValueLength: dialog.defaultValue().length,
      },
    });
  };
  const on_popup = (popup: Page): void => {
    record({
      stage: "runtime",
      substage: "popup",
      operation: "popup-opened",
      outcome: "observed",
      url: safe_url(popup.url()),
    });
  };
  const on_download = (download: Download): void => {
    record({
      stage: "runtime",
      substage: "download",
      operation: "download-started",
      outcome: "observed",
      url: page.url(),
      data: { suggestedFilenameLength: download.suggestedFilename().length },
    });
  };

  page.on("console", on_console);
  page.on("pageerror", on_page_error);
  page.on("request", on_request);
  page.on("response", on_response);
  page.on("requestfailed", on_request_failed);
  page.on("framenavigated", on_frame_navigated);
  page.on("frameattached", on_frame_attached);
  page.on("framedetached", on_frame_detached);
  page.on("dialog", on_dialog);
  page.on("popup", on_popup);
  page.on("download", on_download);

  return () => {
    page.off("console", on_console);
    page.off("pageerror", on_page_error);
    page.off("request", on_request);
    page.off("response", on_response);
    page.off("requestfailed", on_request_failed);
    page.off("framenavigated", on_frame_navigated);
    page.off("frameattached", on_frame_attached);
    page.off("framedetached", on_frame_detached);
    page.off("dialog", on_dialog);
    page.off("popup", on_popup);
    page.off("download", on_download);
  };
}

function describe_request_payload(request: Request): unknown {
  const post_data = request.postData();
  if (!post_data) return null;
  const content_type = request.headers()["content-type"]?.toLowerCase() ?? "";
  if (content_type.includes("application/json")) {
    try {
      return {
        encoding: "json",
        byteLength: Buffer.byteLength(post_data),
        fields: flatten_json_schema(JSON.parse(post_data)),
      };
    } catch {
      return { encoding: "json-invalid", byteLength: Buffer.byteLength(post_data) };
    }
  }
  if (content_type.includes("application/x-www-form-urlencoded")) {
    const fields = [...new URLSearchParams(post_data).entries()].slice(0, 200).map(
      ([name, value]) => ({ name, kind: "string", length: value.length }),
    );
    return { encoding: "form-urlencoded", byteLength: Buffer.byteLength(post_data), fields };
  }
  if (content_type.includes("multipart/form-data")) {
    const names = [...post_data.matchAll(/name="([^"]+)"/g)]
      .map((match) => match[1] ?? "")
      .filter(Boolean)
      .slice(0, 200);
    return {
      encoding: "multipart",
      byteLength: Buffer.byteLength(post_data),
      fieldNames: [...new Set(names)],
    };
  }
  return { encoding: "opaque", byteLength: Buffer.byteLength(post_data) };
}

function flatten_json_schema(
  value: unknown,
  path = "$",
  output: Array<{ path: string; kind: string; length?: number }> = [],
): Array<{ path: string; kind: string; length?: number }> {
  if (output.length >= 200) return output;
  if (Array.isArray(value)) {
    output.push({ path, kind: "array", length: value.length });
    value.slice(0, 20).forEach((item, index) =>
      flatten_json_schema(item, `${path}[${index}]`, output),
    );
  } else if (value && typeof value === "object") {
    output.push({ path, kind: "object", length: Object.keys(value).length });
    for (const [key, child] of Object.entries(value).slice(0, 100)) {
      flatten_json_schema(child, `${path}.${key}`, output);
    }
  } else if (typeof value === "string") {
    output.push({ path, kind: "string", length: value.length });
  } else {
    output.push({ path, kind: value === null ? "null" : typeof value });
  }
  return output;
}

function safe_headers(headers: Record<string, string>): Record<string, string> {
  const allowed = new Set([
    "accept",
    "content-type",
    "content-length",
    "location",
    "origin",
    "referer",
    "sec-fetch-dest",
    "sec-fetch-mode",
    "sec-fetch-site",
    "x-request-id",
  ]);
  return Object.fromEntries(
    Object.entries(headers)
      .filter(([name]) => allowed.has(name.toLowerCase()))
      .map(([name, value]) => [
        name,
        name.toLowerCase() === "location" || name.toLowerCase() === "referer"
          ? safe_url(value)
          : value.slice(0, 1_000),
      ]),
  );
}

function safe_url(value: string): string {
  try {
    const parsed = new URL(value);
    for (const key of [...parsed.searchParams.keys()]) {
      if (/email|phone|name|message|token|auth|password|secret|key|captcha|session|cookie/i.test(key)) {
        parsed.searchParams.set(key, "[redacted]");
      }
    }
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return value.slice(0, 2_000);
  }
}

function browser_instrumentation_install(binding_name: string): void {
  const state = globalThis as typeof globalThis & {
    __contactDeepDebugInstalled?: boolean;
    __contactDeepDebugPaused?: boolean;
    [key: string]: unknown;
  };
  if (state.__contactDeepDebugInstalled) return;
  state.__contactDeepDebugInstalled = true;
  state.__contactDeepDebugPaused = false;

  const emit = (payload: unknown): void => {
    if (state.__contactDeepDebugPaused) return;
    const binding = state[binding_name];
    if (typeof binding === "function") {
      void Promise.resolve((binding as (value: unknown) => unknown)(payload)).catch(() => undefined);
    }
  };
  const descriptor = (value: EventTarget | Node | null): unknown => {
    if (!(value instanceof Element)) return { nodeType: value instanceof Node ? value.nodeType : null };
    const element = value as HTMLElement;
    const control = value as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
    const text = value instanceof HTMLButtonElement || value.getAttribute("role") === "button"
      ? (element.innerText || value.textContent || "").trim().replace(/\s+/g, " ").slice(0, 500)
      : "";
    const raw_value = "value" in control ? String(control.value ?? "") : "";
    return {
      tag: value.tagName.toLowerCase(),
      id: element.id,
      name: value.getAttribute("name") ?? "",
      type: value.getAttribute("type") ?? "",
      role: value.getAttribute("role") ?? "",
      className: typeof element.className === "string" ? element.className : "",
      text,
      connected: value.isConnected,
      valueState: { present: raw_value.length > 0, length: raw_value.length },
    };
  };
  const event_types = ["click", "submit", "formdata", "invalid", "input", "change"];
  const event_payload = (event: Event, phase: "capture" | "bubble"): unknown => {
    const submit_event = event instanceof SubmitEvent ? event : undefined;
    const form_data_event = typeof FormDataEvent !== "undefined" && event instanceof FormDataEvent
      ? event
      : undefined;
    return {
      kind: "dom-event",
      eventType: event.type,
      phase,
      timestamp: new Date().toISOString(),
      isTrusted: event.isTrusted,
      cancelable: event.cancelable,
      defaultPrevented: event.defaultPrevented,
      target: descriptor(event.target),
      submitter: descriptor(submit_event?.submitter ?? null),
      formData: form_data_event
        ? Array.from(form_data_event.formData.entries()).slice(0, 200).map(([name, value]) => ({
            name,
            kind: typeof value === "string" ? "string" : "file",
            length: typeof value === "string" ? value.length : value.size,
          }))
        : undefined,
    };
  };
  for (const type of event_types) {
    addEventListener(type, (event) => emit(event_payload(event, "capture")), true);
    addEventListener(type, (event) => {
      queueMicrotask(() => emit(event_payload(event, "bubble")));
    }, false);
  }

  const observer = new MutationObserver((mutations) => {
    if (state.__contactDeepDebugPaused) return;
    for (const mutation of mutations.slice(0, 100)) {
      emit({
        kind: "mutation",
        mutationType: mutation.type,
        timestamp: new Date().toISOString(),
        target: descriptor(mutation.target),
        attributeName: mutation.attributeName,
        added: Array.from(mutation.addedNodes).slice(0, 20).map(descriptor),
        removed: Array.from(mutation.removedNodes).slice(0, 20).map(descriptor),
        addedCount: mutation.addedNodes.length,
        removedCount: mutation.removedNodes.length,
      });
    }
  });
  const root = document.documentElement;
  if (root) {
    observer.observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: [
        "class",
        "style",
        "hidden",
        "disabled",
        "required",
        "aria-hidden",
        "aria-disabled",
        "aria-invalid",
        "aria-expanded",
        "data-step",
        "data-current-step",
      ],
    });
  }
}
