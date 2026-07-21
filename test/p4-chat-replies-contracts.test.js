import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (relativePath) => readFile(new URL(relativePath, import.meta.url), "utf8");
const [issues, projects, migration, baseline, readme] = await Promise.all([
  read("../src/routes/issues.js"),
  read("../src/routes/projects.js"),
  read("../database/migration_p4_chat_replies.sql"),
  read("../database/lfbsmart_project.sql"),
  read("../../README.md"),
]);

test("P4 migration is rerunnable and database-enforces same conversation replies", () => {
  assert.match(migration, /information_schema\.columns/);
  assert.match(migration, /information_schema\.statistics/);
  assert.match(migration, /information_schema\.referential_constraints/);
  assert.match(migration, /FOREIGN KEY \(reply_to_id, issue_id\)/);
  assert.match(migration, /REFERENCES comments\(id, issue_id\) ON DELETE CASCADE/);
  assert.match(migration, /FOREIGN KEY \(reply_to_id, project_id\)/);
  assert.match(migration, /REFERENCES project_messages\(id, project_id\) ON DELETE CASCADE/);
  assert.match(baseline, /reply_to_id INT UNSIGNED NULL/);
  assert.match(readme, /migration_p4_chat_replies\.sql/);
});

test("Issue replies validate positive IDs and same-tenant conversation parents", () => {
  assert.match(issues, /replyToId ต้องเป็นจำนวนเต็มบวก/);
  assert.match(issues, /parent_issue\.company_id = \?/);
  assert.match(issues, /parent\.id = \? AND parent\.issue_id = \?/);
  assert.match(issues, /INSERT INTO comments \(issue_id, user_id, reply_to_id, body\)/);
  assert.match(issues, /reply_to_id: replyToId/);
  assert.match(issues, /reply_preview: parentPreview/);
});

test("Project replies validate positive IDs and same-tenant conversation parents", () => {
  assert.match(projects, /replyToId ต้องเป็นจำนวนเต็มบวก/);
  assert.match(projects, /parent_project\.company_id = \?/);
  assert.match(projects, /parent\.id = \? AND parent\.project_id = \?/);
  assert.match(projects, /INSERT INTO project_messages \(project_id, user_id, reply_to_id, body\)/);
  assert.match(projects, /reply_to_id: replyToId/);
  assert.match(projects, /reply_preview: parentPreview/);
});

test("List and socket payloads expose only bounded reply preview metadata", () => {
  for (const route of [issues, projects]) {
    assert.match(route, /LEFT\(parent\.body, 280\) reply_body/);
    assert.match(route, /reply_has_attachments/);
    assert.match(route, /body: body \|\| \(hasAttachments \? "ไฟล์แนบ" : ""\)/);
    assert.match(route, /reply_preview: replyPreview\(row\)/);
    assert.match(route, /emit\("(issue|project)Message", message\)/);
  }
});
