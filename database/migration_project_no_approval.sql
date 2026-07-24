-- Remove project approval gate: existing pending projects become active immediately.

USE lfbsmart_project;

UPDATE projects
SET status = 'active',
    approved_by = COALESCE(approved_by, created_by),
    approved_at = COALESCE(approved_at, NOW())
WHERE status = 'pending';
