CREATE TABLE IF NOT EXISTS `OUTREACH_campaigns` (
  `campaign_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `campaign_name` VARCHAR(255) NOT NULL,
  `sender_details` JSON NOT NULL,
  `message_to_send` TEXT NOT NULL,
  `prevent_resend` BOOLEAN NOT NULL DEFAULT TRUE,
  `created_time` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`campaign_id`)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS `OUTREACH_websites` (
  `website_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `campaign_id` BIGINT UNSIGNED NOT NULL,
  `normalized_domain` VARCHAR(253) NOT NULL,
  `original_input_url` VARCHAR(2048) NOT NULL,
  `created_time` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`website_id`),
  UNIQUE KEY `uq_outreach_websites_normalized_domain` (`normalized_domain`),
  KEY `idx_outreach_websites_campaign` (`campaign_id`),
  CONSTRAINT `fk_outreach_website_campaign`
    FOREIGN KEY (`campaign_id`)
    REFERENCES `OUTREACH_campaigns` (`campaign_id`)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS `OUTREACH_attempts` (
  `attempt_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `website_id` BIGINT UNSIGNED NOT NULL,
  `execution_status` ENUM(
    'queued',
    'running',
    'finished',
    'run_failed',
    'skipped'
  ) NOT NULL DEFAULT 'queued',
  `forms_result` ENUM('success', 'partial', 'inconclusive', 'failed') NULL,
  `email_discovery_result` ENUM('success', 'partial', 'inconclusive', 'failed') NULL,
  `meeting_discovery_result` ENUM('success', 'partial', 'inconclusive', 'failed') NULL,
  `outcome_reason` TEXT NULL,
  `channel_outcomes` JSON NULL,
  `created_time` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `started_time` DATETIME(3) NULL,
  `completed_time` DATETIME(3) NULL,
  PRIMARY KEY (`attempt_id`),
  KEY `idx_outreach_attempt_resend_lookup` (
    `website_id`,
    `forms_result`
  ),
  CONSTRAINT `fk_outreach_attempt_website`
    FOREIGN KEY (`website_id`)
    REFERENCES `OUTREACH_websites` (`website_id`)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  CONSTRAINT `chk_outreach_attempt_completed_time`
    CHECK (
      (`execution_status` IN ('queued', 'running') AND `completed_time` IS NULL)
      OR
      (`execution_status` IN ('finished', 'run_failed', 'skipped') AND `completed_time` IS NOT NULL)
    )
) ENGINE=InnoDB;
