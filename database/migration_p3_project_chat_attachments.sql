USE lfbsmart_project;

-- P3 private attachments for project chat.
-- Rerunnable on MariaDB 10.4 and safe after the P2/RBAC hardening migrations.
DELIMITER //
DROP PROCEDURE IF EXISTS migrate_p3_project_chat_attachments//
CREATE PROCEDURE migrate_p3_project_chat_attachments()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.statistics
    WHERE table_schema = DATABASE()
      AND table_name = 'projects'
      AND index_name = 'uq_projects_id_company'
  ) THEN
    ALTER TABLE projects
      ADD UNIQUE KEY uq_projects_id_company (id, company_id);
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

  CREATE TABLE IF NOT EXISTS project_message_attachments (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    company_id INT UNSIGNED NOT NULL,
    project_id INT UNSIGNED NOT NULL,
    message_id INT UNSIGNED NOT NULL,
    uploader_id INT UNSIGNED NOT NULL,
    storage_name CHAR(48) NOT NULL,
    original_name VARCHAR(255) NOT NULL,
    mime_type VARCHAR(120) NOT NULL,
    size_bytes INT UNSIGNED NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_project_message_attachments_storage (storage_name),
    INDEX idx_project_message_attachments_message (message_id, created_at),
    INDEX idx_project_message_attachments_project (project_id, created_at),
    CONSTRAINT fk_project_message_attachments_company
      FOREIGN KEY (company_id) REFERENCES companies(id),
    CONSTRAINT fk_project_message_attachments_project_tenant
      FOREIGN KEY (project_id, company_id)
      REFERENCES projects(id, company_id) ON DELETE CASCADE,
    CONSTRAINT fk_project_message_attachments_message
      FOREIGN KEY (message_id, project_id)
      REFERENCES project_messages(id, project_id) ON DELETE CASCADE,
    CONSTRAINT fk_project_message_attachments_uploader
      FOREIGN KEY (uploader_id) REFERENCES users(id)
  );

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.referential_constraints
    WHERE constraint_schema = DATABASE()
      AND table_name = 'project_message_attachments'
      AND constraint_name = 'fk_project_message_attachments_company'
  ) THEN
    ALTER TABLE project_message_attachments
      ADD CONSTRAINT fk_project_message_attachments_company
      FOREIGN KEY (company_id) REFERENCES companies(id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.referential_constraints
    WHERE constraint_schema = DATABASE()
      AND table_name = 'project_message_attachments'
      AND constraint_name = 'fk_project_message_attachments_project_tenant'
  ) THEN
    ALTER TABLE project_message_attachments
      ADD CONSTRAINT fk_project_message_attachments_project_tenant
      FOREIGN KEY (project_id, company_id)
      REFERENCES projects(id, company_id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.referential_constraints
    WHERE constraint_schema = DATABASE()
      AND table_name = 'project_message_attachments'
      AND constraint_name = 'fk_project_message_attachments_message'
  ) THEN
    ALTER TABLE project_message_attachments
      ADD CONSTRAINT fk_project_message_attachments_message
      FOREIGN KEY (message_id, project_id)
      REFERENCES project_messages(id, project_id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.referential_constraints
    WHERE constraint_schema = DATABASE()
      AND table_name = 'project_message_attachments'
      AND constraint_name = 'fk_project_message_attachments_uploader'
  ) THEN
    ALTER TABLE project_message_attachments
      ADD CONSTRAINT fk_project_message_attachments_uploader
      FOREIGN KEY (uploader_id) REFERENCES users(id);
  END IF;
END//
CALL migrate_p3_project_chat_attachments()//
DROP PROCEDURE migrate_p3_project_chat_attachments//
DELIMITER ;
