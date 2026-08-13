import type {
  NetworkDebugRecord,
  NetworkSubmissionEvidenceSummary,
  NetworkSubmissionRequestSummary,
} from "../../shared_files_forms/forms_types_(Support).js";

const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH"]);

interface NetworkSubmissionEvidenceContext {
  pageUrlBeforeSubmission?: string;
}

type NetworkRequestClassification =
  | "submissionEvidence"
  | "rejectionOnly"
  | "trackingEvidence"
  | "unknownNetworkActivity";

interface ClassifiedNetworkRecord {
  record: NetworkDebugRecord;
  formLikeScore: number;
  classification: NetworkRequestClassification;
  providerRuleId?: string;
}

/*
 * ========================================================================
 * NETWORK SUBMISSION EVIDENCE
 * ========================================================================
 * Converts the redacted network log into conservative submission evidence.
 * Network evidence is only confirmatory when a post-click, form-like request
 * receives a successful HTTP response.
 * ========================================================================
 */
export function analyze_network_submission_evidence(
  network_records: NetworkDebugRecord[],
  submit_clicked_at: string | undefined,
  context: NetworkSubmissionEvidenceContext = {},
): NetworkSubmissionEvidenceSummary {
  if (!submit_clicked_at) {
    return no_network_submission_evidence(
      "submit click timestamp was unavailable",
    );
  }

  const submit_timestamp = Date.parse(submit_clicked_at);
  if (Number.isNaN(submit_timestamp)) {
    return no_network_submission_evidence("submit click timestamp was invalid");
  }

  const post_click_records = network_records.filter((record) => {
    const started_at = Date.parse(record.startedAt);
    return !Number.isNaN(started_at) && started_at >= submit_timestamp;
  });

  const classified_records = post_click_records
    .filter((record) => STATE_CHANGING_METHODS.has(record.method.toUpperCase()))
    .map((record) => classify_network_record(record, context));

  const candidates = classified_records
    .filter(
      (candidate) => candidate.classification === "submissionEvidence",
    )
    .filter((candidate) => candidate.formLikeScore > 0)
    .sort(compare_network_candidates);

  const best_success = candidates.find((candidate) =>
    is_successful_status(candidate.record.status),
  );
  const rejection_candidates = classified_records
    .filter(
      (candidate) =>
        candidate.classification === "submissionEvidence" ||
        candidate.classification === "rejectionOnly",
    )
    .filter(
      (candidate) =>
        candidate.formLikeScore >= 3 || Boolean(candidate.providerRuleId),
    )
    .filter((candidate) => is_explicit_network_rejection(candidate.record))
    .sort(compare_network_candidates);
  const best_rejection = rejection_candidates[0];

  if (best_success && best_rejection) {
    const best_request = summarize_network_request(best_success.record);
    const rejection_request = summarize_network_request(best_rejection.record);
    return {
      found: true,
      confirmsSubmission: true,
      rejectsSubmission: true,
      confidence: "strong",
      summary: `contradictory network submission evidence: ${request_summary("successful form-like request", best_request)}; ${request_summary("rejected form-like request", rejection_request)}`,
      reason:
        "one correlated form request succeeded while another correlated form request was explicitly rejected",
      bestRequest: best_request,
      bestRejectionRequest: rejection_request,
      ...(best_success.providerRuleId ?? best_rejection.providerRuleId
        ? {
            providerRuleId:
              best_success.providerRuleId ?? best_rejection.providerRuleId,
          }
        : {}),
      rejectionCategory: "server",
      ...(is_captcha_rejection(best_rejection.record)
        ? captcha_rejection_details(best_rejection.record)
        : {}),
    };
  }

  if (best_success) {
    const best_request = summarize_network_request(best_success.record);
    return {
      found: true,
      confirmsSubmission: true,
      rejectsSubmission: false,
      confidence: "strong",
      summary: request_summary("successful form-like request", best_request),
      reason: "a form-like post-click request returned a successful HTTP status",
      bestRequest: best_request,
      ...(best_success.providerRuleId
        ? { providerRuleId: best_success.providerRuleId }
        : {}),
    };
  }

  if (best_rejection) {
    const best_request = summarize_network_request(best_rejection.record);
    const captcha_rejection = is_captcha_rejection(best_rejection.record);
    return {
      found: true,
      confirmsSubmission: false,
      rejectsSubmission: true,
      confidence: "strong",
      summary: request_summary("rejected form-like request", best_request),
      reason: unsuccessful_request_reason(best_rejection.record),
      bestRequest: best_request,
      bestRejectionRequest: best_request,
      ...(best_rejection.providerRuleId
        ? { providerRuleId: best_rejection.providerRuleId }
        : {}),
      rejectionCategory: captcha_rejection ? "captcha" : "server",
      ...(captcha_rejection
        ? captcha_rejection_details(best_rejection.record)
        : {}),
    };
  }

  const best_candidate = candidates[0];
  if (!best_candidate) {
    if (
      classified_records.length > 0 &&
      classified_records.every(
        (candidate) => candidate.classification === "trackingEvidence",
      )
    ) {
      return no_network_submission_evidence(
        "only tracking or analytics post-click network requests were found",
      );
    }

    return no_network_submission_evidence(
      "no form-like post-click network request was found",
    );
  }

  const best_request = summarize_network_request(best_candidate.record);
  return {
    found: true,
    confirmsSubmission: false,
    rejectsSubmission: false,
    confidence: "medium",
    summary: request_summary("form-like request did not prove success", best_request),
    reason: unsuccessful_request_reason(best_candidate.record),
    bestRequest: best_request,
    ...(best_candidate.providerRuleId
      ? { providerRuleId: best_candidate.providerRuleId }
      : {}),
  };
}

