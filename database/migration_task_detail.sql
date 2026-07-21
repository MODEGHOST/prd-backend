USE lfbsmart_project;

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS difficulty ENUM('easy', 'medium', 'hard')
    NOT NULL DEFAULT 'medium' AFTER priority;
