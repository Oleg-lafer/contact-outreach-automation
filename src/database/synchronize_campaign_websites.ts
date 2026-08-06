import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { pathToFileURL } from "node:url";
import mysql, { type ResultSetHeader, type RowDataPacket } from "mysql2/promise";
import { database_config_from_environment } from "../contact_outreach_workflow/shared_files_orchestrator/outreach_database_(Integration).js";
import { normalize_outreach_domain } from "../contact_outreach_workflow/shared_files_orchestrator/website_identity_(Deterministic).js";

export interface CampaignWebsiteSyncEntry {
  normalizedDomain: string;
  originalInputUrl: string;
  historicalSuccess: boolean;
}

interface WebsiteRow extends RowDataPacket {
  website_id: number;
  normalized_domain: string;
}

interface CountRow extends RowDataPacket { row_count: number }

export function campaign_website_sync_entries(
  value: unknown,
): CampaignWebsiteSyncEntry[] {
  if (!is_record(value) || !Array.isArray(value.websites)) {
    throw new Error("Campaign website source must contain a websites array.");
  }
  const entries = new Map<string, CampaignWebsiteSyncEntry>();
  for (const [index, raw] of value.websites.entries()) {
    if (!is_record(raw)) throw new Error(`Website entry ${index} must be an object.`);
    const websiteUrl = required_string(raw.websiteUrl, `website entry ${index} websiteUrl`);
    const normalizedDomain = normalize_outreach_domain(websiteUrl);
    const historicalSuccess = raw.status === "succeeded";
    const existing = entries.get(normalizedDomain);
    if (existing) {
      existing.historicalSuccess ||= historicalSuccess;
    } else {
      entries.set(normalizedDomain, {
        normalizedDomain,
        originalInputUrl: websiteUrl,
        historicalSuccess,
      });
    }
  }
  return [...entries.values()].sort((left, right) =>
    left.normalizedDomain.localeCompare(right.normalizedDomain),
  );
}

