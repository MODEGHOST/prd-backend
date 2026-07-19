USE prdproject;

-- P0 role hierarchy and project approval hardening.
-- This migration is intentionally rerunnable and upgrades databases that have
-- already applied the previous RBAC migrations.

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS approved_at DATETIME NULL AFTER approved_by;

UPDATE projects
SET approved_at = COALESCE(approved_at, created_at)
WHERE status IN ('active', 'rejected')
  AND approved_by IS NOT NULL
  AND approved_at IS NULL;

INSERT INTO roles (name, label, description, is_system)
VALUES (
  'group_admin',
  'Group Admin',
  'จัดการกลุ่มบริษัท บริษัทย่อย และผู้ดูแลบริษัทตามลำดับสิทธิ์',
  TRUE
)
ON DUPLICATE KEY UPDATE
  label = VALUES(label),
  description = VALUES(description),
  is_system = TRUE;

UPDATE roles
SET label = CASE name
  WHEN 'company_admin' THEN 'Company Admin'
  WHEN 'project_manager' THEN 'Project Manager'
  WHEN 'dev' THEN 'Developer'
  WHEN 'requester' THEN 'Requester'
  ELSE label
END
WHERE name IN ('company_admin', 'project_manager', 'dev', 'requester');

-- Group Admin receives the legacy owner capabilities. Company Admin is kept
-- functionally broad, while application-layer hierarchy checks constrain it
-- to the active company and lower-ranked memberships.
INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.name IN ('group_admin', 'company_admin')
  AND r.company_id IS NULL;

-- Existing Company Owner assignments become Group Admin assignments on the
-- exact same memberships. Other membership roles and tenant boundaries remain
-- unchanged.
INSERT IGNORE INTO membership_roles (membership_id, role_id, assigned_by)
SELECT mr.membership_id, group_role.id, mr.assigned_by
FROM membership_roles mr
JOIN roles owner_role
  ON owner_role.id = mr.role_id
 AND owner_role.name = 'company_owner'
JOIN roles group_role
  ON group_role.name = 'group_admin'
 AND group_role.company_id IS NULL;

DELETE mr
FROM membership_roles mr
JOIN roles r ON r.id = mr.role_id
WHERE r.name = 'company_owner';

-- Only Project Managers (and administrators through manage_all) create and
-- approve projects. Developers retain implementation permissions but cannot
-- create projects or update project approval/status.
DELETE rp
FROM role_permissions rp
JOIN roles r ON r.id = rp.role_id
JOIN permissions p ON p.id = rp.permission_id
WHERE r.name = 'dev'
  AND p.code IN ('projects.create', 'projects.status.update');

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p
  ON p.code IN ('projects.create', 'projects.status.update')
WHERE r.name = 'project_manager' AND r.company_id IS NULL;

UPDATE permissions
SET description = 'อนุมัติ ปฏิเสธ หรือเปลี่ยนสถานะโครงการ'
WHERE code = 'projects.status.update';
