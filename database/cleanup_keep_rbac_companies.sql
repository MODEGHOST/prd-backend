-- Wipe operational data for a fresh start.
-- Keeps: companies, roles, permissions, role_permissions, schema_migrations
-- Removes: users and all transactional / membership / content tables
-- Safe to re-run.

USE lfbsmart_project;

SET FOREIGN_KEY_CHECKS = 0;

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
TRUNCATE TABLE membership_roles;
TRUNCATE TABLE company_memberships;
TRUNCATE TABLE users;

SET FOREIGN_KEY_CHECKS = 1;

-- Verify retained catalogs
SELECT id, name, slug, is_active, allow_registration FROM companies ORDER BY id;
SELECT COUNT(*) AS roles FROM roles;
SELECT COUNT(*) AS permissions FROM permissions;
SELECT COUNT(*) AS role_permissions FROM role_permissions;
SELECT COUNT(*) AS users FROM users;
SELECT COUNT(*) AS memberships FROM company_memberships;
SELECT COUNT(*) AS projects FROM projects;
SELECT COUNT(*) AS issues FROM issues;
