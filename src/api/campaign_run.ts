import type { RunMode } from "./launch_service.js";

export type RunState = "queued" | "running" | "completed" | "failed";
export interface RunIdentity { campaignId: number; runNumber: number }
export interface CampaignRun {
  runNumber: number;
  state: RunState;
  runMode: RunMode;
  requestedTime: string;
  startedTime: string | null;
  heartbeatTime: string | null;
  completedTime: string | null;
  websiteIdUpperBound: number;
  failureCode: string | null;
  summary: unknown;
  legacyRunId?: number;
}
export function safe_run_number(value: unknown, allowZero = false): number {
  const parsed = typeof value === "number" || typeof value === "string" ? Number(value) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < (allowZero ? 0 : 1)) throw new Error("Invalid stored run number.");
  return parsed;
}
export function json_value(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) as unknown : value;
}
export function run_history(value: unknown): CampaignRun[] {
  const parsed = json_value(value);
  if (parsed === null || parsed === undefined) return [];
  if (!Array.isArray(parsed)) throw new Error("Invalid stored run history.");
  return parsed.map(read_run);
}
export function read_run(value: unknown): CampaignRun {
  const parsed = json_value(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid stored campaign run.");
  const run = parsed as CampaignRun;
  safe_run_number(run.runNumber); safe_run_number(run.websiteIdUpperBound);
  if (!["queued", "running", "completed", "failed"].includes(run.state) ||
      !["production", "deep-debug"].includes(run.runMode) || typeof run.requestedTime !== "string") {
    throw new Error("Invalid stored campaign run.");
  }
  for (const time of [run.requestedTime, run.startedTime, run.heartbeatTime, run.completedTime]) {
    if (time !== null && (typeof time !== "string" || !time.endsWith("Z") || !Number.isFinite(Date.parse(time)))) {
      throw new Error("Invalid stored run timestamp.");
    }
  }
  if (run.failureCode !== null && typeof run.failureCode !== "string") throw new Error("Invalid stored run failure code.");
  return { ...run };
}
export function sql_utc_time(iso: string): string { return iso.replace("T", " ").replace("Z", ""); }
