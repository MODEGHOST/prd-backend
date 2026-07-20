import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { loadConfig } from "../src/core/config.js";

const read = (relativePath) => readFile(new URL(relativePath, import.meta.url), "utf8");

const [issues, projects, invitations, attachments, migration, baseline, projectForm] = await Promise.all([
  read("../src/routes/issues.js"),
  read("../src/routes/projects.js"),
  read("../src/routes/invitations.js"),
  read("../src/core/attachments.js"),
  read("../database/migration_p1_requester_attachments_invitations.sql"),
  read("../database/prdproject.sql"),
  read("../../frontend/src/components/forms/ProjectForm.jsx"),
]);

test("requester project picker exposes only safe active-company fields", () => {
  assert.match(projects, /SELECT id, code, name[\s\S]*company_id = \? AND status = 'active'/);
  assert.match(issues, /WHERE id = \? AND company_id = \? AND status = 'active'/);
  assert.doesNotMatch(projects.match(/app\.get\("\/api\/projects\/picker"[\s\S]*?\}\)\);/)?.[0] || "", /description|team|task/);
});

test("attachment storage is private, randomized, tenant checked, and bounded", () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS issue_attachments/);
  assert.match(baseline, /CREATE TABLE IF NOT EXISTS issue_attachments/);
  assert.match(attachments, /path\.basename/);
  assert.match(attachments, /sniffMimeType/);
  assert.match(attachments, /sniffed && sniffed !== file\.mimetype/);
  assert.match(issues, /randomBytes\(24\)\.toString\("hex"\)/);
  assert.match(issues, /company_id = \?/);
  assert.match(issues, /canViewIssue/);
  assert.match(issues, /Content-Disposition/);
  assert.match(issues, /X-Content-Type-Options", "nosniff"/);
  assert.match(attachments, /maxFiles/);
  assert.match(attachments, /fileSize/);
  assert.doesNotMatch(issues, /express\.static/);
});

test("attachment limits are configurable and reject unsafe values", () => {
  const config = loadConfig({
    ATTACHMENT_STORAGE_DIR: "private-files",
    ATTACHMENT_MAX_FILES: "3",
    ATTACHMENT_MAX_BYTES: "1024",
  });
  assert.equal(config.attachments.directory, "private-files");
  assert.equal(config.attachments.maxFiles, 3);
  assert.equal(config.attachments.maxBytes, 1024);
  assert.throws(() => loadConfig({ ATTACHMENT_MAX_FILES: "0" }), /ATTACHMENT_MAX_FILES/);
});

test("invites store token hashes and enforce role hierarchy and matching email", () => {
  assert.match(migration, /roles_json JSON/);
  assert.match(invitations, /createOneTimeToken/);
  assert.match(invitations, /canAssignCompanyRole/);
  assert.match(invitations, /INVITE_ROLE_HIERARCHY_DENIED/);
  assert.match(invitations, /invitation\.email\.toLowerCase\(\) !== req\.user\.email\.toLowerCase\(\)/);
  assert.match(invitations, /beginTransaction/);
  assert.doesNotMatch(invitations, /INSERT[\s\S]{0,120}\btoken\b(?!_hash)/);
});

test("MVP project writes ignore client budget and always use 0 THB", () => {
  assert.match(projects, /req\.body[\s\S]*0,[\s\S]*"THB"/);
  assert.doesNotMatch(projectForm, /InputNumber|CURRENCY_OPTIONS|name="budget"|name="currency"/);
  assert.doesNotMatch(projects, /fields\.push\("budget = \?"\)|fields\.push\("currency = \?"\)/);
});

test("ticket numbers are readable and collision resistant with database retry", () => {
  assert.match(issues, /ISS-\$\{date\}-\$\{randomBytes\(5\)/);
  assert.match(issues, /for \(let attempt = 0; attempt < 4/);
  assert.match(issues, /ER_DUP_ENTRY/);
  assert.doesNotMatch(issues, /Date\.now\(\)\.toString\(\)\.slice/);
});

test("new tickets notify every active member who can read and accept issues", () => {
  assert.match(issues, /permission\.code IN \('issues\.read_all', 'issues\.accept', 'issues\.manage_all'\)/);
  assert.match(issues, /MAX\(permission\.code = 'issues\.read_all'\)/);
  assert.match(issues, /MAX\(permission\.code = 'issues\.accept'\)/);
  assert.match(issues, /issueResponders\.map/);
  assert.match(issues, /actorId: req\.user\.id/);
});