function is_captcha_rejection(record: NetworkDebugRecord): boolean {
  const evidence =
    `${record.url} ${record.postDataPreview ?? ""} ${record.failureText ?? ""}`;
  return (
    /captcha|recaptcha|hcaptcha|turnstile|challenge/i.test(evidence) &&
    ((record.status ?? 0) >= 400 ||
      Boolean(record.failureText) ||
      /reject|denied|forbidden|invalid|failed|failure|required|blocked|נדחה|נכשל|שגוי|לא תקין|חובה|נדרש|חסום/iu.test(
        evidence,
      ))
  );
}

function captcha_rejection_details(record: NetworkDebugRecord): {
  captchaRejected: true;
  captchaRejectionReason: string;
} {
  return {
    captchaRejected: true,
    captchaRejectionReason: `CAPTCHA physically blocked submission: the correlated form request was rejected${record.status ? ` with HTTP ${record.status}` : ""}`,
  };
}

function no_network_submission_evidence(
  reason: string,
): NetworkSubmissionEvidenceSummary {
  return {
    found: false,
    confirmsSubmission: false,
    rejectsSubmission: false,
    confidence: "none",
    summary: "no network submission evidence",
    reason,
  };
}

function score_network_record(record: NetworkDebugRecord): {
  record: NetworkDebugRecord;
  formLikeScore: number;
} {
  const searchable = `${record.url} ${record.postDataPreview ?? ""}`.toLowerCase();
  let formLikeScore = 0;

  if (
    /contact|form|lead|demo|request|inquiry|enquiry|message|submit|submission|book|schedule|צור.?קשר|טופס|פנייה|פניה|הודעה|שליחה|קביעת.?פגישה/u.test(
      searchable,
    )
  ) {
    formLikeScore += 3;
  }

  if (
    /\b(email|phone|name|firstname|lastname|message|company|contact|lead|form)\b|אימייל|דוא["״']?ל|טלפון|שם|הודעה|חברה|טופס/u.test(
      searchable,
    )
  ) {
    formLikeScore += 3;
  }

  if (/hsforms|hubspot|salesforce|marketo|pardot|mailchimp/.test(searchable)) {
    formLikeScore += 2;
  }

  if (record.postDataPreview && record.postDataPreview.trim().length > 0) {
    formLikeScore += 1;
  }

  return { record, formLikeScore };
}

