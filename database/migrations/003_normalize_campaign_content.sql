UPDATE `OUTREACH_campaigns`
SET
  `message_to_send` = COALESCE(
    NULLIF(TRIM(`message_to_send`), ''),
    NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(`sender_details`, '$.message'))), ''),
    ''
  ),
  `sender_details` = JSON_OBJECT(
    'name', TRIM(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(`sender_details`, '$.name')), '')),
    'email', TRIM(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(`sender_details`, '$.email')), '')),
    'phone', TRIM(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(`sender_details`, '$.phone')), '')),
    'company', TRIM(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(`sender_details`, '$.company')), '')),
    'role', TRIM(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(`sender_details`, '$.role')), '')),
    'website', TRIM(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(`sender_details`, '$.website')), '')),
    'country', TRIM(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(`sender_details`, '$.country')), ''))
  );

ALTER TABLE `OUTREACH_campaigns`
  MODIFY COLUMN `sender_details` JSON NOT NULL,
  MODIFY COLUMN `message_to_send` TEXT NOT NULL;
