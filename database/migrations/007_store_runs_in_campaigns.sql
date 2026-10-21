-- Applied one statement at a time after metadata checks by migrate_campaign_run_storage.ts.
-- Data conversion and verification precede removal of the historical 006 schema.
ALTER TABLE `OUTREACH_campaigns` ADD COLUMN `run_sequence` BIGINT UNSIGNED NOT NULL DEFAULT 0;
ALTER TABLE `OUTREACH_campaigns` ADD COLUMN `run_state` ENUM('queued','running','completed','failed') NULL DEFAULT NULL;
ALTER TABLE `OUTREACH_campaigns` ADD COLUMN `run_requested_time` DATETIME(3) NULL DEFAULT NULL;
ALTER TABLE `OUTREACH_campaigns` ADD COLUMN `current_run` JSON NULL;
ALTER TABLE `OUTREACH_campaigns` ADD COLUMN `run_history` JSON NULL;
ALTER TABLE `OUTREACH_campaigns` ADD INDEX `idx_outreach_campaign_run_queue` (`run_state`, `run_requested_time`, `campaign_id`);
ALTER TABLE `OUTREACH_attempts` ADD COLUMN `run_number` BIGINT UNSIGNED NULL DEFAULT NULL;
ALTER TABLE `OUTREACH_attempts` ADD INDEX `idx_outreach_attempt_run_number` (`run_number`, `execution_status`, `website_id`);
