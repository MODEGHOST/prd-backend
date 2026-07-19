USE prdproject;

UPDATE issues
SET status = 'closed'
WHERE status = 'resolved';

ALTER TABLE issues
  MODIFY status ENUM('open', 'accepted', 'in_progress', 'closed') NOT NULL DEFAULT 'open',
  ADD COLUMN estimated_completion_at DATETIME NULL AFTER assignee_id,
  ADD COLUMN accepted_at DATETIME NULL AFTER estimated_completion_at,
  ADD COLUMN started_at DATETIME NULL AFTER accepted_at,
  ADD COLUMN completed_at DATETIME NULL AFTER started_at;

UPDATE issues
SET completed_at = COALESCE(completed_at, updated_at)
WHERE status = 'closed';

UPDATE issues
SET status = 'accepted',
    accepted_at = COALESCE(accepted_at, updated_at)
WHERE status = 'open' AND assignee_id IS NOT NULL;

UPDATE issues
SET accepted_at = COALESCE(accepted_at, created_at),
    started_at = COALESCE(started_at, updated_at)
WHERE status = 'in_progress';

CREATE TABLE IF NOT EXISTS issue_members (
  issue_id INT UNSIGNED NOT NULL,
  user_id INT UNSIGNED NOT NULL,
  added_by INT UNSIGNED NOT NULL,
  joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (issue_id, user_id),
  FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (added_by) REFERENCES users(id)
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

INSERT INTO issue_activities (issue_id, actor_id, event_type, description, created_at)
SELECT id, requester_id, 'created', 'เปิด Ticket', created_at
FROM issues
WHERE NOT EXISTS (
  SELECT 1 FROM issue_activities activity
  WHERE activity.issue_id = issues.id AND activity.event_type = 'created'
);

INSERT INTO issue_activities (issue_id, actor_id, event_type, description, created_at)
SELECT id, assignee_id, 'accepted', 'รับเรื่องและเป็นผู้รับผิดชอบหลัก', accepted_at
FROM issues
WHERE assignee_id IS NOT NULL
  AND accepted_at IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM issue_activities activity
    WHERE activity.issue_id = issues.id AND activity.event_type = 'accepted'
  );

INSERT INTO issue_activities (issue_id, actor_id, event_type, description, created_at)
SELECT id, assignee_id, 'started', 'เริ่มดำเนินการ', started_at
FROM issues
WHERE started_at IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM issue_activities activity
    WHERE activity.issue_id = issues.id AND activity.event_type = 'started'
  );

INSERT INTO issue_activities (issue_id, actor_id, event_type, description, created_at)
SELECT id, assignee_id, 'completed', 'เสร็จสิ้นและปิด Ticket', completed_at
FROM issues
WHERE completed_at IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM issue_activities activity
    WHERE activity.issue_id = issues.id AND activity.event_type = 'completed'
  );
