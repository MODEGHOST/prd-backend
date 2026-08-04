-- Allow system Developer (dev / นักพัฒนา) to manage company members and roles.
-- Hierarchy still enforced in app code: Dev cannot manage/assign Group Admin or Company Admin.
-- Custom roles still cannot receive members.manage / roles.manage / company.manage.

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code IN ('members.read', 'members.manage', 'roles.manage')
WHERE r.name = 'dev' AND r.company_id IS NULL AND r.is_system = TRUE;
