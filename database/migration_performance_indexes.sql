USE prdproject;

-- Speed up board / my-tasks / project progress at 500+ tasks scale.
-- Safe to rerun: every index is checked before it is created.
DELIMITER $$
DROP PROCEDURE IF EXISTS apply_performance_indexes$$
CREATE PROCEDURE apply_performance_indexes()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'tasks'
      AND index_name IN ('idx_tasks_board', 'idx_tasks_project_status')
  ) THEN
    ALTER TABLE tasks
      ADD INDEX idx_tasks_project_status (project_id, status, position);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'tasks'
      AND index_name = 'idx_tasks_assignee'
  ) THEN
    ALTER TABLE tasks ADD INDEX idx_tasks_assignee (assignee_id, status);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'tasks'
      AND index_name = 'idx_tasks_issue'
  ) THEN
    ALTER TABLE tasks ADD INDEX idx_tasks_issue (issue_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'issues'
      AND index_name = 'idx_issues_project_status'
  ) THEN
    ALTER TABLE issues ADD INDEX idx_issues_project_status (project_id, status);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'issues'
      AND index_name = 'idx_issues_assignee_status'
  ) THEN
    ALTER TABLE issues ADD INDEX idx_issues_assignee_status (assignee_id, status);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'issues'
      AND index_name = 'idx_issues_requester'
  ) THEN
    ALTER TABLE issues ADD INDEX idx_issues_requester (requester_id, updated_at);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'issue_members'
      AND index_name = 'idx_issue_members_user'
  ) THEN
    ALTER TABLE issue_members ADD INDEX idx_issue_members_user (user_id, issue_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'project_members'
      AND index_name = 'idx_project_members_user'
  ) THEN
    ALTER TABLE project_members ADD INDEX idx_project_members_user (user_id, project_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'comments'
      AND index_name = 'idx_comments_issue'
  ) THEN
    ALTER TABLE comments ADD INDEX idx_comments_issue (issue_id, created_at);
  END IF;
END$$

CALL apply_performance_indexes()$$
DROP PROCEDURE apply_performance_indexes$$
DELIMITER ;
