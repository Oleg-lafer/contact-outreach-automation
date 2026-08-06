import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { ContactInputError, describe_error } from "../../shared_files_orchestrator/outreach_errors_(Support).js";
import type {
  ContactOutreachOutcome,
  ContactFillValues,
  ContactRequest,
  WebsiteRunEntry,
  WebsiteRunStatus,
  WebsiteDiscoveryState,
} from "../../shared_files_orchestrator/outreach_types_(Support).js";

/*
 * TOP LEVEL WORKFLOW:
 *
 * load_and_validate_contact_request(input_path)
 *        |
 *        v
 * read JSON input file
 *        |
 *        v
 * parse website list or legacy single-site object
 *        |
 *        v
 * load contact fill values
 */

/*
 * ========================================================================
 * TOP_LEVEL_WORKFLOW_FUNCTIONS
 * ========================================================================
 */

/*
 * ========================================================================
 * CONTACT INPUT PREPARATION - load_and_validate_contact_request(...)
 * ========================================================================
 * Input:  A path to a website list or legacy single-site JSON file.
 * Output: A validated website URL and contact fill values.
 *
 * Responsibility: Read, parse, and validate external input before browser
 * resources are created.
 * ========================================================================
 */
export async function load_and_validate_contact_request(
  input_path: string,
  contact_values_path?: string,
): Promise<ContactRequest> {
  const absolute_input_path = resolve(input_path);
  const resolved_contact_values_path =
    contact_values_path ?? default_contact_values_path_for_input(input_path);
  const input = await read_json_file(input_path, "input file");

  if (!is_record(input)) {
    throw new ContactInputError("Input JSON must contain an object");
  }

  if (Array.isArray(input.websites)) {
    const selected_website = select_next_website(input.websites);
    const fill_values = await load_and_validate_contact_values(
      resolved_contact_values_path,
    );

    return {
      websiteUrl: validate_website_url(selected_website.entry.websiteUrl),
      ...fill_values,
      inputSource: {
        websiteListPath: absolute_input_path,
        websiteIndex: selected_website.index,
      },
    };
  }

  const website_url =
    typeof input.websiteUrl === "string" ? input.websiteUrl.trim() : "";
  if (!website_url) {
    throw new ContactInputError("Input JSON must contain a non-empty websiteUrl");
  }

  const fill_values = has_embedded_contact_values(input)
    ? validate_contact_values(input, website_url, "Input JSON")
    : await load_and_validate_contact_values(
        resolved_contact_values_path,
        website_url,
      );

  return {
    websiteUrl: validate_website_url(website_url),
    ...fill_values,
  };
}

export async function update_website_run_status(
  contact_request: ContactRequest | undefined,
  outcome: ContactOutreachOutcome,
): Promise<void> {
  const input_source = contact_request?.inputSource;
  if (!input_source) {
    return;
  }

  const input = await read_json_file(input_source.websiteListPath, "website list");
  if (!is_record(input) || !Array.isArray(input.websites)) {
    throw new ContactInputError("Website list JSON must contain a websites array");
  }

  const website_entry = input.websites[input_source.websiteIndex];
  if (!is_record(website_entry)) {
    throw new ContactInputError("Selected website list entry is missing");
  }

  website_entry.status = website_status_from_outcome(outcome);
  website_entry.statusDescription = website_status_description_from_outcome(outcome);
  if (outcome.channels.forms.discovery) {
    website_entry.discovery = outcome.channels.forms.discovery;
  }

  await writeFile(
    input_source.websiteListPath,
    `${JSON.stringify(input, null, 2)}\n`,
    "utf8",
  );
}

/*
 * ========================================================================
 * STEP_LEVEL_HELPER_FUNCTIONS
 * ========================================================================
 *
 * read_json_file(...)                 - Read and parse JSON with clear errors.
 * load_and_validate_contact_values(...) - Load reusable sender/message values.
 * select_next_website(...)            - Pick the next non-succeeded website.
 * validate_website_url(...)           - Normalize HTTP(S) website URLs.
 * ========================================================================
 */

async function read_json_file(path: string, label: string): Promise<unknown> {
  let file_contents: string;

  try {
    file_contents = await readFile(resolve(path), "utf8");
  } catch (error) {
    throw new ContactInputError(
      `Cannot read ${label} "${path}": ${describe_error(error)}`,
    );
  }

  let input: unknown;
  try {
    input = JSON.parse(strip_utf8_bom(file_contents));
  } catch {
    throw new ContactInputError(`${label} "${path}" is not valid JSON`);
  }

  return input;
}

function strip_utf8_bom(file_contents: string): string {
  return file_contents.charCodeAt(0) === 0xfeff
    ? file_contents.slice(1)
    : file_contents;
}

function default_contact_values_path_for_input(input_path: string): string {
  return join(dirname(input_path), "contact-values.json");
}

async function load_and_validate_contact_values(
  contact_values_path: string,
  website_url = "(unknown)",
): Promise<ContactFillValues> {
  const input = await read_json_file(contact_values_path, "contact values file");
  if (!is_record(input)) {
    throw new ContactInputError("Contact values JSON must contain an object");
  }

  return validate_contact_values(input, website_url, "Contact values JSON");
}

