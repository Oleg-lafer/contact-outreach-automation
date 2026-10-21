CREATE TABLE IF NOT EXISTS `OUTREACH_runs` (
  `run_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `campaign_id` BIGINT UNSIGNED NOT NULL,
  `run_mode` ENUM('production', 'deep-debug') NOT NULL,
  `state` ENUM('queued', 'running', 'completed', 'failed') NOT NULL DEFAULT 'queued',
  `website_id_upper_bound` BIGINT UNSIGNED NOT NULL,
  `created_time` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `started_time` DATETIME(3) NULL,
  `heartbeat_time` DATETIME(3) NULL,
  `completed_time` DATETIME(3) NULL,
  `failure_code` VARCHAR(64) NULL,
  `summary` JSON NULL,
  `active_campaign_id` BIGINT UNSIGNED GENERATED ALWAYS AS
    (CASE WHEN `state` IN ('queued', 'running') THEN `campaign_id` ELSE NULL END) STORED,
  PRIMARY KEY (`run_id`),
  UNIQUE KEY `uq_outreach_active_campaign` (`active_campaign_id`),
  KEY `idx_outreach_run_queue` (`state`, `run_id`),
  CONSTRAINT `fk_outreach_run_campaign` FOREIGN KEY (`campaign_id`)
    REFERENCES `OUTREACH_campaigns` (`campaign_id`) ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB;

-- The migration runner checks metadata before adding each column/index/constraint.
