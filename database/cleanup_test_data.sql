-- Clear transactional test data. Keep login users, RBAC, and the main company.
-- Safe to re-run. Does NOT drop schema or permission catalogs.
--
-- Keeps:
--   users (except disposable integration accounts)
--   companies (main company only) + memberships/roles for kept users
--   roles, permissions, role_permissions, schema_migrations
--
-- Removes:
--   projects / issues / tasks / chat / notifications / invitations / tokens / outbox / audit
--   temporary Tenant B / integration companies and users

USE lfbsmart_project;

SET FOREIGN_KEY_CHECKS = 0;

-- Operational / test content
TRUNCATE TABLE notifications;
TRUNCATE TABLE comments;
TRUNCATE TABLE issue_attachments;
TRUNCATE TABLE issue_activities;
TRUNCATE TABLE issue_members;
TRUNCATE TABLE issues;
TRUNCATE TABLE project_message_attachments;
TRUNCATE TABLE project_messages;
TRUNCATE TABLE weekly_plans;
TRUNCATE TABLE project_members;
TRUNCATE TABLE tasks;
TRUNCATE TABLE projects;
TRUNCATE TABLE invitations;
TRUNCATE TABLE outbox_events;
TRUNCATE TABLE audit_logs;
TRUNCATE TABLE email_verification_tokens;
TRUNCATE TABLE password_reset_tokens;

SET FOREIGN_KEY_CHECKS = 1;

-- Drop disposable integration companies (keep the primary company id = 1)
DELETE mr
FROM membership_roles mr
JOIN company_memberships cm ON cm.id = mr.membership_id
WHERE cm.company_id <> 1;

DELETE FROM company_memberships
WHERE company_id <> 1;

DELETE FROM companies
WHERE id <> 1;

-- Drop disposable integration users (keep seed accounts + real login users)
DELETE mr
FROM membership_roles mr
JOIN company_memberships cm ON cm.id = mr.membership_id
JOIN users u ON u.id = cm.user_id
WHERE u.email LIKE 'registration-%@projecthub.local'
   OR u.email LIKE '%integration%@projecthub.local'
   OR u.email LIKE 'tenant-%@%'
   OR u.name LIKE 'Integration %'
   OR u.email IN ('prpsix777@gmail.com', 'prptest@gmail.com');

DELETE cm
FROM company_memberships cm
JOIN users u ON u.id = cm.user_id
WHERE u.email LIKE 'registration-%@projecthub.local'
   OR u.email LIKE '%integration%@projecthub.local'
   OR u.email LIKE 'tenant-%@%'
   OR u.name LIKE 'Integration %'
   OR u.email IN ('prpsix777@gmail.com', 'prptest@gmail.com');

DELETE FROM users
WHERE email LIKE 'registration-%@projecthub.local'
   OR email LIKE '%integration%@projecthub.local'
   OR email LIKE 'tenant-%@%'
   OR name LIKE 'Integration %'
   OR email IN ('prpsix777@gmail.com', 'prptest@gmail.com');

-- Ensure every remaining user still has an active membership on the main company
INSERT INTO company_memberships
  (company_id, user_id, employee_code, status, approved_by, approved_at)
SELECT 1, u.id, CONCAT('KEEP-', u.id), 'active', 1, CURRENT_TIMESTAMP
FROM users u
WHERE NOT EXISTS (
  SELECT 1 FROM company_memberships cm
  WHERE cm.company_id = 1 AND cm.user_id = u.id
)
ON DUPLICATE KEY UPDATE status = 'active';

-- Activate pending real members that we intentionally keep
UPDATE company_memberships
SET status = 'active',
    approved_by = COALESCE(approved_by, 1),
    approved_at = COALESCE(approved_at, CURRENT_TIMESTAMP)
WHERE company_id = 1 AND status = 'pending';

UPDATE users
SET status = 'active',
    email_verified_at = COALESCE(email_verified_at, CURRENT_TIMESTAMP)
WHERE status <> 'active'
  AND email NOT LIKE 'registration-%@projecthub.local';

-- Rename primary company
UPDATE companies
SET name = 'Lee Fibreboard Co., Ltd.',
    slug = 'lee-fibreboard',
    is_active = TRUE,
    allow_registration = TRUE
WHERE id = 1;

-- Verify
SELECT id, name, slug FROM companies;
SELECT id, name, email, role, status FROM users ORDER BY id;
SELECT cm.id, u.email, cm.status, GROUP_CONCAT(r.name ORDER BY r.name) AS roles
FROM company_memberships cm
JOIN users u ON u.id = cm.user_id
LEFT JOIN membership_roles mr ON mr.membership_id = cm.id
LEFT JOIN roles r ON r.id = mr.role_id
WHERE cm.company_id = 1
GROUP BY cm.id, u.email, cm.status
ORDER BY cm.id;
SELECT
  (SELECT COUNT(*) FROM projects) AS projects,
  (SELECT COUNT(*) FROM issues) AS issues,
  (SELECT COUNT(*) FROM tasks) AS tasks,
  (SELECT COUNT(*) FROM notifications) AS notifications;