async function main(): Promise<void> {
  loadEnvFile(resolve(".env"));
  const campaignId = Number(process.argv[2]);
  const sourcePath = process.argv[3];
  const apply = process.argv.includes("--apply");
  if (!Number.isSafeInteger(campaignId) || campaignId <= 0) {
    throw new Error("Campaign ID must be a positive integer.");
  }
  if (!sourcePath) throw new Error("Campaign website source path is required.");
  const source: unknown = JSON.parse(
    (await readFile(resolve(sourcePath), "utf8")).replace(/^\uFEFF/, ""),
  );
  const desired = campaign_website_sync_entries(source);
  if (desired.length === 0) throw new Error("Campaign website source is empty.");
  const connection = await mysql.createConnection(
    database_config_from_environment(process.env),
  );
  try {
    await connection.beginTransaction();
    const [campaignRows] = await connection.execute<RowDataPacket[]>(
      "SELECT campaign_id FROM OUTREACH_campaigns WHERE campaign_id = ? FOR UPDATE",
      [campaignId],
    );
    if (!campaignRows[0]) throw new Error(`Campaign ${campaignId} does not exist.`);
    const [attemptRows] = await connection.execute<CountRow[]>(
      `SELECT COUNT(*) AS row_count
       FROM OUTREACH_attempts AS attempt
       JOIN OUTREACH_websites AS website ON website.website_id = attempt.website_id
       WHERE website.campaign_id = ?`,
      [campaignId],
    );
    const currentAttempts = Number(attemptRows[0]?.row_count ?? 0);
    if (apply && currentAttempts !== 0) {
      throw new Error(
        `Campaign ${campaignId} has ${currentAttempts} attempts; refusing destructive synchronization.`,
      );
    }
    const [currentRows] = await connection.execute<WebsiteRow[]>(
      `SELECT website_id, normalized_domain
       FROM OUTREACH_websites WHERE campaign_id = ? FOR UPDATE`,
      [campaignId],
    );
    const desiredDomains = desired.map((entry) => entry.normalizedDomain);
    const placeholders = desiredDomains.map(() => "?").join(", ");
    const [conflicts] = await connection.execute<WebsiteRow[]>(
      `SELECT website_id, normalized_domain FROM OUTREACH_websites
       WHERE campaign_id <> ? AND normalized_domain IN (${placeholders})`,
      [campaignId, ...desiredDomains],
    );
    if (conflicts.length > 0) {
      throw new Error(`${conflicts.length} desired domains belong to another campaign.`);
    }
    const desiredSet = new Set(desiredDomains);
    const deleteCount = currentRows.filter(
      (row) => !desiredSet.has(row.normalized_domain),
    ).length;
    const currentSet = new Set(currentRows.map((row) => row.normalized_domain));
    const insertCount = desired.filter(
      (entry) => !currentSet.has(entry.normalizedDomain),
    ).length;
    const historicalSuccessCount = desired.filter(
      (entry) => entry.historicalSuccess,
    ).length;

    if (apply) {
      await connection.execute(
        `DELETE FROM OUTREACH_websites
         WHERE campaign_id = ? AND normalized_domain NOT IN (${placeholders})`,
        [campaignId, ...desiredDomains],
      );
      const values = desired.map(() => "(?, ?, ?)").join(", ");
      await connection.execute(
        `INSERT INTO OUTREACH_websites
           (campaign_id, normalized_domain, original_input_url)
         VALUES ${values}
         ON DUPLICATE KEY UPDATE
           original_input_url = VALUES(original_input_url),
           campaign_id = IF(campaign_id = VALUES(campaign_id), campaign_id, NULL)`,
        desired.flatMap((entry) => [
          campaignId,
          entry.normalizedDomain,
          entry.originalInputUrl,
        ]),
      );
      const successDomains = desired
        .filter((entry) => entry.historicalSuccess)
        .map((entry) => entry.normalizedDomain);
      if (successDomains.length > 0) {
        const successPlaceholders = successDomains.map(() => "?").join(", ");
        await connection.execute(
          `INSERT INTO OUTREACH_attempts
             (website_id, execution_status, forms_result, outcome_reason,
              started_time, completed_time)
           SELECT website_id, 'finished', 'success',
                  'Imported confirmed Alumni campaign success.',
                  CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)
           FROM OUTREACH_websites
           WHERE campaign_id = ? AND normalized_domain IN (${successPlaceholders})`,
          [campaignId, ...successDomains],
        );
      }
      const [finalWebsiteRows] = await connection.execute<CountRow[]>(
        "SELECT COUNT(*) AS row_count FROM OUTREACH_websites WHERE campaign_id = ?",
        [campaignId],
      );
      const [finalAttemptRows] = await connection.execute<CountRow[]>(
        `SELECT COUNT(*) AS row_count FROM OUTREACH_attempts AS attempt
         JOIN OUTREACH_websites AS website ON website.website_id = attempt.website_id
         WHERE website.campaign_id = ?`,
        [campaignId],
      );
      if (Number(finalWebsiteRows[0]?.row_count) !== desired.length ||
          Number(finalAttemptRows[0]?.row_count) !== historicalSuccessCount) {
        throw new Error("Campaign synchronization count verification failed.");
      }
      await connection.commit();
    } else {
      await connection.rollback();
    }
    console.log(JSON.stringify({
      action: apply ? "applied" : "preview",
      campaignId,
      currentWebsites: currentRows.length,
      desiredWebsites: desired.length,
      websitesToDelete: deleteCount,
      websitesToInsert: insertCount,
      historicalSuccessesToRestore: historicalSuccessCount,
      currentAttempts,
    }, null, 2));
  } catch (error) {
    await connection.rollback().catch(() => undefined);
    throw error;
  } finally {
    await connection.end();
  }
}

function required_string(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return value.trim();
}

function is_record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const executedFileUrl = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : undefined;
if (executedFileUrl === import.meta.url) await main();
