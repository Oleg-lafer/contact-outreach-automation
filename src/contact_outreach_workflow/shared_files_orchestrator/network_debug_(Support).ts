import type { Page, Request, Response } from "playwright";
import type { NetworkDebugRecord, NetworkDebugRecorder } from "./outreach_types_(Support).js";
import { redact_diagnostic_text, redact_diagnostic_url } from "./diagnostic_redaction_(Support).js";

export function start_network_debug_recorder(
  page: Page,
  redaction_values: string[],
): NetworkDebugRecorder {
  const records: NetworkDebugRecord[] = [];
  const request_records = new WeakMap<Request, NetworkDebugRecord>();

  const on_request = (request: Request): void => {
    const post_data = request.postData();
    const record: NetworkDebugRecord = {
      id: records.length + 1,
      method: request.method(),
      url: redact_diagnostic_url(request.url(), redaction_values),
      resourceType: request.resourceType(),
      startedAt: new Date().toISOString(),
      ...(post_data
        ? {
            postDataPreview: describe_post_data_schema(
              post_data,
              request.headers()["content-type"] ?? "",
              redaction_values,
            ),
          }
        : {}),
    };
    records.push(record);
    request_records.set(request, record);
  };

  const on_response = (response: Response): void => {
    const record = request_records.get(response.request());
    if (record) {
      record.status = response.status();
      record.completedAt = new Date().toISOString();
    }
  };

  const on_request_failed = (request: Request): void => {
    const record = request_records.get(request);
    if (record) {
      record.failureText = request.failure()?.errorText ?? "unknown request failure";
      record.completedAt = new Date().toISOString();
    }
  };

  page.on("request", on_request);
  page.on("response", on_response);
  page.on("requestfailed", on_request_failed);

  return {
    snapshot: () => records.map((record) => ({ ...record })),
    stop: () => {
      page.off("request", on_request);
      page.off("response", on_response);
      page.off("requestfailed", on_request_failed);
      return records;
    },
  };
}

function describe_post_data_schema(
  value: string,
  content_type: string,
  redaction_values: string[],
): string {
  const normalized_type = content_type.toLowerCase();
  let schema: unknown;
  if (normalized_type.includes("application/json")) {
    try {
      schema = {
        encoding: "json",
        byteLength: Buffer.byteLength(value),
        fields: flatten_json_fields(JSON.parse(value)),
      };
    } catch {
      schema = { encoding: "json-invalid", byteLength: Buffer.byteLength(value) };
    }
  } else if (normalized_type.includes("application/x-www-form-urlencoded")) {
    schema = {
      encoding: "form-urlencoded",
      byteLength: Buffer.byteLength(value),
      fields: [...new URLSearchParams(value).entries()].slice(0, 200).map(
        ([name, field_value]) => ({
          name: redact_diagnostic_text(name, redaction_values, 200),
          kind: "string",
          length: field_value.length,
        }),
      ),
    };
  } else if (normalized_type.includes("multipart/form-data")) {
    schema = {
      encoding: "multipart",
      byteLength: Buffer.byteLength(value),
      fieldNames: [...new Set(
        [...value.matchAll(/name="([^"]+)"/g)]
          .map((match) => match[1] ?? "")
          .filter(Boolean)
          .slice(0, 200),
      )],
    };
  } else {
    schema = { encoding: "opaque", byteLength: Buffer.byteLength(value) };
  }
  return redact_diagnostic_text(JSON.stringify(schema), redaction_values, 2_000);
}

function flatten_json_fields(
  value: unknown,
  path = "$",
  output: Array<{ path: string; kind: string; length?: number }> = [],
): Array<{ path: string; kind: string; length?: number }> {
  if (output.length >= 200) return output;
  if (Array.isArray(value)) {
    output.push({ path, kind: "array", length: value.length });
    value.slice(0, 20).forEach((item, index) =>
      flatten_json_fields(item, `${path}[${index}]`, output),
    );
  } else if (value && typeof value === "object") {
    output.push({ path, kind: "object", length: Object.keys(value).length });
    for (const [key, child] of Object.entries(value).slice(0, 100)) {
      flatten_json_fields(child, `${path}.${key}`, output);
    }
  } else if (typeof value === "string") {
    output.push({ path, kind: "string", length: value.length });
  } else {
    output.push({ path, kind: value === null ? "null" : typeof value });
  }
  return output;
}
