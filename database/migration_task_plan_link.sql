-- Migration: Add plan_id to tasks table to link Kanban tasks to Project Plan (weekly_plans)
ALTER TABLE tasks ADD COLUMN plan_id INT UNSIGNED NULL AFTER issue_id;
ALTER TABLE tasks ADD CONSTRAINT fk_tasks_plan FOREIGN KEY (plan_id) REFERENCES weekly_plans(id) ON DELETE SET NULL;
CREATE INDEX idx_tasks_plan ON tasks(plan_id);
