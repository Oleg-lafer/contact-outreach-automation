export const MAX_CSV_BYTES = 5 * 1024 * 1024;
export const MAX_CSV_ROWS = 10_000;
export const MAX_CAMPAIGN_ID = Number.MAX_SAFE_INTEGER;

export interface RowError { row: number; code: string }
export class ImportError extends Error {
  constructor(public readonly status: number, public readonly code: string,
    message: string, public readonly rows?: RowError[]) { super(message); }
  toJSON(): object {
    return { error: { code: this.code, message: this.message,
      ...(this.rows ? { rows: this.rows } : {}) } };
  }
}
export interface WebsiteImportEntry {
  normalizedDomain: string;
  originalInputUrl: string;
  row: number;
}
export interface ImportResult {
  campaignId: number;
  received: number;
  imported: number;
  duplicatesInFile: number;
  alreadyInCampaign: number;
}
export function parse_campaign_id(value: string): number {
  const id = Number(value);
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(id)) {
    throw new ImportError(400, "INVALID_REQUEST", "CampaignId must be a positive safe integer.");
  }
  return id;
}
