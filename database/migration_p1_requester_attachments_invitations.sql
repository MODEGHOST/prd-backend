USE prdproject;

-- P1 requester context, private attachments, and invitation workflow.
-- Rerunnable on MySQL 8+.
ALTER TABLE issues
  ADD COLUMN IF NOT EXISTS system_component VARCHAR(160) NULL AFTER project_id;

CREATE TABLE IF NOT EXISTS issue_attachments (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  issue_id INT UNSIGNED NOT NULL,
  company_id INT UNSIGNED NOT NULL,
  uploaded_by INT UNSIGNED NOT NULL,
  storage_name CHAR(64) NOT NULL,
  original_name VARCHAR(255) NOT NULL,
  mime_type VARCHAR(120) NOT NULL,
  size_bytes INT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_issue_attachments_storage (storage_name),
  KEY idx_issue_attachments_issue (issue_id, created_at),
  CONSTRAINT fk_issue_attachments_issue FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE,
  CONSTRAINT fk_issue_attachments_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  CONSTRAINT fk_issue_attachments_uploader FOREIGN KEY (uploaded_by) REFERENCES users(id)
);

ALTER TABLE invitations
  ADD COLUMN IF NOT EXISTS status ENUM('pending','accepted','revoked','expired') NOT NULL DEFAULT 'pending' AFTER employee_code,
  ADD COLUMN IF NOT EXISTS roles_json JSON NULL AFTER status,
  ADD COLUMN IF NOT EXISTS revoked_at DATETIME NULL AFTER accepted_at,
  ADD COLUMN IF NOT EXISTS accepted_by INT UNSIGNED NULL AFTER accepted_at,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP AFTER created_at;

UPDATE invitations
SET status = CASE
  WHEN revoked_at IS NOT NULL THEN 'revoked'
  WHEN accepted_at IS NOT NULL THEN 'accepted'
  WHEN expires_at <= NOW() THEN 'expired'
  ELSE 'pending'
END;
