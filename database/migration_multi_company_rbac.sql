USE lfbsmart_project;

-- Multi-company/RBAC expansion for MariaDB as shipped with XAMPP.
-- Run after lfbsmart_project.sql and the existing feature migrations.
-- Statements use IF NOT EXISTS and upserts so an interrupted import can usually be resumed.

CREATE TABLE IF NOT EXISTS companies (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  parent_id INT UNSIGNED NULL,
  name VARCHAR(180) NOT NULL,
  slug VARCHAR(190) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  allow_registration BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_companies_slug (slug),
  KEY idx_companies_parent (parent_id),
  CONSTRAINT fk_companies_parent FOREIGN KEY (parent_id) REFERENCES companies(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS company_memberships (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  company_id INT UNSIGNED NOT NULL,
  user_id INT UNSIGNED NOT NULL,
  employee_code VARCHAR(80) NULL,
  status ENUM('pending','active','rejected','suspended') NOT NULL DEFAULT 'pending',
  approved_by INT UNSIGNED NULL,
  approved_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_membership_company_user (company_id, user_id),
  UNIQUE KEY uq_membership_employee (company_id, employee_code),
  KEY idx_membership_user_status (user_id, status),
  KEY idx_membership_company_status (company_id, status),
  CONSTRAINT fk_membership_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  CONSTRAINT fk_membership_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_membership_approver FOREIGN KEY (approved_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS roles (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  company_id INT UNSIGNED NULL,
  name VARCHAR(64) NOT NULL,
  label VARCHAR(120) NOT NULL,
  description VARCHAR(500) NULL,
  is_system BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_roles_name (name),
  KEY idx_roles_company (company_id),
  CONSTRAINT fk_roles_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS permissions (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(100) NOT NULL,
  description VARCHAR(255) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_permissions_code (code)
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id INT UNSIGNED NOT NULL,
  permission_id INT UNSIGNED NOT NULL,
  PRIMARY KEY (role_id, permission_id),
  CONSTRAINT fk_role_permissions_role FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE,
  CONSTRAINT fk_role_permissions_permission FOREIGN KEY (permission_id) REFERENCES permissions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS membership_roles (
  membership_id INT UNSIGNED NOT NULL,
  role_id INT UNSIGNED NOT NULL,
  assigned_by INT UNSIGNED NULL,
  assigned_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (membership_id, role_id),
  CONSTRAINT fk_membership_roles_membership FOREIGN KEY (membership_id) REFERENCES company_memberships(id) ON DELETE CASCADE,
  CONSTRAINT fk_membership_roles_role FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE,
  CONSTRAINT fk_membership_roles_assigner FOREIGN KEY (assigned_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS invitations (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  company_id INT UNSIGNED NOT NULL,
  email VARCHAR(190) NOT NULL,
  employee_code VARCHAR(80) NULL,
  token_hash CHAR(64) NOT NULL,
  invited_by INT UNSIGNED NOT NULL,
  expires_at DATETIME NOT NULL,
  accepted_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_invitations_token (token_hash),
  KEY idx_invitations_company_email (company_id, email),
  CONSTRAINT fk_invitations_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  CONSTRAINT fk_invitations_inviter FOREIGN KEY (invited_by) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS email_verification_tokens (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  token_hash CHAR(64) NOT NULL,
  expires_at DATETIME NOT NULL,
  used_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_email_verification_hash (token_hash),
  KEY idx_email_verification_user (user_id, expires_at),
  CONSTRAINT fk_email_verification_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  token_hash CHAR(64) NOT NULL,
  expires_at DATETIME NOT NULL,
  used_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_password_reset_hash (token_hash),
  KEY idx_password_reset_user (user_id, expires_at),
  CONSTRAINT fk_password_reset_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  company_id INT UNSIGNED NULL,
  actor_user_id INT UNSIGNED NULL,
  action VARCHAR(100) NOT NULL,
  entity_type VARCHAR(80) NULL,
  entity_id VARCHAR(80) NULL,
  metadata_json LONGTEXT NULL,
  ip_address VARCHAR(64) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_audit_company_created (company_id, created_at),
  KEY idx_audit_actor_created (actor_user_id, created_at),
  CONSTRAINT fk_audit_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE SET NULL,
  CONSTRAINT fk_audit_actor FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL
);

-- Expansion: nullable/defaulted columns first.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS first_name VARCHAR(100) NULL AFTER name,
  ADD COLUMN IF NOT EXISTS last_name VARCHAR(100) NULL AFTER first_name,
  ADD COLUMN IF NOT EXISTS status ENUM('pending','active','suspended') NOT NULL DEFAULT 'active' AFTER role,
  ADD COLUMN IF NOT EXISTS email_verified_at DATETIME NULL AFTER status,
  ADD COLUMN IF NOT EXISTS token_version INT UNSIGNED NOT NULL DEFAULT 0 AFTER email_verified_at;

ALTER TABLE projects ADD COLUMN IF NOT EXISTS company_id INT UNSIGNED NULL AFTER id;
ALTER TABLE issues ADD COLUMN IF NOT EXISTS company_id INT UNSIGNED NULL AFTER id;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS company_id INT UNSIGNED NULL AFTER id;
ALTER TABLE roles
  ADD COLUMN IF NOT EXISTS company_id INT UNSIGNED NULL AFTER id,
  ADD COLUMN IF NOT EXISTS description VARCHAR(500) NULL AFTER label;

INSERT INTO companies (name, slug, is_active, allow_registration)
VALUES ('Default Company', 'default-company', TRUE, TRUE)
ON DUPLICATE KEY UPDATE name = VALUES(name);

SET @default_company_id := (SELECT id FROM companies WHERE slug = 'default-company' LIMIT 1);

-- Backfill users and tenant-owned rows before enforcing company_id.
UPDATE users
SET first_name = COALESCE(first_name, NULLIF(SUBSTRING_INDEX(name, ' ', 1), '')),
    last_name = COALESCE(last_name, NULLIF(TRIM(SUBSTRING(name, LENGTH(SUBSTRING_INDEX(name, ' ', 1)) + 1)), '')),
    email_verified_at = COALESCE(email_verified_at, CURRENT_TIMESTAMP),
    status = 'active'
WHERE NOT EXISTS (
  SELECT 1 FROM company_memberships cm WHERE cm.user_id = users.id
);

INSERT INTO company_memberships
  (company_id, user_id, employee_code, status, approved_by, approved_at)
SELECT @default_company_id, u.id, CONCAT('LEGACY-', u.id), 'active',
       (SELECT a.id FROM users a WHERE a.role = 'admin' ORDER BY a.id LIMIT 1),
       CURRENT_TIMESTAMP
FROM users u
ON DUPLICATE KEY UPDATE
  status = IF(company_memberships.status = 'pending', 'active', company_memberships.status);

UPDATE projects SET company_id = @default_company_id WHERE company_id IS NULL;
UPDATE issues i
LEFT JOIN projects p ON p.id = i.project_id
SET i.company_id = COALESCE(p.company_id, @default_company_id)
WHERE i.company_id IS NULL;
UPDATE notifications n
LEFT JOIN issues i ON n.entity_type = 'issue' AND i.id = n.entity_id
LEFT JOIN projects p ON n.entity_type = 'project' AND p.id = n.entity_id
SET n.company_id = COALESCE(i.company_id, p.company_id, @default_company_id)
WHERE n.company_id IS NULL;

INSERT INTO roles (name, label) VALUES
  ('company_owner', 'Company Owner'),
  ('company_admin', 'Company Admin'),
  ('project_manager', 'Project Manager'),
  ('dev', 'Developer'),
  ('requester', 'Requester'),
  ('auditor', 'Auditor')
ON DUPLICATE KEY UPDATE label = VALUES(label);

INSERT INTO permissions (code, description) VALUES
  ('company.manage', 'จัดการการตั้งค่าบริษัท'),
  ('company.switch', 'สลับบริษัทที่ใช้งาน'),
  ('members.read', 'ดูรายชื่อสมาชิกบริษัท'),
  ('members.manage', 'อนุมัติและจัดการสมาชิกบริษัท'),
  ('roles.manage', 'จัดการและมอบหมายบทบาท'),
  ('projects.read_all', 'ดูทุกโครงการในบริษัท'),
  ('projects.manage_all', 'จัดการทุกโครงการในบริษัท'),
  ('projects.create', 'สร้างโครงการ'),
  ('projects.update', 'แก้ไขโครงการที่เข้าถึงได้'),
  ('projects.members.manage', 'จัดการสมาชิกโครงการ'),
  ('projects.status.update', 'เปลี่ยนสถานะโครงการ'),
  ('projects.plan.manage', 'จัดการแผนงานรายสัปดาห์'),
  ('projects.chat', 'ส่งข้อความในแชทโครงการ'),
  ('issues.read_all', 'ดูทุก Ticket และแชทในบริษัท'),
  ('issues.manage_all', 'จัดการทุก Ticket ในบริษัท'),
  ('issues.create', 'สร้าง Ticket'),
  ('issues.accept', 'รับ Ticket เพื่อดำเนินการ'),
  ('issues.assign', 'มอบหมายผู้รับผิดชอบ Ticket'),
  ('issues.update', 'แก้ไขรายละเอียด Ticket'),
  ('issues.transition', 'เปลี่ยนสถานะขั้นตอน Ticket'),
  ('issues.members.manage', 'จัดการผู้เข้าร่วม Ticket'),
  ('issues.comment', 'แสดงความคิดเห็นใน Ticket'),
  ('tasks.manage_all', 'จัดการทุกงานในบริษัท'),
  ('tasks.create', 'สร้างงานในโครงการ'),
  ('tasks.update', 'แก้ไขงานที่ได้รับมอบหมายหรือดูแล'),
  ('audit.read', 'ดูบันทึกการตรวจสอบบริษัท')
ON DUPLICATE KEY UPDATE description = VALUES(description);

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.name = 'company_owner';

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.name = 'company_admin';

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p
  ON p.code IN ('projects.create','issues.create','issues.accept','issues.assign',
                'projects.update','projects.members.manage','projects.status.update',
                'projects.plan.manage','projects.chat','tasks.create','tasks.update',
                'issues.update','issues.transition','issues.members.manage','issues.comment')
WHERE r.name = 'project_manager';

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p
  ON p.code IN ('projects.create','issues.read_all','issues.create','issues.accept',
                'projects.update','projects.members.manage','projects.status.update',
                'projects.plan.manage','projects.chat','tasks.create','tasks.update',
                'issues.update','issues.transition','issues.members.manage','issues.comment')
WHERE r.name = 'dev';

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p
  ON p.code IN ('issues.create','issues.update','issues.comment')
WHERE r.name = 'requester';

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p
  ON p.code IN ('members.read','projects.read_all','issues.read_all','audit.read')
WHERE r.name = 'auditor';

-- Legacy compatibility mapping: admin -> owner, member -> dev, requester -> requester.
INSERT IGNORE INTO membership_roles (membership_id, role_id)
SELECT cm.id, r.id
FROM company_memberships cm
JOIN users u ON u.id = cm.user_id
JOIN roles r ON r.name = CASE u.role
  WHEN 'admin' THEN 'company_owner'
  WHEN 'member' THEN 'dev'
  ELSE 'requester'
END
WHERE cm.company_id = @default_company_id;

-- Enforce only after all rows have been backfilled.
ALTER TABLE projects MODIFY company_id INT UNSIGNED NOT NULL;
ALTER TABLE issues MODIFY company_id INT UNSIGNED NOT NULL;
ALTER TABLE notifications MODIFY company_id INT UNSIGNED NOT NULL;

-- Conditional keys/indexes keep reruns from failing.
DELIMITER $$
DROP PROCEDURE IF EXISTS add_multi_company_constraints$$
CREATE PROCEDURE add_multi_company_constraints()
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.statistics
                 WHERE table_schema = DATABASE() AND table_name = 'projects'
                   AND index_name = 'idx_projects_company') THEN
    ALTER TABLE projects ADD INDEX idx_projects_company (company_id, created_at);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.statistics
                 WHERE table_schema = DATABASE() AND table_name = 'issues'
                   AND index_name = 'idx_issues_company') THEN
    ALTER TABLE issues ADD INDEX idx_issues_company (company_id, updated_at);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.statistics
                 WHERE table_schema = DATABASE() AND table_name = 'notifications'
                   AND index_name = 'idx_notifications_company_user') THEN
    ALTER TABLE notifications ADD INDEX idx_notifications_company_user (company_id, user_id, created_at);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.statistics
                 WHERE table_schema = DATABASE() AND table_name = 'roles'
                   AND index_name = 'idx_roles_company') THEN
    ALTER TABLE roles ADD INDEX idx_roles_company (company_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
                 WHERE constraint_schema = DATABASE() AND table_name = 'projects'
                   AND constraint_name = 'fk_projects_company') THEN
    ALTER TABLE projects ADD CONSTRAINT fk_projects_company
      FOREIGN KEY (company_id) REFERENCES companies(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
                 WHERE constraint_schema = DATABASE() AND table_name = 'issues'
                   AND constraint_name = 'fk_issues_company') THEN
    ALTER TABLE issues ADD CONSTRAINT fk_issues_company
      FOREIGN KEY (company_id) REFERENCES companies(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
                 WHERE constraint_schema = DATABASE() AND table_name = 'notifications'
                   AND constraint_name = 'fk_notifications_company') THEN
    ALTER TABLE notifications ADD CONSTRAINT fk_notifications_company
      FOREIGN KEY (company_id) REFERENCES companies(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
                 WHERE constraint_schema = DATABASE() AND table_name = 'roles'
                   AND constraint_name = 'fk_roles_company') THEN
    ALTER TABLE roles ADD CONSTRAINT fk_roles_company
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;
  END IF;
END$$
CALL add_multi_company_constraints()$$
DROP PROCEDURE add_multi_company_constraints$$
DELIMITER ;
