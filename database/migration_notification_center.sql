USE lfbsmart_project;

ALTER TABLE notifications
  ADD COLUMN type VARCHAR(32) NOT NULL DEFAULT 'general' AFTER message,
  ADD COLUMN target_url VARCHAR(500) NULL AFTER type,
  ADD COLUMN entity_type VARCHAR(32) NULL AFTER target_url,
  ADD COLUMN entity_id INT UNSIGNED NULL AFTER entity_type,
  ADD COLUMN actor_name VARCHAR(220) NULL AFTER entity_id,
  ADD INDEX idx_notifications_created (user_id, created_at);
