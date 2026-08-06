import type { Page, Request, Response } from "playwright";
import type { NetworkDebugRecord, NetworkDebugRecorder } from "./outreach_types_(Support).js";

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
      url: redact_url(request.url(), redaction_values),
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
          name: redact_text(name, redaction_values, 200),
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
  return redact_text(JSON.stringify(schema), redaction_values, 2_000);
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

function redact_url(value: string, redaction_values: string[]): string {
  try {
    const parsed_url = new URL(value);
    for (const [key, parameter_value] of parsed_url.searchParams.entries()) {
      if (
        is_sensitive_key(key) ||
        contains_redaction_value(parameter_value, redaction_values)
      ) {
        parsed_url.searchParams.set(key, "[redacted]");
      }
    }
    const serialized_url = parsed_url
      .toString()
      .replace(/%5Bredacted%5D/gi, "[redacted]");
    return redact_text(serialized_url, redaction_values, 2_000);
  } catch {
    return redact_text(value, redaction_values, 2_000);
  }
}

function redact_text(
  value: string,
  redaction_values: string[],
  max_length: number,
): string {
  let redacted = value;
  for (const secret of redaction_values
    .filter((candidate) => candidate.trim().length > 1)
    .sort((left, right) => right.length - left.length)) {
    redacted = redacted.replace(new RegExp(escape_regexp(secret), "g"), "[redacted]");
  }

  redacted = redacted
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .replace(
      /(?:\+\d[\d\s().-]{6,}\d|\(\d{2,4}\)[\d\s.-]{4,}\d|\d{2,4}[ -]\d{3,4}[ -]\d{3,4})/g,
      "[redacted-phone]",
    );

  return redacted.length > max_length
    ? `${redacted.slice(0, max_length)}...[truncated]`
    : redacted;
}

function contains_redaction_value(
  value: string,
  redaction_values: string[],
): boolean {
  return redaction_values.some(
    (redaction_value) =>
      redaction_value.trim().length > 1 && value.includes(redaction_value),
  );
}

function is_sensitive_key(key: string): boolean {
  return /email|phone|name|message|token|auth|password|secret|key|captcha|session|cookie/i.test(
    key,
  );
}

function escape_regexp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
