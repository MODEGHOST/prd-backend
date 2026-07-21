USE lfbsmart_project;

-- Username for login (email remains for verification / password reset)
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS username VARCHAR(50) NULL AFTER email,
  ADD COLUMN IF NOT EXISTS telegram_id VARCHAR(64) NULL AFTER username;

UPDATE users
SET username = LOWER(SUBSTRING_INDEX(email, '@', 1))
WHERE username IS NULL OR TRIM(username) = '';

UPDATE users u
JOIN (
  SELECT username, MIN(id) keep_id
  FROM users
  WHERE username IS NOT NULL AND username <> ''
  GROUP BY username
  HAVING COUNT(*) > 1
) d ON d.username = u.username AND u.id <> d.keep_id
SET u.username = CONCAT(u.username, u.id);

ALTER TABLE users
  MODIFY COLUMN username VARCHAR(50) NOT NULL;

UPDATE users
SET telegram_id = NULL
WHERE telegram_id IS NOT NULL AND TRIM(telegram_id) = '';

SET @has_username_uq := (
  SELECT COUNT(*)
  FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'users'
    AND index_name = 'uq_users_username'
);
SET @sql_username_uq := IF(
  @has_username_uq = 0,
  'ALTER TABLE users ADD UNIQUE KEY uq_users_username (username)',
  'SELECT 1'
);
PREPARE stmt_username_uq FROM @sql_username_uq;
EXECUTE stmt_username_uq;
DEALLOCATE PREPARE stmt_username_uq;

SET @has_telegram_uq := (
  SELECT COUNT(*)
  FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'users'
    AND index_name = 'uq_users_telegram_id'
);
SET @sql_telegram_uq := IF(
  @has_telegram_uq = 0,
  'ALTER TABLE users ADD UNIQUE KEY uq_users_telegram_id (telegram_id)',
  'SELECT 1'
);
PREPARE stmt_telegram_uq FROM @sql_telegram_uq;
EXECUTE stmt_telegram_uq;
DEALLOCATE PREPARE stmt_telegram_uq;
