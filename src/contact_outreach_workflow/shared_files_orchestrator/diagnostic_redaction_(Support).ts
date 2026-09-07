const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PHONE_PATTERN = /(?:\+\d[\d\s().-]{6,}\d|\(\d{2,4}\)[\d\s.-]{4,}\d|\d{2,4}[ -]\d{3,4}[ -]\d{3,4})/;

export function redact_diagnostic_text(
  value: string,
  redactionValues: readonly string[],
  maxLength: number,
): string {
  const protected_urls: string[] = [];
  const with_placeholders = value.replace(/https?:\/\/[^\s<>"'`]+/gi, (url) => {
    const placeholder = `__DIAGNOSTIC_URL_${protected_urls.length}__`;
    try {
      protected_urls.push(redact_url_value(url, redactionValues));
    } catch {
      protected_urls.push(redact_plain_text(url, redactionValues));
    }
    return placeholder;
  });
  let output = redact_plain_text(with_placeholders, redactionValues);
  protected_urls.forEach((url, index) => {
    output = output.replaceAll(`__DIAGNOSTIC_URL_${index}__`, url);
  });
  return output.length > maxLength
    ? `${output.slice(0, maxLength)}...[truncated]`
    : output;
}

function redact_plain_text(value: string, redactionValues: readonly string[]): string {
  let output = value;
  for (const secret of normalized_redaction_values(redactionValues).sort((left, right) => right.length - left.length)) {
    output = output.replace(new RegExp(escape_regexp(secret), "gi"), "[redacted]");
  }
  output = output
    .replace(new RegExp(EMAIL_PATTERN.source, "gi"), "[redacted-email]")
    .replace(new RegExp(PHONE_PATTERN.source, "g"), "[redacted-phone]");
  return output;
}

/**
 * Redacts URL components without applying arbitrary substring replacement to
 * the public scheme or hostname. This prevents contact values such as a
 * country name from corrupting an otherwise public domain name.
 */
export function redact_diagnostic_url(
  value: string,
  redactionValues: readonly string[],
  maxLength = 2_000,
): string {
  try {
    const output = redact_url_value(value, redactionValues);
    return output.length > maxLength
      ? `${output.slice(0, maxLength)}...[truncated]`
      : output;
  } catch {
    const output = redact_plain_text(value, redactionValues);
    return output.length > maxLength ? `${output.slice(0, maxLength)}...[truncated]` : output;
  }
}

function redact_url_value(value: string, redactionValues: readonly string[]): string {
  const parsed = new URL(value);
  if (parsed.username) parsed.username = "[redacted]";
  if (parsed.password) parsed.password = "[redacted]";

  parsed.pathname = parsed.pathname
    .split("/")
    .map((segment) => sensitive_component(segment, redactionValues) ? "[redacted]" : segment)
    .join("/");

  for (const [key, parameterValue] of [...parsed.searchParams.entries()]) {
    if (is_sensitive_key(key) || sensitive_component(parameterValue, redactionValues)) {
      parsed.searchParams.set(key, "[redacted]");
    }
  }
  if (parsed.hash) parsed.hash = "#[redacted]";

  return parsed.toString()
    .replace(/%5Bredacted%5D/gi, "[redacted]")
    .replace(/%40/gi, "@");
}

function sensitive_component(value: string, redactionValues: readonly string[]): boolean {
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    // Use the raw component when percent decoding is invalid.
  }
  const normalized = decoded.trim().toLowerCase();
  return EMAIL_PATTERN.test(decoded) || PHONE_PATTERN.test(decoded) ||
    normalized_redaction_values(redactionValues).some((secret) => normalized === secret.toLowerCase());
}

function normalized_redaction_values(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 1))];
}

function is_sensitive_key(key: string): boolean {
  return /email|phone|name|message|token|auth|password|secret|key|captcha|session|cookie/i.test(key);
}

function escape_regexp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
