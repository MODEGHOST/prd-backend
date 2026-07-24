-- Project brief + PRD structured fields
-- Safe to re-run on MariaDB/MySQL that supports IF NOT EXISTS

USE lfbsmart_project;

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS objective TEXT NULL AFTER prd,
  ADD COLUMN IF NOT EXISTS problem TEXT NULL AFTER objective,
  ADD COLUMN IF NOT EXISTS expected_outcome TEXT NULL AFTER problem,
  ADD COLUMN IF NOT EXISTS extra_details TEXT NULL AFTER expected_outcome,
  ADD COLUMN IF NOT EXISTS main_requirements TEXT NULL AFTER extra_details,
  ADD COLUMN IF NOT EXISTS business_rules TEXT NULL AFTER main_requirements;

-- Best-effort backfill for legacy free-text rows (structured text is hydrated in app layer)
UPDATE projects
SET extra_details = description
WHERE (extra_details IS NULL OR extra_details = '')
  AND description IS NOT NULL
  AND description <> ''
  AND description NOT LIKE '%วัตถุประสงค์:%';

UPDATE projects
SET main_requirements = prd
WHERE (main_requirements IS NULL OR main_requirements = '')
  AND prd IS NOT NULL
  AND prd <> ''
  AND prd NOT LIKE '%ฟีเจอร์/ความต้องการหลัก:%'
  AND prd NOT LIKE '%ผู้ใช้งานหลัก:%';
