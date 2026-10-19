import type { Pool, RowDataPacket } from "mysql2/promise";
import { ImportError, type WebsiteImportEntry } from "./import_contract.js";
import type { WebsiteImportRepository } from "./csv_import_service.js";

interface WebsiteRow extends RowDataPacket { normalized_domain: string; campaign_id: number | string }

export class MysqlWebsiteImportRepository implements WebsiteImportRepository {
  constructor(private readonly pool: Pick<Pool, "getConnection">) {}

  async save(campaignId: number, entries: WebsiteImportEntry[]) {
    const connection = await this.pool.getConnection();
    let reusable = true;
    try {
      await connection.beginTransaction();
      // Serializes imports for this campaign without changing its data.
      const [campaigns] = await connection.execute<RowDataPacket[]>(
        "SELECT campaign_id FROM OUTREACH_campaigns WHERE campaign_id = ? FOR UPDATE", [campaignId]);
      if (!campaigns.length) throw new ImportError(404, "CAMPAIGN_NOT_FOUND", "The campaign does not exist.");
      const ordered = [...entries].sort((a, b) => a.normalizedDomain.localeCompare(b.normalizedDomain));
      const placeholders = ordered.map(() => "?").join(",");
      const [existing] = await connection.execute<WebsiteRow[]>(
        `SELECT normalized_domain, campaign_id FROM OUTREACH_websites
         WHERE normalized_domain IN (${placeholders}) FOR UPDATE`,
        ordered.map(entry => entry.normalizedDomain));
      const conflicts = new Set(existing.filter(row => String(row.campaign_id) !== String(campaignId))
        .map(row => row.normalized_domain));
      if (conflicts.size) throw new ImportError(409, "DOMAIN_CONFLICT",
        "A website belongs to another campaign.",
        entries.filter(entry => conflicts.has(entry.normalizedDomain))
          .map(entry => ({ row: entry.row, code: "DOMAIN_CONFLICT" })));
      const domains = new Set(existing.map(row => row.normalized_domain));
      const additions = ordered.filter(entry => !domains.has(entry.normalizedDomain));
      // Bound each SQL packet. All batches remain in the same transaction.
      for (let offset = 0; offset < additions.length; offset += 250) {
        const batch = additions.slice(offset, offset + 250);
        await connection.execute(
          `INSERT INTO OUTREACH_websites (campaign_id, normalized_domain, original_input_url)
           VALUES ${batch.map(() => "(?,?,?)").join(",")}`,
          batch.flatMap(entry => [campaignId, entry.normalizedDomain, entry.originalInputUrl]));
      }
      await connection.commit();
      return { imported: additions.length, alreadyInCampaign: existing.length };
    } catch (error) {
      try { await connection.rollback(); }
      catch {
        // Never return a connection with an uncertain transaction to the pool.
        reusable = false;
        connection.destroy();
      }
      if (error instanceof ImportError) throw error;
      const code = (error as { code?: string } | null)?.code;
      if (["ER_DUP_ENTRY", "ER_LOCK_DEADLOCK", "ER_LOCK_WAIT_TIMEOUT"].includes(code ?? "")) {
        throw new ImportError(409, "IMPORT_CONFLICT", "The import conflicted with another database operation.");
      }
      throw new ImportError(500, "DATABASE_ERROR", "The import could not be saved.");
    } finally { if (reusable) connection.release(); }
  }
}
