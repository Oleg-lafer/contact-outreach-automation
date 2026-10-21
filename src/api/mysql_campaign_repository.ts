import type { Pool, ResultSetHeader } from "mysql2/promise";
import { ImportError, parse_campaign_id } from "./import_contract.js";
import { campaignSenderDetails, type CampaignRepository, type CreateCampaignRequest } from "./campaign_service.js";

export class MysqlCampaignRepository implements CampaignRepository {
  constructor(private readonly pool: Pick<Pool, "getConnection">) {}

  async insertCampaign(campaign: CreateCampaignRequest): Promise<number> {
    const connection = await this.pool.getConnection().catch(() => {
      throw new ImportError(500, "DATABASE_ERROR", "The campaign could not be saved.");
    });
    let reusable = true;
    try {
      await connection.beginTransaction();
      const [result] = await connection.execute<ResultSetHeader>(
        `INSERT INTO OUTREACH_campaigns (campaign_name, sender_details, message_to_send)
         VALUES (?, ?, ?)`,
        [campaign.campaignName, JSON.stringify(campaignSenderDetails(campaign)), campaign.outreachMessage]);
      // Validate before commit, including BIGINT values represented as strings by mysql2.
      const campaignId = parse_campaign_id(String(result.insertId));
      await connection.commit();
      return campaignId;
    } catch {
      try { await connection.rollback(); }
      catch { reusable = false; connection.destroy(); }
      throw new ImportError(500, "DATABASE_ERROR", "The campaign could not be saved.");
    } finally { if (reusable) connection.release(); }
  }
}
