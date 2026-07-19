USE prdproject;

-- P2 issue chat attachments.
-- Rerunnable on MariaDB 10.4: column creation uses MariaDB's IF NOT EXISTS,
-- while index and foreign-key creation are guarded through information_schema.
ALTER TABLE issue_attachments
  ADD COLUMN IF NOT EXISTS comment_id INT UNSIGNED NULL AFTER issue_id;

DELIMITER //
DROP PROCEDURE IF EXISTS migrate_p2_chat_attachments//
CREATE PROCEDURE migrate_p2_chat_attachments()
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.statistics
    WHERE table_schema = DATABASE()
      AND table_name = 'issue_attachments'
      AND index_name = 'idx_issue_attachments_comment'
  ) THEN
    ALTER TABLE issue_attachments
      ADD INDEX idx_issue_attachments_comment (comment_id, created_at);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.referential_constraints
    WHERE constraint_schema = DATABASE()
      AND table_name = 'issue_attachments'
      AND constraint_name = 'fk_issue_attachments_comment'
  ) THEN
    ALTER TABLE issue_attachments
      ADD CONSTRAINT fk_issue_attachments_comment
      FOREIGN KEY (comment_id) REFERENCES comments(id) ON DELETE CASCADE;
  END IF;
END//
CALL migrate_p2_chat_attachments()//
DROP PROCEDURE migrate_p2_chat_attachments//
DELIMITER ;
