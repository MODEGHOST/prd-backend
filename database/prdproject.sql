CREATE DATABASE IF NOT EXISTS prdproject
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

USE prdproject;

CREATE TABLE IF NOT EXISTS users (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  email VARCHAR(190) NOT NULL UNIQUE,
  username VARCHAR(50) NOT NULL UNIQUE,
  telegram_id VARCHAR(64) NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  role ENUM('admin', 'member', 'requester') NOT NULL DEFAULT 'requester',
  department VARCHAR(120),
  avatar_url VARCHAR(500),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS projects (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(180) NOT NULL,
  code VARCHAR(30) NOT NULL UNIQUE,
  description TEXT,
  prd TEXT,
  status ENUM('pending', 'active', 'on_hold', 'completed', 'rejected') DEFAULT 'pending',
  start_date DATE,
  end_date DATE,
  owner_id INT UNSIGNED NOT NULL,
  approved_by INT UNSIGNED,
  approved_at DATETIME NULL,
  created_by INT UNSIGNED NOT NULL,
  budget DECIMAL(14, 2) NOT NULL DEFAULT 0,
  currency CHAR(3) NOT NULL DEFAULT 'THB',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (owner_id) REFERENCES users(id),
  FOREIGN KEY (approved_by) REFERENCES users(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS project_members (
  project_id INT UNSIGNED NOT NULL,
  user_id INT UNSIGNED NOT NULL,
  responsibility VARCHAR(500) NULL,
  joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (project_id, user_id),
  INDEX idx_project_members_user (user_id, project_id),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

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
  reply_to_id INT UNSIGNED NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_project_messages_id_project (id, project_id),
  INDEX idx_project_messages_reply_project (reply_to_id, project_id),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT fk_project_messages_reply_same_project
    FOREIGN KEY (reply_to_id, project_id)
    REFERENCES project_messages(id, project_id) ON DELETE CASCADE,
  INDEX idx_project_messages_project (project_id, created_at)
);

-- company_id is populated and constrained by the P3 migration after the
-- multi-company migration creates the companies table and tenant project key.
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
  CONSTRAINT fk_project_message_attachments_project
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  CONSTRAINT fk_project_message_attachments_message
    FOREIGN KEY (message_id, project_id)
    REFERENCES project_messages(id, project_id) ON DELETE CASCADE,
  CONSTRAINT fk_project_message_attachments_uploader
    FOREIGN KEY (uploader_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS issues (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  ticket_no VARCHAR(30) NOT NULL UNIQUE,
  title VARCHAR(220) NOT NULL,
  description TEXT NOT NULL,
  type ENUM('bug', 'feature', 'support') NOT NULL,
  priority ENUM('low', 'medium', 'high', 'urgent') DEFAULT 'medium',
  status ENUM('open', 'accepted', 'in_progress', 'closed', 'cancelled', 'rejected') DEFAULT 'open',
  project_id INT UNSIGNED,
  system_component VARCHAR(160) NULL,
  requester_id INT UNSIGNED NOT NULL,
  assignee_id INT UNSIGNED,
  board_status ENUM('todo', 'doing', 'review', 'done') NULL,
  estimated_completion_at DATETIME NULL,
  accepted_at DATETIME NULL,
  started_at DATETIME NULL,
  completed_at DATETIME NULL,
  cancelled_at DATETIME NULL,
  rejection_reason TEXT NULL,
  rejected_by INT UNSIGNED NULL,
  rejected_at DATETIME NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_issues_project_status (project_id, status),
  INDEX idx_issues_assignee_status (assignee_id, status),
  INDEX idx_issues_requester (requester_id, updated_at),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL,
  FOREIGN KEY (requester_id) REFERENCES users(id),
  FOREIGN KEY (assignee_id) REFERENCES users(id),
  FOREIGN KEY (rejected_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS issue_members (
  issue_id INT UNSIGNED NOT NULL,
  user_id INT UNSIGNED NOT NULL,
  added_by INT UNSIGNED NOT NULL,
  joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (issue_id, user_id),
  INDEX idx_issue_members_user (user_id, issue_id),
  FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (added_by) REFERENCES users(id)
);

-- The tenant migration creates companies before this table in upgraded installs.
CREATE TABLE IF NOT EXISTS invitations (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  company_id INT UNSIGNED NOT NULL,
  email VARCHAR(190) NOT NULL,
  employee_code VARCHAR(80) NULL,
  status ENUM('pending','accepted','revoked','expired') NOT NULL DEFAULT 'pending',
  roles_json JSON NULL,
  token_hash CHAR(64) NOT NULL,
  invited_by INT UNSIGNED NOT NULL,
  expires_at DATETIME NOT NULL,
  accepted_at DATETIME NULL,
  accepted_by INT UNSIGNED NULL,
  revoked_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_invitations_token (token_hash),
  INDEX idx_invitations_company_email (company_id, email),
  FOREIGN KEY (invited_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS issue_activities (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  issue_id INT UNSIGNED NOT NULL,
  actor_id INT UNSIGNED,
  event_type VARCHAR(50) NOT NULL,
  description VARCHAR(500) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE,
  FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_issue_activities_issue (issue_id, created_at)
);

CREATE TABLE IF NOT EXISTS tasks (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  project_id INT UNSIGNED NOT NULL,
  issue_id INT UNSIGNED,
  title VARCHAR(220) NOT NULL,
  description TEXT,
  status ENUM('todo', 'doing', 'review', 'done') DEFAULT 'todo',
  priority ENUM('low', 'medium', 'high', 'urgent') DEFAULT 'medium',
  difficulty ENUM('easy', 'medium', 'hard') DEFAULT 'medium',
  assignee_id INT UNSIGNED,
  start_date DATE,
  due_date DATE,
  position INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE SET NULL,
  FOREIGN KEY (assignee_id) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_tasks_board (project_id, status, position),
  INDEX idx_tasks_assignee (assignee_id, status),
  INDEX idx_tasks_issue (issue_id)
);

CREATE TABLE IF NOT EXISTS comments (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  issue_id INT UNSIGNED NOT NULL,
  user_id INT UNSIGNED NOT NULL,
  reply_to_id INT UNSIGNED NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_comments_id_issue (id, issue_id),
  INDEX idx_comments_issue (issue_id, created_at),
  INDEX idx_comments_reply_issue (reply_to_id, issue_id),
  FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT fk_comments_reply_same_issue
    FOREIGN KEY (reply_to_id, issue_id)
    REFERENCES comments(id, issue_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS issue_attachments (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  issue_id INT UNSIGNED NOT NULL,
  comment_id INT UNSIGNED NULL,
  company_id INT UNSIGNED NOT NULL,
  uploaded_by INT UNSIGNED NOT NULL,
  storage_name CHAR(64) NOT NULL,
  original_name VARCHAR(255) NOT NULL,
  mime_type VARCHAR(120) NOT NULL,
  size_bytes INT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_issue_attachments_storage (storage_name),
  INDEX idx_issue_attachments_issue (issue_id, created_at),
  INDEX idx_issue_attachments_comment (comment_id, created_at),
  FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE,
  FOREIGN KEY (comment_id) REFERENCES comments(id) ON DELETE CASCADE,
  FOREIGN KEY (uploaded_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS notifications (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  title VARCHAR(220) NOT NULL,
  message VARCHAR(500) NOT NULL,
  type VARCHAR(32) NOT NULL DEFAULT 'general',
  target_url VARCHAR(500) NULL,
  entity_type VARCHAR(32) NULL,
  entity_id INT UNSIGNED NULL,
  actor_name VARCHAR(220) NULL,
  is_read BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_notifications_user (user_id, is_read),
  INDEX idx_notifications_created (user_id, created_at)
);
