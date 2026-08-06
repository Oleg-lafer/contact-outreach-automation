ALTER TABLE `OUTREACH_websites`
  ADD COLUMN `campaign_id` BIGINT UNSIGNED NULL AFTER `website_id`;

UPDATE `OUTREACH_websites` AS website
JOIN (
  SELECT `website_id`, MIN(`campaign_id`) AS `campaign_id`
  FROM `OUTREACH_attempts`
  GROUP BY `website_id`
  HAVING COUNT(DISTINCT `campaign_id`) = 1
) AS ownership ON ownership.website_id = website.website_id
SET website.campaign_id = ownership.campaign_id;

ALTER TABLE `OUTREACH_websites`
  MODIFY COLUMN `campaign_id` BIGINT UNSIGNED NOT NULL,
  ADD KEY `idx_outreach_websites_campaign` (`campaign_id`),
  ADD CONSTRAINT `fk_outreach_website_campaign`
    FOREIGN KEY (`campaign_id`)
    REFERENCES `OUTREACH_campaigns` (`campaign_id`)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT;

ALTER TABLE `OUTREACH_attempts`
  DROP FOREIGN KEY `fk_outreach_attempt_campaign`,
  DROP INDEX `idx_outreach_attempt_resend_lookup`,
  DROP COLUMN `campaign_id`,
  ADD KEY `idx_outreach_attempt_resend_lookup` (`website_id`, `forms_result`);
