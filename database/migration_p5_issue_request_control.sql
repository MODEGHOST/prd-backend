USE lfbsmart_project;

ALTER TABLE issues
  MODIFY status ENUM(
    'open',
    'accepted',
    'in_progress',
    'closed',
    'cancelled',
    'rejected'
  ) NOT NULL DEFAULT 'open',
  ADD COLUMN cancelled_at DATETIME NULL AFTER completed_at,
  ADD COLUMN rejection_reason TEXT NULL AFTER cancelled_at,
  ADD COLUMN rejected_by INT UNSIGNED NULL AFTER rejection_reason,
  ADD COLUMN rejected_at DATETIME NULL AFTER rejected_by,
  ADD CONSTRAINT fk_issues_rejected_by
    FOREIGN KEY (rejected_by) REFERENCES users(id) ON DELETE SET NULL;

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code = 'issues.update'
WHERE r.name = 'requester';