function classify_network_record(
  record: NetworkDebugRecord,
  context: NetworkSubmissionEvidenceContext,
): ClassifiedNetworkRecord {
  const scored_record = score_network_record(record);
  const provider_rule = match_bounded_provider_rule(record);

  if (provider_rule?.authority === "trackingOnly") {
    return {
      ...scored_record,
      classification: "trackingEvidence",
      providerRuleId: provider_rule.id,
    };
  }

  if (is_obvious_tracking_request(record)) {
    return {
      ...scored_record,
      classification: "trackingEvidence",
    };
  }

  if (provider_rule) {
    return {
      ...scored_record,
      classification:
        provider_rule.authority === "rejectionOnly"
          ? "rejectionOnly"
          : "submissionEvidence",
      providerRuleId: provider_rule.id,
    };
  }

  if (
    scored_record.formLikeScore > 0 &&
    (is_first_party_request(record, context.pageUrlBeforeSubmission) ||
      is_known_form_service_request(record))
  ) {
    return {
      ...scored_record,
      classification: "submissionEvidence",
      ...(is_known_form_service_request(record)
        ? { providerRuleId: "existing-known-form-service" }
        : {}),
    };
  }

  return {
    ...scored_record,
    classification: "unknownNetworkActivity",
  };
}

function match_bounded_provider_rule(
  record: NetworkDebugRecord,
):
  | {
      id: string;
      authority: "confirmAndReject" | "rejectionOnly" | "trackingOnly";
    }
  | undefined {
  const host = record_host(record);
  const path = record_path(record);
  const method = record.method.toUpperCase();
  if (method !== "POST" || !record.postDataPreview?.trim()) {
    return undefined;
  }

  if (
    host === "v3.oscar-campus.com" &&
    /^\/[^/]+\/forms\/?$/.test(path)
  ) {
    return { id: "oscar-campus-form-submit", authority: "confirmAndReject" };
  }
  if (
    (host === "formsite.com" || host.endsWith(".formsite.com")) &&
    /^\/res\/submit(?:[;/]|$)/.test(path)
  ) {
    return { id: "formsite-form-submit", authority: "confirmAndReject" };
  }
  if (
    (host === "formstack.com" || host.endsWith(".formstack.com")) &&
    /^\/forms\/index\.php\/?$/.test(path)
  ) {
    return { id: "formstack-rejection-only", authority: "rejectionOnly" };
  }
  if (
    host === "forms.hscollectedforms.net" &&
    /^\/collected-forms\/submit\/form\/?$/.test(path)
  ) {
    return { id: "hubspot-collected-form-telemetry", authority: "trackingOnly" };
  }
  return undefined;
}

function compare_network_candidates(
  left: {
    record: NetworkDebugRecord;
    formLikeScore: number;
  },
  right: {
    record: NetworkDebugRecord;
    formLikeScore: number;
  },
): number {
  return (
    Number(is_successful_status(right.record.status)) -
      Number(is_successful_status(left.record.status)) ||
    right.formLikeScore - left.formLikeScore ||
    left.record.id - right.record.id
  );
}

function is_obvious_tracking_request(record: NetworkDebugRecord): boolean {
  const host = record_host(record);
  const path = record_path(record);

  return (
    /(^|\.)google-analytics\.com$|(^|\.)analytics\.google\.com$|(^|\.)googletagmanager\.com$|(^|\.)doubleclick\.net$|(^|\.)googleadservices\.com$|(^|\.)facebook\.com$|(^|\.)linkedin\.com$|(^|\.)ads\.linkedin\.com$|(^|\.)hotjar\.com$|(^|\.)clarity\.ms$|(^|\.)fullstory\.com$|(^|\.)mixpanel\.com$|(^|\.)amplitude\.com$|(^|\.)segment\.com$|(^|\.)sentry\.io$/.test(
      host,
    ) ||
    /^\/(ccm\/form-data|pagead\/form-data|rmkt\/collect|analytics\/collect|analytics\/events|analytics\/event|pagead|g\/collect|collect|events|event|track|tracking|gtm)(\/|$)/.test(
      path,
    ) ||
    /(^|\.)stats\.g\.doubleclick\.net$/.test(host) ||
    /(^|\.)px\.ads\.linkedin\.com$/.test(host) ||
    /\/tr\/?$/.test(path)
  );
}

