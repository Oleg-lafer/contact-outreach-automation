ALTER TABLE `OUTREACH_attempts`
  DROP CHECK `chk_outreach_attempt_completed_time`;

ALTER TABLE `OUTREACH_attempts`
  ADD COLUMN `forms_result`
    ENUM('success', 'partial', 'inconclusive', 'failed') NULL
    AFTER `execution_status`,
  ADD COLUMN `email_discovery_result`
    ENUM('success', 'partial', 'inconclusive', 'failed') NULL
    AFTER `forms_result`,
  ADD COLUMN `meeting_discovery_result`
    ENUM('success', 'partial', 'inconclusive', 'failed') NULL
    AFTER `email_discovery_result`;

ALTER TABLE `OUTREACH_attempts`
  MODIFY COLUMN `execution_status` ENUM(
    'queued',
    'running',
    'succeeded',
    'partial',
    'failed',
    'finished',
    'run_failed',
    'skipped'
  ) NOT NULL DEFAULT 'queued';

UPDATE `OUTREACH_attempts`
SET
  `forms_result` = CASE
    WHEN LOWER(JSON_UNQUOTE(JSON_EXTRACT(`channel_outcomes`, '$.forms.status')))
         IN ('success', 'partial', 'inconclusive', 'failed')
      THEN LOWER(JSON_UNQUOTE(JSON_EXTRACT(`channel_outcomes`, '$.forms.status')))
    WHEN `execution_status` = 'succeeded' THEN 'success'
    WHEN `execution_status` = 'partial' THEN 'partial'
    WHEN `execution_status` = 'failed' THEN 'failed'
    ELSE NULL
  END,
  `email_discovery_result` = CASE
    WHEN LOWER(JSON_UNQUOTE(JSON_EXTRACT(`channel_outcomes`, '$.emails.status')))
         IN ('success', 'partial', 'inconclusive', 'failed')
      THEN LOWER(JSON_UNQUOTE(JSON_EXTRACT(`channel_outcomes`, '$.emails.status')))
    ELSE NULL
  END,
  `meeting_discovery_result` = CASE
    WHEN LOWER(JSON_UNQUOTE(JSON_EXTRACT(`channel_outcomes`, '$.meetings.status')))
         IN ('success', 'partial', 'inconclusive', 'failed')
      THEN LOWER(JSON_UNQUOTE(JSON_EXTRACT(`channel_outcomes`, '$.meetings.status')))
    ELSE NULL
  END;

UPDATE `OUTREACH_attempts`
SET `execution_status` = 'finished'
WHERE `execution_status` IN ('succeeded', 'partial', 'failed');

ALTER TABLE `OUTREACH_attempts`
  DROP INDEX `idx_outreach_attempt_resend_lookup`,
  MODIFY COLUMN `execution_status` ENUM(
    'queued',
    'running',
    'finished',
    'run_failed',
    'skipped'
  ) NOT NULL DEFAULT 'queued',
  ADD KEY `idx_outreach_attempt_resend_lookup` (
    `campaign_id`,
    `website_id`,
    `forms_result`
  ),
  ADD CONSTRAINT `chk_outreach_attempt_completed_time`
    CHECK (
      (`execution_status` IN ('queued', 'running') AND `completed_time` IS NULL)
      OR
      (`execution_status` IN ('finished', 'run_failed', 'skipped') AND `completed_time` IS NOT NULL)
    );
