USE lfbsmart_project;

-- Production hardening: direct task tenancy, tenant composite keys, migration
-- ledger, and a durable outbox for asynchronous notifications/events.

CREATE TABLE IF NOT EXISTS schema_migrations (
  name VARCHAR(190) PRIMARY KEY,
  applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS outbox_events (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  company_id INT UNSIGNED NOT NULL,
  event_type VARCHAR(100) NOT NULL,
  aggregate_type VARCHAR(80) NULL,
  aggregate_id VARCHAR(80) NULL,
  dedupe_key VARCHAR(190) NULL,
  payload_json LONGTEXT NOT NULL,
  status ENUM('pending','processing','done','failed') NOT NULL DEFAULT 'pending',
  attempts INT UNSIGNED NOT NULL DEFAULT 0,
  available_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  locked_by VARCHAR(64) NULL,
  locked_at DATETIME NULL,
  processed_at DATETIME NULL,
  last_error VARCHAR(1000) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_outbox_dedupe (dedupe_key),
  KEY idx_outbox_dispatch (status, available_at, id),
  KEY idx_outbox_company_created (company_id, created_at),
  CONSTRAINT fk_outbox_company
    FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
);

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS company_id INT UNSIGNED NULL AFTER id;
ALTER TABLE outbox_events
  ADD COLUMN IF NOT EXISTS locked_by VARCHAR(64) NULL AFTER available_at;

UPDATE tasks t
JOIN projects p ON p.id = t.project_id
SET t.company_id = p.company_id
WHERE t.company_id IS NULL;

DELIMITER $$
DROP PROCEDURE IF EXISTS apply_production_hardening$$
CREATE PROCEDURE apply_production_hardening()
BEGIN
  IF EXISTS (
    SELECT 1
    FROM membership_roles mr
    JOIN company_memberships cm ON cm.id = mr.membership_id
    JOIN roles r ON r.id = mr.role_id
    WHERE r.company_id IS NOT NULL AND r.company_id <> cm.company_id
  ) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'Tenant mismatch: membership role belongs to another company';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM issues i JOIN projects p ON p.id = i.project_id
    WHERE i.project_id IS NOT NULL AND i.company_id <> p.company_id
  ) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'Tenant mismatch: issues.project_id belongs to another company';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM tasks t JOIN projects p ON p.id = t.project_id
    WHERE t.company_id <> p.company_id
  ) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'Tenant mismatch: tasks.project_id belongs to another company';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM tasks t JOIN issues i ON i.id = t.issue_id
    WHERE t.issue_id IS NOT NULL AND t.company_id <> i.company_id
  ) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'Tenant mismatch: tasks.issue_id belongs to another company';
  END IF;

  ALTER TABLE tasks MODIFY company_id INT UNSIGNED NOT NULL;

  IF EXISTS (
    SELECT 1 FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'projects'
      AND index_name = 'code' AND non_unique = 0
  ) THEN
    ALTER TABLE projects DROP INDEX code;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'projects'
      AND index_name = 'uq_projects_company_code'
  ) THEN
    ALTER TABLE projects
      ADD UNIQUE KEY uq_projects_company_code (company_id, code);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'projects'
      AND index_name = 'uq_projects_id_company'
  ) THEN
    ALTER TABLE projects
      ADD UNIQUE KEY uq_projects_id_company (id, company_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'issues'
      AND index_name = 'uq_issues_id_company'
  ) THEN
    ALTER TABLE issues
      ADD UNIQUE KEY uq_issues_id_company (id, company_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'tasks'
      AND index_name = 'idx_tasks_company_assignee'
  ) THEN
    ALTER TABLE tasks
      ADD INDEX idx_tasks_company_assignee (company_id, assignee_id, status);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_schema = DATABASE() AND table_name = 'tasks'
      AND constraint_name = 'fk_tasks_company'
  ) THEN
    ALTER TABLE tasks
      ADD CONSTRAINT fk_tasks_company
      FOREIGN KEY (company_id) REFERENCES companies(id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_schema = DATABASE() AND table_name = 'issues'
      AND constraint_name = 'fk_issues_project_company'
  ) THEN
    ALTER TABLE issues
      ADD CONSTRAINT fk_issues_project_company
      FOREIGN KEY (project_id, company_id)
      REFERENCES projects(id, company_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_schema = DATABASE() AND table_name = 'tasks'
      AND constraint_name = 'fk_tasks_project_company'
  ) THEN
    ALTER TABLE tasks
      ADD CONSTRAINT fk_tasks_project_company
      FOREIGN KEY (project_id, company_id)
      REFERENCES projects(id, company_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_schema = DATABASE() AND table_name = 'tasks'
      AND constraint_name = 'fk_tasks_issue_company'
  ) THEN
    ALTER TABLE tasks
      ADD CONSTRAINT fk_tasks_issue_company
      FOREIGN KEY (issue_id, company_id)
      REFERENCES issues(id, company_id);
  END IF;
END$$

CALL apply_production_hardening()$$
DROP PROCEDURE apply_production_hardening$$
DELIMITER ;

DELIMITER $$
DROP TRIGGER IF EXISTS trg_membership_roles_tenant_insert$$
CREATE TRIGGER trg_membership_roles_tenant_insert
BEFORE INSERT ON membership_roles
FOR EACH ROW
BEGIN
  IF EXISTS (
    SELECT 1
    FROM company_memberships cm
    JOIN roles r ON r.id = NEW.role_id
    WHERE cm.id = NEW.membership_id
      AND r.company_id IS NOT NULL
      AND r.company_id <> cm.company_id
  ) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'Membership role must belong to the same company';
  END IF;
END$$

DROP TRIGGER IF EXISTS trg_membership_roles_tenant_update$$
CREATE TRIGGER trg_membership_roles_tenant_update
BEFORE UPDATE ON membership_roles
FOR EACH ROW
BEGIN
  IF EXISTS (
    SELECT 1
    FROM company_memberships cm
    JOIN roles r ON r.id = NEW.role_id
    WHERE cm.id = NEW.membership_id
      AND r.company_id IS NOT NULL
      AND r.company_id <> cm.company_id
  ) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'Membership role must belong to the same company';
  END IF;
END$$
DELIMITER ;

INSERT IGNORE INTO schema_migrations (name)
VALUES ('20260719_production_hardening');
