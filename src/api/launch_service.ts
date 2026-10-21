import { ImportError, parse_campaign_id } from "./import_contract.js";

export const MAX_LAUNCH_BYTES = 4096;
export type RunMode = "production" | "deep-debug";
export interface LaunchCampaignRequest { runMode?: RunMode }
export interface LaunchCampaignResponse {
  campaignId: number;
  runNumber: number;
  runMode: RunMode;
  status: "queued" | "running";
}
export interface LaunchRepository {
  enqueue(campaignId: number, runMode: RunMode): Promise<LaunchCampaignResponse>;
}
export function parseLaunchJson(bytes: Uint8Array): unknown {
  if (bytes.byteLength > MAX_LAUNCH_BYTES) throw new ImportError(413, "REQUEST_TOO_LARGE", "The launch request exceeds 4 KiB.");
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown; }
  catch { throw new ImportError(400, "INVALID_REQUEST", "Send valid UTF-8 JSON."); }
}
export function validateLaunchCampaign(input: unknown): RunMode {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ImportError(400, "INVALID_REQUEST", "Send a launch JSON object.");
  }
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some(key => key !== "runMode") ||
      (Object.hasOwn(value, "runMode") && value.runMode !== "production" && value.runMode !== "deep-debug")) {
    throw new ImportError(400, "INVALID_REQUEST", "Use production or deep-debug as runMode.");
  }
  return (value.runMode as RunMode | undefined) ?? "production";
}
export async function launchCampaign(campaignId: number, input: unknown,
  repository: LaunchRepository): Promise<LaunchCampaignResponse> {
  parse_campaign_id(String(campaignId));
  return repository.enqueue(campaignId, validateLaunchCampaign(input));
}
