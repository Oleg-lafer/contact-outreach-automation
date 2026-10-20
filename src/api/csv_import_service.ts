import { parse, CsvError } from "csv-parse/sync";
import { valid_website_url } from "./website_url.js";
import { normalize_outreach_domain } from "../contact_outreach_workflow/shared_files_orchestrator/website_identity_(Deterministic).js";
import { ImportError, MAX_CSV_BYTES, MAX_CSV_ROWS, parse_campaign_id,
  type ImportResult, type RowError, type WebsiteImportEntry } from "./import_contract.js";

export interface WebsiteImportRepository {
  save(campaignId: number, entries: WebsiteImportEntry[]): Promise<{
    imported: number; alreadyInCampaign: number;
  }>;
}
interface CsvRecord { record: string[]; info: { records: number } }

export function validate_csv(bytes: Uint8Array): {
  entries: WebsiteImportEntry[]; received: number; duplicatesInFile: number;
} {
  if (bytes.byteLength > MAX_CSV_BYTES) {
    throw new ImportError(413, "UPLOAD_TOO_LARGE", "The CSV exceeds 5 MiB.");
  }
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new ImportError(400, "INVALID_CSV", "The CSV must use UTF-8."); }
  let records: CsvRecord[];
  let nonEmptyRows = 0;
  try {
    records = parse(text, {
      bom: true, columns: false, info: true, relax_column_count: false,
      on_record: value => {
        // csv-parse's array overload does not model the info:true record wrapper.
        const item = value as unknown as CsvRecord;
        if (item.info.records > 1 && item.record.length === 1 && !item.record[0]?.trim()) return null;
        if (item.info.records > 1 && ++nonEmptyRows > MAX_CSV_ROWS) {
          throw new ImportError(413, "TOO_MANY_ROWS", "The CSV exceeds 10,000 data rows.");
        }
        return value;
      },
    }) as unknown as CsvRecord[];
  } catch (error) {
    if (error instanceof ImportError) throw error;
    const row = error instanceof CsvError ? Number(error.records ?? 0) + 1 : 1;
    throw new ImportError(400, "INVALID_CSV", "The CSV is malformed or has extra columns.",
      [{ row, code: "INVALID_CSV" }]);
  }
  const header = records[0];
  if (!header || header.record.length !== 1 || !header.record[0]?.trim()) {
    throw new ImportError(400, "INVALID_CSV", "A single-column header is required.");
  }
  const entries = new Map<string, WebsiteImportEntry>();
  const errors: RowError[] = [];
  let received = 0;
  for (const item of records.slice(1)) {
    received++;
    const row = item.info.records;
    const raw = item.record[0] ?? "";
    const value = raw.trim();
    try {
      // Inspect the raw field too: URL() and trim() silently remove some control characters.
      if (item.record.length !== 1 || /[\u0000-\u001f\u007f]/u.test(raw) ||
          !valid_website_url(value) ||
          [...value].length > 2048) throw new Error("invalid URL");
      const normalizedDomain = normalize_outreach_domain(value);
      if (normalizedDomain.length > 253) throw new Error("domain too long");
      if (!entries.has(normalizedDomain)) entries.set(normalizedDomain, {
        normalizedDomain, originalInputUrl: value, row,
      });
    } catch { errors.push({ row, code: "INVALID_URL" }); }
  }
  if (errors.length) {
    throw new ImportError(400, "INVALID_CSV", "The upload contains invalid rows.", errors);
  }
  if (!received) throw new ImportError(400, "INVALID_CSV", "The CSV contains no URLs.");
  return { entries: [...entries.values()], received, duplicatesInFile: received - entries.size };
}

export async function import_websites(campaignId: number, bytes: Uint8Array,
  repository: WebsiteImportRepository): Promise<ImportResult> {
  parse_campaign_id(String(campaignId));
  const validated = validate_csv(bytes);
  const saved = await repository.save(campaignId, validated.entries);
  return { campaignId, received: validated.received,
    duplicatesInFile: validated.duplicatesInFile, ...saved };
}
