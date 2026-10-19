ALTER TABLE AGENT_pipeline_runs
    ADD COLUMN chat_readiness_status
        ENUM('NOT_READY', 'READY', 'FAILED') NOT NULL DEFAULT 'NOT_READY',
    ADD COLUMN chat_readiness_version INT UNSIGNED NULL,
    ADD COLUMN chat_readiness_checked_at TIMESTAMP(3) NULL,
    ADD COLUMN chat_readiness_error_code VARCHAR(64) NULL,
    ADD INDEX idx_agent_pipeline_chat_readiness
        (status, chat_readiness_status, chat_readiness_version, completed_at);

UPDATE AGENT_pipeline_runs
SET chat_readiness_status = 'READY',
    chat_readiness_version = 1,
    chat_readiness_checked_at = COALESCE(completed_at, CURRENT_TIMESTAMP(3)),
    chat_readiness_error_code = NULL
WHERE status = 'COMPLETED'
  AND id IN (17, 18, 23);
