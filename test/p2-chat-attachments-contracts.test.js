import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (relativePath) => readFile(new URL(relativePath, import.meta.url), "utf8");
const [issues, migration, baseline, readme] = await Promise.all([
  read("../src/routes/issues.js"),
  read("../database/migration_p2_chat_attachments.sql"),
  read("../database/lfbsmart_project.sql"),
  read("../../README.md"),
]);

test("P2 migration is rerunnable on MariaDB and links attachments to comments", () => {
  assert.match(migration, /ADD COLUMN IF NOT EXISTS comment_id INT UNSIGNED NULL/);
  assert.match(migration, /information_schema\.statistics/);
  assert.match(migration, /information_schema\.referential_constraints/);
  assert.match(migration, /FOREIGN KEY \(comment_id\) REFERENCES comments\(id\) ON DELETE CASCADE/);
  assert.match(baseline, /comment_id INT UNSIGNED NULL/);
  assert.match(baseline, /FOREIGN KEY \(comment_id\) REFERENCES comments\(id\) ON DELETE CASCADE/);
  assert.match(readme, /migration_p2_chat_attachments\.sql/);
});

test("ticket attachment limits and lists exclude chat attachments", () => {
  const rootList = issues.match(
    /app\.get\("\/api\/issues\/:id\/attachments"[\s\S]*?res\.json\(rows\);/,
  )?.[0] || "";
  const rootUpload = issues.match(
    /app\.post\([\s\S]*?"\/api\/issues\/:id\/attachments"[\s\S]*?res\.status\(201\)/,
  )?.[0] || "";
  assert.match(rootList, /comment_id IS NULL/);
  assert.match(rootUpload, /COUNT\(\*\)[\s\S]*comment_id IS NULL/);
});

test("comment endpoint accepts JSON or multipart body-or-files as one transaction", () => {
  const route = issues.match(
    /app\.post\([\s\S]*?"\/api\/issues\/:id\/comments"[\s\S]*?\n  \);/,
  )?.[0] || "";
  assert.match(route, /upload\.array\("files", config\.attachments\.maxFiles\)/);
  assert.match(route, /!commentBody && !files\.length/);
  assert.match(route, /beginTransaction/);
  assert.match(route, /INSERT INTO comments/);
  assert.match(route, /comment_id, company_id/);
  assert.match(route, /unlink\(target\)/);
  assert.match(route, /attachments,/);
  assert.match(route, /commentBody \|\| "แนบไฟล์"/);
});

test("comment reads return attachment arrays and inline image access stays private", () => {
  assert.match(issues, /attachments: attachmentsByComment\.get\(Number\(row\.id\)\) \|\| \[\]/);
  const inlineRoute = issues.match(
    /app\.get\("\/api\/issues\/:id\/attachments\/:attachmentId\/inline"[\s\S]*?\}\)\);/,
  )?.[0] || "";
  assert.match(inlineRoute, /auth/);
  assert.match(inlineRoute, /getIssueById\(req\.params\.id, req\.user\.companyId\)/);
  assert.match(inlineRoute, /canViewIssue/);
  assert.match(inlineRoute, /company_id = \?/);
  assert.match(inlineRoute, /INLINE_IMAGE_TYPES/);
  assert.match(inlineRoute, /"Content-Disposition"[\s\S]*`inline;/);
  assert.match(inlineRoute, /"X-Content-Type-Options", "nosniff"/);
  assert.match(issues, /"Content-Disposition"[\s\S]*`attachment;/);
});