function is_first_party_request(
  record: NetworkDebugRecord,
  page_url_before_submission: string | undefined,
): boolean {
  if (!page_url_before_submission) {
    return false;
  }

  const record_url = parsed_record_url(record);
  const page_url = parse_url(page_url_before_submission);
  const host = record_host(record);

  if (page_url && is_redacted_host(host) && is_local_host(page_url.hostname)) {
    return true;
  }

  return Boolean(
    record_url &&
      page_url &&
      same_registrable_host(record_url.hostname, page_url.hostname),
  );
}

function is_known_form_service_request(record: NetworkDebugRecord): boolean {
  const host = record_host(record);
  const searchable = `${record.url} ${record.postDataPreview ?? ""}`.toLowerCase();
  return (
    /(^|\.)hsforms\.com$|(^|\.)hubspot\.com$|(^|\.)salesforce\.com$|(^|\.)force\.com$|(^|\.)marketo\.com$|(^|\.)mktoresp\.com$|(^|\.)pardot\.com$|(^|\.)mailchimp\.com$/.test(
      host,
    ) ||
    /hsforms|hubspot|webtolead|salesforce|marketo|mktoresp|pardot|mailchimp|contact-form-7|wpcf7/.test(
      searchable,
    )
  );
}

function is_successful_status(status: number | undefined): boolean {
  return status !== undefined && status >= 200 && status < 400;
}

function is_explicit_network_rejection(record: NetworkDebugRecord): boolean {
  if (record.status !== undefined) {
    return record.status >= 400;
  }
  return Boolean(record.failureText);
}

function summarize_network_request(
  record: NetworkDebugRecord,
): NetworkSubmissionRequestSummary {
  return {
    method: record.method,
    ...(record.status !== undefined ? { status: record.status } : {}),
    url: record.url,
    resourceType: record.resourceType,
  };
}

function request_summary(
  prefix: string,
  request: NetworkSubmissionRequestSummary,
): string {
  return `${prefix}: ${request.method} ${request.status ?? "no-status"} ${request.url}`;
}

function unsuccessful_request_reason(record: NetworkDebugRecord): string {
  if (record.failureText) {
    return `form-like request failed: ${record.failureText}`;
  }

  if (record.status === undefined) {
    return "form-like request did not receive an HTTP response status";
  }

  return `form-like request returned non-success HTTP status ${record.status}`;
}

function parsed_record_url(record: NetworkDebugRecord): URL | undefined {
  return parse_url(record.url);
}

function parse_url(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function same_registrable_host(left: string, right: string): boolean {
  const normalized_left = normalize_host(left);
  const normalized_right = normalize_host(right);
  return (
    normalized_left === normalized_right ||
    normalized_left.endsWith(`.${normalized_right}`) ||
    normalized_right.endsWith(`.${normalized_left}`)
  );
}

function normalize_host(host: string): string {
  return host.toLowerCase().replace(/^www\./, "").replace(/:\d+$/, "");
}

function record_host(record: NetworkDebugRecord): string {
  const parsed_url = parsed_record_url(record);
  if (parsed_url) {
    return normalize_host(parsed_url.hostname);
  }

  const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(record.url);
  return normalize_host(match?.[1] ?? "");
}

function record_path(record: NetworkDebugRecord): string {
  const parsed_url = parsed_record_url(record);
  if (parsed_url) {
    return parsed_url.pathname.toLowerCase();
  }

  const match = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]+([^?#]*)/i.exec(record.url);
  return (match?.[1] ?? "").toLowerCase();
}

function is_redacted_host(host: string): boolean {
  return /\[redacted/.test(host);
}

function is_local_host(host: string): boolean {
  return (
    host === "localhost" ||
    host === "::1" ||
    host.startsWith("127.") ||
    host.startsWith("0.0.0.0")
  );
}
