import { z } from "zod";
import { ImportError } from "./import_contract.js";
import { replace_unpaired_surrogates } from "../contact_outreach_workflow/shared_files_orchestrator/unicode_text_(Support).js";
import { valid_website_url } from "./website_url.js";

export const MAX_CAMPAIGN_BYTES = 256 * 1024;
export const MAX_MESSAGE_BYTES = 65_535;
export interface CreateCampaignRequest {
  campaignName: string;
  sender: {
    firstName: string;
    lastName: string;
    email: string;
    companyName: string;
    phoneNumber: string;
    companyWebsiteUrl?: string;
    countryOfOrigin?: string;
    companyIndustry?: string;
  };
  outreachMessage: string;
}
export interface CreateCampaignResponse { campaignId: number }
export interface CampaignRepository {
  insertCampaign(campaign: CreateCampaignRequest): Promise<number>;
}
export interface FieldError { field: string; code: string }
export class CampaignValidationError extends ImportError {
  constructor(public readonly fields: FieldError[]) {
    super(400, "INVALID_CAMPAIGN", "Check the campaign fields.");
  }
  override toJSON(): object {
    return { error: { code: this.code, message: this.message, fields: this.fields } };
  }
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validateCreateCampaign(input: unknown): CreateCampaignRequest {
  if (!record(input)) throw new ImportError(400, "INVALID_REQUEST", "Send a JSON object.");
  const errors: FieldError[] = [];
  const add = (field: string, code: string) => errors.push({ field, code });
  function keys(value: Record<string, unknown>, allowed: string[], field: string): void {
    // Do not echo arbitrary property names from requests into errors.
    if (Object.keys(value).some(key => !allowed.includes(key))) add(field, "UNKNOWN_FIELD");
  }
  function string(value: unknown, field: string, optional = false): string | undefined {
    if (value === undefined) {
      if (!optional) add(field, "REQUIRED");
      return undefined;
    }
    if (typeof value !== "string") { add(field, "INVALID_TYPE"); return undefined; }
    if (replace_unpaired_surrogates(value) !== value) { add(field, "INVALID_UNICODE"); return undefined; }
    if (!value.trim()) {
      if (!optional) add(field, "REQUIRED");
      return undefined;
    }
    return value;
  }
  keys(input, ["campaignName", "sender", "outreachMessage"], "$");
  const campaignName = string(input.campaignName, "campaignName");
  if (campaignName && [...campaignName].length > 255) add("campaignName", "TOO_LONG");
  const outreachMessage = string(input.outreachMessage, "outreachMessage");
  if (outreachMessage && Buffer.byteLength(outreachMessage, "utf8") > MAX_MESSAGE_BYTES) add("outreachMessage", "TOO_LONG");
  let sender: CreateCampaignRequest["sender"] | undefined;
  if (!record(input.sender)) add("sender", input.sender === undefined ? "REQUIRED" : "INVALID_TYPE");
  else {
    keys(input.sender, ["firstName", "lastName", "email", "companyName", "phoneNumber",
      "companyWebsiteUrl", "countryOfOrigin", "companyIndustry"], "sender");
    const firstName = string(input.sender.firstName, "sender.firstName");
    const lastName = string(input.sender.lastName, "sender.lastName");
    const email = string(input.sender.email, "sender.email");
    const companyName = string(input.sender.companyName, "sender.companyName");
    const phoneNumber = string(input.sender.phoneNumber, "sender.phoneNumber");
    const companyWebsiteUrl = string(input.sender.companyWebsiteUrl, "sender.companyWebsiteUrl", true);
    const countryOfOrigin = string(input.sender.countryOfOrigin, "sender.countryOfOrigin", true);
    const companyIndustry = string(input.sender.companyIndustry, "sender.companyIndustry", true);
    if (email && !z.email().safeParse(email).success) add("sender.email", "INVALID_EMAIL");
    if (companyWebsiteUrl && !valid_website_url(companyWebsiteUrl)) add("sender.companyWebsiteUrl", "INVALID_URL");
    if (firstName && lastName && email && companyName && phoneNumber) {
      sender = { firstName, lastName, email, companyName, phoneNumber,
        ...(companyWebsiteUrl === undefined ? {} : { companyWebsiteUrl }),
        ...(countryOfOrigin === undefined ? {} : { countryOfOrigin }),
        ...(companyIndustry === undefined ? {} : { companyIndustry }) };
    }
  }
  if (errors.length) throw new CampaignValidationError(errors);
  return { campaignName: campaignName!, sender: sender!, outreachMessage: outreachMessage! };
}

export function parseCampaignJson(bytes: Uint8Array): unknown {
  if (bytes.byteLength > MAX_CAMPAIGN_BYTES) throw new ImportError(413, "REQUEST_TOO_LARGE", "The JSON request exceeds 256 KiB.");
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown; }
  catch { throw new ImportError(400, "INVALID_REQUEST", "Send valid UTF-8 JSON."); }
}

export function campaignSenderDetails(campaign: CreateCampaignRequest) {
  const sender = campaign.sender;
  return {
    firstName: sender.firstName, lastName: sender.lastName,
    name: `${sender.firstName.trim()} ${sender.lastName.trim()}`,
    email: sender.email, company: sender.companyName, phone: sender.phoneNumber,
    website: sender.companyWebsiteUrl ?? "", country: sender.countryOfOrigin ?? "",
    ...(sender.companyIndustry === undefined ? {} : { industry: sender.companyIndustry }),
  };
}

export async function createCampaign(input: unknown, repository: CampaignRepository): Promise<CreateCampaignResponse> {
  const campaign = validateCreateCampaign(input);
  return { campaignId: await repository.insertCampaign(campaign) };
}
