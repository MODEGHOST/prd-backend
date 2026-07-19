import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (relativePath) =>
  readFile(new URL(relativePath, import.meta.url), "utf8");

const [migration, projects, issues, publicAuth, memberships, authMiddleware] =
  await Promise.all([
    read("../database/migration_p0_group_admin_project_approval.sql"),
    read("../src/routes/projects.js"),
    read("../src/routes/issues.js"),
    read("../src/routes/public-auth.js"),
    read("../src/routes/company-membership.js"),
    read("../src/middleware/auth.js"),
  ]);

test("P0 migration safely promotes legacy owners and corrects project permissions", () => {
  assert.match(migration, /ADD COLUMN IF NOT EXISTS approved_at/);
  assert.match(migration, /INSERT IGNORE INTO membership_roles[\s\S]*company_owner/);
  assert.match(migration, /DELETE mr[\s\S]*r\.name = 'company_owner'/);
  assert.match(
    migration,
    /r\.name = 'dev'[\s\S]*projects\.create[\s\S]*projects\.status\.update/,
  );
  assert.match(
    migration,
    /projects\.create[\s\S]*projects\.status\.update[\s\S]*r\.name = 'project_manager'/,
  );
});

test("new projects always await an explicit approval decision", () => {
  assert.match(projects, /"pending",[\s\S]*owner,[\s\S]*null,[\s\S]*req\.user\.id/);
  assert.doesNotMatch(
    projects,
    /const status = hasPermission\(req\.user, "projects\.manage_all"\)/,
  );
  assert.doesNotMatch(
    issues,
    /const status = hasPermission\(req\.user, "projects\.manage_all"\)/,
  );
  assert.match(projects, /approved_at = CASE WHEN \? THEN NOW\(\)/);
  assert.match(projects, /project\.\$\{nextStatus\}/);
});

test("company switching depends on active membership, not a role permission", () => {
  assert.match(
    publicAuth,
    /app\.post\("\/api\/auth\/switch-company", auth, wrap/,
  );
  assert.match(publicAuth, /const switched = await loadSession/);
});

test("unverified accounts cannot receive or reuse an authenticated session", () => {
  assert.match(publicAuth, /if \(!user\.email_verified_at\)/);
  assert.match(authMiddleware, /if \(!account\.email_verified_at\)/);
  assert.doesNotMatch(
    memberships,
    /UPDATE users SET status = 'active' WHERE id = \? AND status = 'pending'/,
  );
});
