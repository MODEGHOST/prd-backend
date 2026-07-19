USE prdproject;

ALTER TABLE issues
  ADD COLUMN IF NOT EXISTS board_status ENUM('todo', 'doing', 'review', 'done') NULL AFTER assignee_id;

UPDATE issues
SET board_status = CASE status
  WHEN 'accepted' THEN 'todo'
  WHEN 'in_progress' THEN 'doing'
  WHEN 'closed' THEN 'done'
  ELSE NULL
END;

INSERT INTO project_members (project_id, user_id, responsibility)
SELECT DISTINCT i.project_id, i.assignee_id, 'ดูแล Ticket'
FROM issues i
WHERE i.project_id IS NOT NULL AND i.assignee_id IS NOT NULL
ON DUPLICATE KEY UPDATE responsibility = COALESCE(project_members.responsibility, VALUES(responsibility));

INSERT INTO project_members (project_id, user_id, responsibility)
SELECT DISTINCT i.project_id, im.user_id, 'ร่วมดูแล Ticket'
FROM issues i
JOIN issue_members im ON im.issue_id = i.id
WHERE i.project_id IS NOT NULL
ON DUPLICATE KEY UPDATE responsibility = COALESCE(project_members.responsibility, VALUES(responsibility));

INSERT INTO tasks
  (project_id, issue_id, title, description, status, priority, assignee_id)
SELECT
  i.project_id,
  i.id,
  CONCAT(i.ticket_no, ' · ', i.title),
  i.description,
  i.board_status,
  i.priority,
  i.assignee_id
FROM issues i
WHERE i.project_id IS NOT NULL
  AND i.assignee_id IS NOT NULL
  AND i.status IN ('accepted', 'in_progress')
  AND NOT EXISTS (
    SELECT 1 FROM tasks linked WHERE linked.issue_id = i.id
  );
