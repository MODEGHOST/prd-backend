import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (relativePath) => readFile(new URL(relativePath, import.meta.url), "utf8");
const [projects, helpers, migration, baseline, api, miniChat, projectDetail, readme] =
  await Promise.all([
    read("../src/routes/projects.js"),
    read("../src/core/attachments.js"),
    read("../database/migration_p3_project_chat_attachments.sql"),
    read("../database/prdproject.sql"),
    read("../../frontend/src/services/api.js"),
    read("../../frontend/src/components/chat/MiniChatDock.jsx"),
    read("../../frontend/src/pages/ProjectDetailPage.jsx"),
    read("../../README.md"),
  ]);

test("P3 migration is rerunnable and enforces project attachment tenancy", () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS project_message_attachments/);
  assert.match(migration, /information_schema\.statistics/);
  assert.match(migration, /FOREIGN KEY \(project_id, company_id\)/);
  assert.match(migration, /REFERENCES projects\(id, company_id\) ON DELETE CASCADE/);
  assert.match(migration, /FOREIGN KEY \(message_id, project_id\)/);
  assert.match(migration, /REFERENCES project_messages\(id, project_id\) ON DELETE CASCADE/);
  assert.match(baseline, /CREATE TABLE IF NOT EXISTS project_message_attachments/);
  assert.match(readme, /migration_p3_project_chat_attachments\.sql/);
});

test("project messages accept JSON or multipart body-or-files transactionally", () => {
  const route = projects.match(
    /app\.post\([\s\S]*?"\/api\/projects\/:id\/messages"[\s\S]*?\n  \);/,
  )?.[0] || "";
  assert.match(route, /upload\.array\("files", config\.attachments\.maxFiles\)/);
  assert.match(route, /!body && !files\.length/);
  assert.match(route, /validAttachment/);
  assert.match(route, /beginTransaction/);
  assert.match(route, /company_id = \? FOR UPDATE/);
  assert.match(route, /INSERT INTO project_message_attachments/);
  assert.match(route, /unlink\(target\)/);
  assert.match(route, /attachments,/);
  assert.match(route, /body \|\| "แนบไฟล์"/);
});

test("project message reads and socket payloads include attachment arrays", () => {
  assert.match(projects, /attachments: attachmentsByMessage\.get\(Number\(row\.id\)\) \|\| \[\]/);
  assert.match(projects, /emit\("projectMessage", message\)/);
  assert.match(projects, /body,\s*attachments,/);
});

test("project attachment responses are authenticated, tenant-bound, and safe", () => {
  assert.match(projects, /messages\/:messageId\/attachments\/:attachmentId\/download/);
  assert.match(projects, /messages\/:messageId\/attachments\/:attachmentId\/inline/);
  assert.match(projects, /canAccessProject\(req\.user, projectId\)/);
  assert.match(projects, /message_id = \? AND project_id = \? AND company_id = \?/);
  assert.match(projects, /"X-Content-Type-Options", "nosniff"/);
  assert.match(projects, /`attachment; filename\*=UTF-8''/);
  assert.match(projects, /`inline; filename\*=UTF-8''/);
  assert.match(helpers, /\^\[a-f0-9\]\{48\}\$/);
});

test("mini and full project chat use real attachment APIs and compact composer", () => {
  assert.match(api, /sendMessage: \(id, body, files = \[\], replyToId = null\)/);
  assert.match(api, /loadInlineAttachment: \(projectId, messageId, attachmentId\)/);
  assert.match(api, /downloadAttachment: \(projectId, messageId, attachmentId\)/);
  assert.match(miniChat, /<CompactChatComposer/);
  assert.match(miniChat, /<ChatMessageAttachments/);
  assert.match(projectDetail, /<CompactChatComposer/);
  assert.match(projectDetail, /<ChatMessageAttachments/);
});