function validate_contact_values(
  input: Record<string, unknown>,
  website_url: string,
  label: string,
): ContactFillValues {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const email = typeof input.email === "string" ? input.email.trim() : "";
  const phone = typeof input.phone === "string" ? input.phone.trim() : "";
  const message = typeof input.message === "string" ? input.message.trim() : "";
  const company = optional_contact_value(input, "company", label, website_url);
  const role = optional_contact_value(input, "role", label, website_url);
  const website = optional_contact_value(input, "website", label, website_url);
  const country = optional_contact_value(input, "country", label, website_url);

  if (!name) {
    throw new ContactInputError(
      `${label} must contain a non-empty name`,
      website_url,
    );
  }
  if (!email) {
    throw new ContactInputError(
      `${label} must contain a non-empty email`,
      website_url,
    );
  }
  if (!phone) {
    throw new ContactInputError(
      `${label} must contain a non-empty phone`,
      website_url,
    );
  }
  if (!message) {
    throw new ContactInputError(
      `${label} must contain a non-empty message`,
      website_url,
    );
  }

  return {
    name,
    email,
    phone,
    message,
    ...(company ? { company } : {}),
    ...(role ? { role } : {}),
    ...(website ? { website } : {}),
    ...(country ? { country } : {}),
  };
}

function optional_contact_value(
  input: Record<string, unknown>,
  field: "company" | "role" | "website" | "country",
  label: string,
  website_url: string,
): string | undefined {
  const value = input[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new ContactInputError(
      `${label} ${field} must be a non-empty string when provided`,
      website_url,
    );
  }
  return value.trim();
}

function select_next_website(
  raw_websites: unknown[],
): { entry: WebsiteRunEntry; index: number } {
  if (raw_websites.length === 0) {
    throw new ContactInputError("Website list must contain at least one website");
  }

  const websites = raw_websites.map(validate_website_entry);
  const index = websites.findIndex((entry) => entry.status !== "succeeded");
  if (index === -1) {
    throw new ContactInputError("Website list has no non-succeeded website to run");
  }

  return { entry: websites[index] as WebsiteRunEntry, index };
}

function validate_website_entry(value: unknown): WebsiteRunEntry {
  if (!is_record(value)) {
    throw new ContactInputError("Website list entries must be objects");
  }

  const website_url =
    typeof value.websiteUrl === "string" ? value.websiteUrl.trim() : "";
  if (!website_url) {
    throw new ContactInputError(
      "Website list entry must contain a non-empty websiteUrl",
    );
  }

  const status = normalize_website_status(value.status);
  const status_description =
    typeof value.statusDescription === "string"
      ? value.statusDescription.trim()
      : "";

  return {
    websiteUrl: validate_website_url(website_url),
    status,
    statusDescription: status_description,
    ...(value.discovery !== undefined
      ? { discovery: validate_discovery_state(value.discovery) }
      : {}),
  };
}

function validate_discovery_state(value: unknown): WebsiteDiscoveryState {
  if (!is_record(value)) {
    throw new ContactInputError("Website discovery state must be an object");
  }
  const assessments = new Set([
    "confirmed_form_present",
    "strong_form_evidence",
    "possible_form_evidence",
    "contact_channel_without_form",
    "no_form_observed_after_complete_search",
    "no_form_observed_after_limited_search",
    "site_inspection_blocked",
  ]);
  const strengths = new Set(["strong", "moderate", "weak", "none"]);
  const coverages = new Set(["complete", "partial", "blocked"]);
  if (!assessments.has(String(value.assessment))) {
    throw new ContactInputError("Website discovery assessment is invalid");
  }
  if (!strengths.has(String(value.presenceEvidenceStrength))) {
    throw new ContactInputError("Website discovery evidence strength is invalid");
  }
  if (!coverages.has(String(value.searchCoverage))) {
    throw new ContactInputError("Website discovery search coverage is invalid");
  }
  if (typeof value.description !== "string" || !value.description.trim()) {
    throw new ContactInputError("Website discovery description must be non-empty");
  }
  if (typeof value.assessedAt !== "string" || Number.isNaN(Date.parse(value.assessedAt))) {
    throw new ContactInputError("Website discovery assessedAt must be an ISO timestamp");
  }
  return {
    assessment: value.assessment as WebsiteDiscoveryState["assessment"],
    presenceEvidenceStrength:
      value.presenceEvidenceStrength as WebsiteDiscoveryState["presenceEvidenceStrength"],
    searchCoverage: value.searchCoverage as WebsiteDiscoveryState["searchCoverage"],
    description: value.description.trim(),
    assessedAt: value.assessedAt,
  };
}

function normalize_website_status(value: unknown): WebsiteRunStatus {
  if (value === undefined || value === "") {
    return "pending";
  }
  if (value === "pending" || value === "succeeded" || value === "failed") {
    return value;
  }
  throw new ContactInputError(
    "Website list status must be pending, succeeded, or failed",
  );
}

function validate_website_url(website_url: string): string {
  let parsed_url: URL;
  try {
    parsed_url = new URL(website_url);
  } catch {
    throw new ContactInputError("websiteUrl must be a valid URL", website_url);
  }

  if (!["http:", "https:"].includes(parsed_url.protocol)) {
    throw new ContactInputError(
      "websiteUrl must use HTTP or HTTPS",
      website_url,
    );
  }

  return parsed_url.toString();
}

function has_embedded_contact_values(input: Record<string, unknown>): boolean {
  return (
    input.name !== undefined ||
    input.email !== undefined ||
    input.phone !== undefined ||
    input.message !== undefined ||
    input.company !== undefined ||
    input.role !== undefined ||
    input.website !== undefined ||
    input.country !== undefined
  );
}

function website_status_from_outcome(
  outcome: ContactOutreachOutcome,
): WebsiteRunStatus {
  return outcome.status === "SUCCESS" ||
    outcome.failureKind === "outreach.resend_prevented"
    ? "succeeded"
    : "failed";
}

function website_status_description_from_outcome(
  outcome: ContactOutreachOutcome,
): string {
  if (outcome.reason) {
    return outcome.reason;
  }
  return outcome.status === "SUCCESS"
    ? "Submission confirmed"
    : "Submission was not confirmed";
}

function is_record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
