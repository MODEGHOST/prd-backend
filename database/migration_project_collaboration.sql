-- Project collaboration migration for existing MySQL/MariaDB (XAMPP)
-- RUN ONCE only on databases that already imported an older prdproject.sql
-- Fresh installs: import database/prdproject.sql instead (do not run this file)

USE prdproject;

-- projects: creator, budget, currency
ALTER TABLE projects
  ADD COLUMN created_by INT UNSIGNED NULL AFTER approved_by,
  ADD COLUMN budget DECIMAL(14, 2) NOT NULL DEFAULT 0 AFTER created_by,
  ADD COLUMN currency CHAR(3) NOT NULL DEFAULT 'THB' AFTER budget;

UPDATE projects SET created_by = owner_id WHERE created_by IS NULL;

ALTER TABLE projects
  MODIFY COLUMN created_by INT UNSIGNED NOT NULL;

ALTER TABLE projects
  ADD CONSTRAINT fk_projects_created_by
  FOREIGN KEY (created_by) REFERENCES users(id);

-- project_members: responsibility + joined_at
ALTER TABLE project_members
  ADD COLUMN responsibility VARCHAR(500) NULL AFTER user_id,
  ADD COLUMN joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP AFTER responsibility;

-- Ensure creator and owner are always members
INSERT IGNORE INTO project_members (project_id, user_id)
SELECT id, owner_id FROM projects;

INSERT IGNORE INTO project_members (project_id, user_id)
SELECT id, created_by FROM projects;

CREATE TABLE IF NOT EXISTS weekly_plans (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  project_id INT UNSIGNED NOT NULL,
  title VARCHAR(220) NOT NULL,
  description TEXT,
  week_start DATE NOT NULL,
  week_end DATE NOT NULL,
  assignee_id INT UNSIGNED NULL,
  status ENUM('planned', 'in_progress', 'done') NOT NULL DEFAULT 'planned',
  created_by INT UNSIGNED NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (assignee_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by) REFERENCES users(id),
  INDEX idx_weekly_plans_project (project_id, week_start)
);

CREATE TABLE IF NOT EXISTS project_messages (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  project_id INT UNSIGNED NOT NULL,
  user_id INT UNSIGNED NOT NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id),
  INDEX idx_project_messages_project (project_id, created_at)
);
