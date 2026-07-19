USE prdproject;

-- P4 reply metadata for Issue and project chat.
-- Rerunnable on MariaDB 10.4. Composite self references also prevent
-- cross-conversation replies at the database boundary.
DELIMITER //
DROP PROCEDURE IF EXISTS migrate_p4_chat_replies//
CREATE PROCEDURE migrate_p4_chat_replies()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name = 'comments'
      AND column_name = 'reply_to_id'
  ) THEN
    ALTER TABLE comments ADD COLUMN reply_to_id INT UNSIGNED NULL AFTER user_id;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.statistics
    WHERE table_schema = DATABASE()
      AND table_name = 'comments'
      AND index_name = 'uq_comments_id_issue'
  ) THEN
    ALTER TABLE comments ADD UNIQUE KEY uq_comments_id_issue (id, issue_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.statistics
    WHERE table_schema = DATABASE()
      AND table_name = 'comments'
      AND index_name = 'idx_comments_reply_issue'
  ) THEN
    ALTER TABLE comments ADD INDEX idx_comments_reply_issue (reply_to_id, issue_id);
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.referential_constraints
    WHERE constraint_schema = DATABASE()
      AND table_name = 'comments'
      AND constraint_name = 'fk_comments_reply_same_issue'
      AND delete_rule <> 'CASCADE'
  ) THEN
    ALTER TABLE comments DROP FOREIGN KEY fk_comments_reply_same_issue;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.referential_constraints
    WHERE constraint_schema = DATABASE()
      AND table_name = 'comments'
      AND constraint_name = 'fk_comments_reply_same_issue'
  ) THEN
    ALTER TABLE comments
      ADD CONSTRAINT fk_comments_reply_same_issue
      FOREIGN KEY (reply_to_id, issue_id)
      REFERENCES comments(id, issue_id) ON DELETE CASCADE;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.referential_constraints
    WHERE constraint_schema = DATABASE()
      AND table_name = 'project_messages'
      AND constraint_name = 'fk_project_messages_reply_same_project'
      AND delete_rule <> 'CASCADE'
  ) THEN
    ALTER TABLE project_messages
      DROP FOREIGN KEY fk_project_messages_reply_same_project;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name = 'project_messages'
      AND column_name = 'reply_to_id'
  ) THEN
    ALTER TABLE project_messages ADD COLUMN reply_to_id INT UNSIGNED NULL AFTER user_id;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.statistics
    WHERE table_schema = DATABASE()
      AND table_name = 'project_messages'
      AND index_name = 'uq_project_messages_id_project'
  ) THEN
    ALTER TABLE project_messages
      ADD UNIQUE KEY uq_project_messages_id_project (id, project_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.statistics
    WHERE table_schema = DATABASE()
      AND table_name = 'project_messages'
      AND index_name = 'idx_project_messages_reply_project'
  ) THEN
    ALTER TABLE project_messages
      ADD INDEX idx_project_messages_reply_project (reply_to_id, project_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.referential_constraints
    WHERE constraint_schema = DATABASE()
      AND table_name = 'project_messages'
      AND constraint_name = 'fk_project_messages_reply_same_project'
  ) THEN
    ALTER TABLE project_messages
      ADD CONSTRAINT fk_project_messages_reply_same_project
      FOREIGN KEY (reply_to_id, project_id)
      REFERENCES project_messages(id, project_id) ON DELETE CASCADE;
  END IF;
END//
CALL migrate_p4_chat_replies()//
DROP PROCEDURE migrate_p4_chat_replies//
DELIMITER ;
