ALTER TABLE `OUTREACH_attempts`
  DROP CHECK `chk_outreach_attempt_completed_time`,
  MODIFY COLUMN `execution_status` ENUM(
    'queued',
    'running',
    'finished',
    'run_failed',
    'skipped',
    'timed_out'
  ) NOT NULL DEFAULT 'queued',
  ADD CONSTRAINT `chk_outreach_attempt_completed_time`
    CHECK (
      (`execution_status` IN ('queued', 'running') AND `completed_time` IS NULL)
      OR
      (`execution_status` IN ('finished', 'run_failed', 'skipped', 'timed_out') AND `completed_time` IS NOT NULL)
    );
