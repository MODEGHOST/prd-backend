import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import path from "node:path";
import mysql from "mysql2/promise";

const enabled = process.env.RUN_INTEGRATION === "1";
const port = Number(process.env.INTEGRATION_PORT || 4100);
const baseUrl = `http://127.0.0.1:${port}`;
let child;
let pool;
let foreignProjectId;
let foreignCompanyId;
let foreignMembershipId;
let registeredUserId;
let registeredUserEmail;
let registeredUsername;
let developerVisibilityIssueId;
let hierarchyTargetMembershipId;
let hierarchyTargetOriginalRoleIds = [];
let hierarchyCustomRoleId;
let passwordResetTokenId;
let passwordResetOutboxId;
let approvalProjectId;
let p2IssueId;
let p4OtherIssueId;
let p2StorageNames = [];
let p3StorageNames = [];
let childStderr = "";
const loginCache = new Map();

async function waitForHealth() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // server is still starting
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Integration API did not become healthy");
}

async function login(email, { fresh = false } = {}) {
  if (!fresh && loginCache.has(email)) return loginCache.get(email);
  const username = String(email || "").includes("@")
    ? String(email).split("@")[0]
    : String(email || "");
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password: "Password123!" }),
  });
  assert.equal(response.status, 200);
  const session = await response.json();
  loginCache.set(email, session);
  return session;
}

before(async () => {
  if (!enabled) return;
  pool = mysql.createPool({
    host: process.env.DB_HOST || "127.0.0.1",
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_NAME || "lfbsmart_project",
  });
  const [[requester]] = await pool.execute(
    "SELECT id FROM users WHERE email = 'requester@projecthub.local'",
  );
  assert.ok(requester?.id, "requester fixture is missing");
  const slug = `tenant-b-${randomUUID()}`;
  const [company] = await pool.execute(
    `INSERT INTO companies (name, slug, is_active, allow_registration)
     VALUES ('Tenant B Integration', ?, TRUE, FALSE)`,
    [slug],
  );
  const companyId = Number(company.insertId);
  foreignCompanyId = companyId;
  const [membership] = await pool.execute(
    `INSERT INTO company_memberships
      (company_id, user_id, employee_code, status, approved_at)
     VALUES (?, ?, ?, 'active', NOW())`,
    [companyId, requester.id, `TENANT-B-${requester.id}`],
  );
  foreignMembershipId = Number(membership.insertId);
  const [[requesterRole]] = await pool.execute(
    "SELECT id FROM roles WHERE name = 'requester' AND company_id IS NULL",
  );
  await pool.execute(
    "INSERT IGNORE INTO membership_roles (membership_id, role_id) VALUES (?, ?)",
    [foreignMembershipId, requesterRole.id],
  );
  const [project] = await pool.execute(
    `INSERT INTO projects
      (company_id, name, code, status, owner_id, created_by, budget, currency)
     VALUES (?, 'Tenant B Secret', 'SHARED-001', 'active', ?, ?, 0, 'THB')`,
    [companyId, requester.id, requester.id],
  );
  foreignProjectId = Number(project.insertId);

  const childEnv = {
    ...process.env,
    PORT: String(port),
    NODE_ENV: "test",
    REDIS_URL: "",
  };
  // A regular application subprocess must not register itself as a nested
  // node:test worker.
  delete childEnv.NODE_TEST_CONTEXT;
  child = spawn(process.execPath, ["src/server.js"], {
    cwd: new URL("..", import.meta.url),
    env: childEnv,
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.on("data", (chunk) => {
    childStderr += chunk.toString();
  });
  await waitForHealth();
});

after(async () => {
  if (!enabled) return;
  if (child && child.exitCode == null) {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    await Promise.race([
      exited,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(
          `Integration API did not stop after SIGTERM: ${childStderr.slice(-2000)}`,
        )), 15_000)),
    ]);
  }
  try {
    if (hierarchyTargetMembershipId && hierarchyTargetOriginalRoleIds.length) {
      await pool?.execute(
        "DELETE FROM membership_roles WHERE membership_id = ?",
        [hierarchyTargetMembershipId],
      );
      for (const roleId of hierarchyTargetOriginalRoleIds) {
        await pool?.execute(
          "INSERT INTO membership_roles (membership_id, role_id) VALUES (?, ?)",
          [hierarchyTargetMembershipId, roleId],
        );
      }
    }
    if (hierarchyCustomRoleId) {
      await pool?.execute("DELETE FROM roles WHERE id = ?", [hierarchyCustomRoleId]);
    }
    if (developerVisibilityIssueId) {
      await pool?.execute("DELETE FROM issues WHERE id = ?", [developerVisibilityIssueId]);
    }
    if (p2IssueId) {
      await pool?.execute("DELETE FROM issues WHERE id = ?", [p2IssueId]);
      const attachmentDirectory = path.resolve(
        process.env.ATTACHMENT_STORAGE_DIR || "./storage/issue-attachments",
      );
      await Promise.all(p2StorageNames.map((storageName) =>
        unlink(path.join(attachmentDirectory, storageName)).catch(() => {})));
    }
    if (p4OtherIssueId) {
      await pool?.execute("DELETE FROM issues WHERE id = ?", [p4OtherIssueId]);
    }
    if (p3StorageNames.length) {
      const attachmentDirectory = path.resolve(
        process.env.ATTACHMENT_STORAGE_DIR || "./storage/issue-attachments",
        "project-chat",
      );
      await Promise.all(p3StorageNames.map((storageName) =>
        unlink(path.join(attachmentDirectory, storageName)).catch(() => {})));
    }
    if (foreignProjectId) {
      await pool?.execute("DELETE FROM projects WHERE id = ?", [foreignProjectId]);
    }
    if (approvalProjectId) {
      await pool?.execute(
        "DELETE FROM audit_logs WHERE entity_type = 'project' AND entity_id = ?",
        [String(approvalProjectId)],
      );
      await pool?.execute("DELETE FROM projects WHERE id = ?", [approvalProjectId]);
    }
    if (registeredUserId) {
      await pool?.execute(
        `DELETE oe FROM outbox_events oe
         JOIN notifications n
           ON oe.aggregate_type = 'notification'
          AND CAST(oe.aggregate_id AS UNSIGNED) = n.id
         WHERE n.entity_type = 'membership' AND n.entity_id = ?`,
        [registeredUserId],
      );
      await pool?.execute(
        "DELETE FROM notifications WHERE entity_type = 'membership' AND entity_id = ?",
        [registeredUserId],
      );
      await pool?.execute(
        "DELETE FROM outbox_events WHERE aggregate_type = 'user' AND aggregate_id = ?",
        [String(registeredUserId)],
      );
      await pool?.execute("DELETE FROM users WHERE id = ?", [registeredUserId]);
    }
    if (passwordResetOutboxId) {
      await pool?.execute("DELETE FROM outbox_events WHERE id = ?", [passwordResetOutboxId]);
    }
    if (passwordResetTokenId) {
      await pool?.execute("DELETE FROM password_reset_tokens WHERE id = ?", [passwordResetTokenId]);
    }
    if (foreignMembershipId) {
      await pool?.execute("DELETE FROM company_memberships WHERE id = ?", [foreignMembershipId]);
    }
    if (foreignCompanyId) {
      await pool?.execute("DELETE FROM companies WHERE id = ?", [foreignCompanyId]);
    }
  } finally {
    await pool?.end();
  }
});

test("company A cannot read a project belonging to company B", { skip: !enabled }, async () => {
  const session = await login("admin@projecthub.local");
  const response = await fetch(`${baseUrl}/api/projects/${foreignProjectId}`, {
    headers: { authorization: `Bearer ${session.token}` },
  });
  assert.equal(response.status, 404);
});

test("company A cannot mutate a project belonging to company B", { skip: !enabled }, async () => {
  const session = await login("admin@projecthub.local");
  const response = await fetch(`${baseUrl}/api/projects/${foreignProjectId}/status`, {
    method: "PATCH",
    headers: {
      authorization: `Bearer ${session.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ status: "completed" }),
  });
  assert.equal(response.status, 404);
});

test("project creation is pending and its creator can explicitly approve it", { skip: !enabled }, async () => {
  const admin = await login("admin@projecthub.local");
  const suffix = randomUUID().slice(0, 8).toUpperCase();
  const createResponse = await fetch(`${baseUrl}/api/projects`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${admin.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      name: "P0 approval integration",
      code: `P0-${suffix}`,
      ownerId: admin.user.id,
    }),
  });
  assert.equal(createResponse.status, 201);
  approvalProjectId = Number((await createResponse.json()).id);

  const [[created]] = await pool.execute(
    "SELECT status, approved_by, approved_at FROM projects WHERE id = ?",
    [approvalProjectId],
  );
  assert.equal(created.status, "pending");
  assert.equal(created.approved_by, null);
  assert.equal(created.approved_at, null);

  const approveResponse = await fetch(
    `${baseUrl}/api/projects/${approvalProjectId}/status`,
    {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${admin.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ status: "active" }),
    },
  );
  assert.equal(approveResponse.status, 200);
  const [[approved]] = await pool.execute(
    "SELECT status, approved_by, approved_at FROM projects WHERE id = ?",
    [approvalProjectId],
  );
  assert.equal(approved.status, "active");
  assert.equal(Number(approved.approved_by), Number(admin.user.id));
  assert.ok(approved.approved_at);
  const [[auditRow]] = await pool.execute(
    `SELECT id FROM audit_logs
     WHERE company_id = ? AND action = 'project.active'
       AND entity_type = 'project' AND entity_id = ?`,
    [admin.user.companyId, String(approvalProjectId)],
  );
  assert.ok(auditRow?.id);
});

test("developers cannot approve projects", { skip: !enabled }, async () => {
  const developer = await login("developer@projecthub.local");
  const response = await fetch(
    `${baseUrl}/api/projects/${approvalProjectId}/status`,
    {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${developer.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ status: "rejected" }),
    },
  );
  assert.equal(response.status, 403);
});

test("any active membership can switch company without company.switch", { skip: !enabled }, async () => {
  const requester = await login("requester@projecthub.local");
  assert.equal(requester.user.permissions.includes("company.switch"), false);
  const response = await fetch(`${baseUrl}/api/auth/switch-company`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${requester.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ companyId: foreignCompanyId }),
  });
  assert.equal(response.status, 200);
  const switched = await response.json();
  assert.equal(Number(switched.user.companyId), foreignCompanyId);
});

test("database rejects attaching a tenant role to another company", { skip: !enabled }, async () => {
  const roleName = `tenant_b_${randomUUID().replaceAll("-", "")}`;
  const [role] = await pool.execute(
    `INSERT INTO roles (company_id, name, label, is_system)
     VALUES (?, ?, 'Tenant B Integration Role', FALSE)`,
    [foreignCompanyId, roleName],
  );
  const [[adminMembership]] = await pool.execute(
    `SELECT cm.id
     FROM company_memberships cm
     JOIN users u ON u.id = cm.user_id
     WHERE u.email = 'admin@projecthub.local' AND cm.company_id <> ?
     LIMIT 1`,
    [foreignCompanyId],
  );
  assert.ok(adminMembership?.id, "admin membership fixture is missing");
  await assert.rejects(
    pool.execute(
      "INSERT INTO membership_roles (membership_id, role_id) VALUES (?, ?)",
      [adminMembership.id, role.insertId],
    ),
    /same company|Membership role/i,
  );
});

test("registration commits its verification email to the durable outbox", { skip: !enabled }, async () => {
  const [[company]] = await pool.execute(
    "SELECT id FROM companies WHERE allow_registration = TRUE AND is_active = TRUE LIMIT 1",
  );
  assert.ok(company?.id, "registration company fixture is missing");
  const suffix = randomUUID().replaceAll("-", "");
  registeredUserEmail = `registration-${suffix}@projecthub.local`;
  registeredUsername = `user_${suffix.slice(0, 12)}`;
  const response = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      employeeCode: String(Date.now()).slice(-8),
      firstName: "Integration",
      lastName: "Registration",
      username: registeredUsername,
      email: registeredUserEmail,
      password: "Password123!",
      companyId: company.id,
    }),
  });
  assert.equal(response.status, 201);
  const result = await response.json();
  registeredUserId = Number(result.id);
  const [[emailEvent]] = await pool.execute(
    `SELECT id, status
     FROM outbox_events
     WHERE event_type = 'email.send'
       AND aggregate_type = 'user'
       AND aggregate_id = ?`,
    [String(registeredUserId)],
  );
  assert.ok(emailEvent?.id, "verification email was not enqueued");
});

test("membership approval cannot bypass email verification", { skip: !enabled }, async () => {
  const admin = await login("admin@projecthub.local");
  const [[membership]] = await pool.execute(
    "SELECT id FROM company_memberships WHERE user_id = ?",
    [registeredUserId],
  );
  assert.ok(membership?.id, "registered membership fixture is missing");

  const approvalResponse = await fetch(
    `${baseUrl}/api/company/members/${membership.id}/status`,
    {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${admin.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ status: "active" }),
    },
  );
  assert.equal(approvalResponse.status, 200);

  const [[approvedUser]] = await pool.execute(
    "SELECT status, email_verified_at FROM users WHERE id = ?",
    [registeredUserId],
  );
  assert.equal(approvedUser.status, "pending");
  assert.equal(approvedUser.email_verified_at, null);

  const approvedLogin = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: registeredUsername,
      password: "Password123!",
    }),
  });
  assert.equal(approvedLogin.status, 403);
  assert.equal((await approvedLogin.json()).code, "EMAIL_NOT_VERIFIED");

  const [[beforeReset]] = await pool.execute(
    "SELECT COUNT(*) count FROM password_reset_tokens WHERE user_id = ?",
    [registeredUserId],
  );
  const forgotResponse = await fetch(`${baseUrl}/api/auth/forgot-password`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: registeredUserEmail }),
  });
  assert.equal(forgotResponse.status, 200);
  const [[afterReset]] = await pool.execute(
    "SELECT COUNT(*) count FROM password_reset_tokens WHERE user_id = ?",
    [registeredUserId],
  );
  assert.equal(Number(afterReset.count), Number(beforeReset.count));

  const [[beforeVerification]] = await pool.execute(
    "SELECT COUNT(*) count FROM email_verification_tokens WHERE user_id = ?",
    [registeredUserId],
  );
  const [[beforeVerificationOutbox]] = await pool.execute(
    `SELECT COUNT(*) count FROM outbox_events
     WHERE aggregate_type = 'user'
       AND aggregate_id = ?
       AND dedupe_key LIKE 'email.verify:%'`,
    [String(registeredUserId)],
  );
  const resendResponse = await fetch(`${baseUrl}/api/auth/resend-verification`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: registeredUserEmail }),
  });
  assert.equal(resendResponse.status, 200);
  const [[afterVerification]] = await pool.execute(
    "SELECT COUNT(*) count FROM email_verification_tokens WHERE user_id = ?",
    [registeredUserId],
  );
  const [[afterVerificationOutbox]] = await pool.execute(
    `SELECT COUNT(*) count FROM outbox_events
     WHERE aggregate_type = 'user'
       AND aggregate_id = ?
       AND dedupe_key LIKE 'email.verify:%'`,
    [String(registeredUserId)],
  );
  assert.equal(
    Number(afterVerification.count),
    Number(beforeVerification.count) + 1,
  );
  assert.equal(
    Number(afterVerificationOutbox.count),
    Number(beforeVerificationOutbox.count) + 1,
  );
  await pool.execute(
    "UPDATE users SET email_verified_at = NOW(), status = 'active' WHERE id = ?",
    [registeredUserId],
  );
});

test("developers see all tickets but unrelated assigned tickets are read-only", { skip: !enabled }, async () => {
  const requester = await login(registeredUsername);
  const createResponse = await fetch(`${baseUrl}/api/issues`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${requester.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      title: "Developer visibility integration ticket",
      description: "Ticket must be visible but protected after assignment.",
      type: "support",
    }),
  });
  assert.equal(createResponse.status, 201);
  const created = await createResponse.json();
  developerVisibilityIssueId = Number(created.id);

  const developer = await login("developer@projecthub.local");
  const listResponse = await fetch(`${baseUrl}/api/issues?limit=200`, {
    headers: { authorization: `Bearer ${developer.token}` },
  });
  assert.equal(listResponse.status, 200);
  const list = await listResponse.json();
  assert.equal(
    list.items.some((issue) => Number(issue.id) === developerVisibilityIssueId),
    true,
  );

  const unassignedDetailResponse = await fetch(
    `${baseUrl}/api/issues/${developerVisibilityIssueId}`,
    { headers: { authorization: `Bearer ${developer.token}` } },
  );
  assert.equal(unassignedDetailResponse.status, 200);
  const unassignedDetail = await unassignedDetailResponse.json();
  assert.equal(unassignedDetail.permissions.canAccept, true);
  assert.equal(unassignedDetail.permissions.canUpdate, false);
  assert.equal(unassignedDetail.permissions.canWork, false);
  assert.equal(unassignedDetail.permissions.canComment, false);

  const admin = await login("admin@projecthub.local");
  const assignResponse = await fetch(
    `${baseUrl}/api/issues/${developerVisibilityIssueId}/assign`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${admin.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ assigneeId: admin.user.id }),
    },
  );
  assert.equal(assignResponse.status, 200);

  const assignedDetailResponse = await fetch(
    `${baseUrl}/api/issues/${developerVisibilityIssueId}`,
    { headers: { authorization: `Bearer ${developer.token}` } },
  );
  assert.equal(assignedDetailResponse.status, 200);
  const assignedDetail = await assignedDetailResponse.json();
  assert.equal(assignedDetail.permissions.canAccept, false);
  assert.equal(assignedDetail.permissions.canUpdate, false);
  assert.equal(assignedDetail.permissions.canManageMembers, false);
  assert.equal(assignedDetail.permissions.canWork, false);
  assert.equal(assignedDetail.permissions.canComment, false);

  const updateResponse = await fetch(
    `${baseUrl}/api/issues/${developerVisibilityIssueId}`,
    {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${developer.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ priority: "high" }),
    },
  );
  assert.equal(updateResponse.status, 403);
});

test("company admins have full functional access but only manage lower roles", { skip: !enabled }, async () => {
  const owner = await login("admin@projecthub.local");
  const [[adminMembership]] = await pool.execute(
    "SELECT id FROM company_memberships WHERE user_id = ? AND company_id = ?",
    [registeredUserId, owner.user.companyId],
  );
  const promoteResponse = await fetch(
    `${baseUrl}/api/company/members/${adminMembership.id}/roles`,
    {
      method: "PUT",
      headers: {
        authorization: `Bearer ${owner.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ roles: ["company_admin"] }),
    },
  );
  assert.equal(promoteResponse.status, 200);

  const companyAdmin = await login(registeredUsername, { fresh: true });
  const [[{ permission_count: permissionCount }]] = await pool.execute(
    "SELECT COUNT(*) permission_count FROM permissions",
  );
  assert.equal(companyAdmin.user.permissions.length, Number(permissionCount));

  const createRoleResponse = await fetch(`${baseUrl}/api/company/roles`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${companyAdmin.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ name: "Integration Lower Role" }),
  });
  assert.equal(createRoleResponse.status, 201);
  const customRole = await createRoleResponse.json();
  hierarchyCustomRoleId = Number(customRole.id);

  const permissionsResponse = await fetch(`${baseUrl}/api/company/permissions`, {
    headers: { authorization: `Bearer ${companyAdmin.token}` },
  });
  assert.equal(permissionsResponse.status, 200);
  const permissions = await permissionsResponse.json();
  const readAll = permissions.find((permission) => permission.code === "issues.read_all");
  const manageRoles = permissions.find((permission) => permission.code === "roles.manage");
  assert.equal(readAll.grantable_to_custom_role, true);
  assert.equal(manageRoles.grantable_to_custom_role, false);

  const grantFunctionalResponse = await fetch(
    `${baseUrl}/api/company/roles/${hierarchyCustomRoleId}/permissions`,
    {
      method: "PUT",
      headers: {
        authorization: `Bearer ${companyAdmin.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ permissionIds: [readAll.id] }),
    },
  );
  assert.equal(grantFunctionalResponse.status, 200);

  const grantHierarchyResponse = await fetch(
    `${baseUrl}/api/company/roles/${hierarchyCustomRoleId}/permissions`,
    {
      method: "PUT",
      headers: {
        authorization: `Bearer ${companyAdmin.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ permissionIds: [manageRoles.id] }),
    },
  );
  assert.equal(grantHierarchyResponse.status, 403);

  const [[targetMembership]] = await pool.execute(
    `SELECT cm.id
     FROM company_memberships cm
     JOIN users u ON u.id = cm.user_id
     WHERE u.email = 'qa@projecthub.local' AND cm.company_id = ?`,
    [companyAdmin.user.companyId],
  );
  hierarchyTargetMembershipId = Number(targetMembership.id);
  const [originalRoles] = await pool.execute(
    "SELECT role_id FROM membership_roles WHERE membership_id = ?",
    [hierarchyTargetMembershipId],
  );
  hierarchyTargetOriginalRoleIds = originalRoles.map((role) => Number(role.role_id));

  const assignCustomResponse = await fetch(
    `${baseUrl}/api/company/members/${hierarchyTargetMembershipId}/roles`,
    {
      method: "PUT",
      headers: {
        authorization: `Bearer ${companyAdmin.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ roles: [customRole.name] }),
    },
  );
  assert.equal(assignCustomResponse.status, 200);

  const assignOwnerResponse = await fetch(
    `${baseUrl}/api/company/members/${hierarchyTargetMembershipId}/roles`,
    {
      method: "PUT",
      headers: {
        authorization: `Bearer ${companyAdmin.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ roles: ["company_owner"] }),
    },
  );
  assert.equal(assignOwnerResponse.status, 403);

  const [[ownerMembership]] = await pool.execute(
    "SELECT id FROM company_memberships WHERE user_id = ? AND company_id = ?",
    [owner.user.id, companyAdmin.user.companyId],
  );
  const demoteOwnerResponse = await fetch(
    `${baseUrl}/api/company/members/${ownerMembership.id}/roles`,
    {
      method: "PUT",
      headers: {
        authorization: `Bearer ${companyAdmin.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ roles: ["dev"] }),
    },
  );
  assert.equal(demoteOwnerResponse.status, 403);
});

test("password reset commits its email to the durable outbox", { skip: !enabled }, async () => {
  const [[user]] = await pool.execute(
    "SELECT id FROM users WHERE email = 'admin@projecthub.local'",
  );
  const response = await fetch(`${baseUrl}/api/auth/forgot-password`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "admin@projecthub.local" }),
  });
  assert.equal(response.status, 200);
  const [[token]] = await pool.execute(
    `SELECT id FROM password_reset_tokens
     WHERE user_id = ? ORDER BY id DESC LIMIT 1`,
    [user.id],
  );
  const [[emailEvent]] = await pool.execute(
    `SELECT id FROM outbox_events
     WHERE event_type = 'email.send'
       AND aggregate_type = 'user'
       AND aggregate_id = ?
       AND dedupe_key LIKE 'email.reset:%'
     ORDER BY id DESC LIMIT 1`,
    [String(user.id)],
  );
  passwordResetTokenId = Number(token?.id);
  passwordResetOutboxId = Number(emailEvent?.id);
  assert.ok(passwordResetTokenId, "password reset token was not stored");
  assert.ok(passwordResetOutboxId, "password reset email was not enqueued");
});

test("requester receives a minimal persona and cannot browse internal resources", { skip: !enabled }, async () => {
  const session = await login("requester@projecthub.local");
  const headers = { authorization: `Bearer ${session.token}` };
  const [dashboardResponse, projectsResponse, usersResponse] = await Promise.all([
    fetch(`${baseUrl}/api/dashboard`, { headers }),
    fetch(`${baseUrl}/api/projects`, { headers }),
    fetch(`${baseUrl}/api/users`, { headers }),
  ]);
  assert.equal(dashboardResponse.status, 200);
  assert.equal(projectsResponse.status, 200);
  assert.equal(usersResponse.status, 403);
  const dashboard = await dashboardResponse.json();
  const projects = await projectsResponse.json();
  assert.equal(Object.hasOwn(dashboard.counts, "myWorkTotal"), false);
  assert.equal(projects.total, 0);
});

test("developer receives action permissions but cannot assign issue owners", { skip: !enabled }, async () => {
  const session = await login("developer@projecthub.local");
  assert.equal(session.user.permissions.includes("issues.read_all"), true);
  assert.equal(session.user.permissions.includes("issues.accept"), true);
  assert.equal(session.user.permissions.includes("issues.transition"), true);
  assert.equal(session.user.permissions.includes("issues.assign"), false);
});

test("issue root and chat attachments stay separate and inline images remain private", { skip: !enabled }, async () => {
  const admin = await login("admin@projecthub.local");
  const createResponse = await fetch(`${baseUrl}/api/issues`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${admin.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      title: "P2 attachment integration",
      description: "Verify root and chat attachment boundaries.",
      type: "support",
    }),
  });
  assert.equal(createResponse.status, 201);
  p2IssueId = Number((await createResponse.json()).id);

  const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const rootForm = new FormData();
  rootForm.append("files", new Blob([pngBytes], { type: "image/png" }), "root.png");
  const rootUpload = await fetch(`${baseUrl}/api/issues/${p2IssueId}/attachments`, {
    method: "POST",
    headers: { authorization: `Bearer ${admin.token}` },
    body: rootForm,
  });
  assert.equal(rootUpload.status, 201);

  const commentForm = new FormData();
  commentForm.append("files", new Blob([pngBytes], { type: "image/png" }), "chat.png");
  const commentResponse = await fetch(`${baseUrl}/api/issues/${p2IssueId}/comments`, {
    method: "POST",
    headers: { authorization: `Bearer ${admin.token}` },
    body: commentForm,
  });
  assert.equal(commentResponse.status, 201);
  const comment = await commentResponse.json();
  assert.equal(comment.data.body, "");
  assert.equal(comment.data.attachments.length, 1);
  const chatAttachment = comment.data.attachments[0];

  const replyResponse = await fetch(`${baseUrl}/api/issues/${p2IssueId}/comments`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${admin.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ body: "reply to attachment", replyToId: comment.data.id }),
  });
  assert.equal(replyResponse.status, 201);
  const reply = await replyResponse.json();
  assert.equal(Number(reply.data.reply_to_id), Number(comment.data.id));
  assert.equal(reply.data.reply_preview.body, "ไฟล์แนบ");
  assert.equal(reply.data.reply_preview.has_attachments, true);

  const otherIssueResponse = await fetch(`${baseUrl}/api/issues`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${admin.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      title: "P4 other conversation",
      description: "Cross-conversation reply guard.",
      type: "support",
    }),
  });
  assert.equal(otherIssueResponse.status, 201);
  p4OtherIssueId = Number((await otherIssueResponse.json()).id);
  const otherCommentResponse = await fetch(
    `${baseUrl}/api/issues/${p4OtherIssueId}/comments`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${admin.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ body: "other conversation parent" }),
    },
  );
  assert.equal(otherCommentResponse.status, 201);
  const otherComment = await otherCommentResponse.json();
  const crossReplyResponse = await fetch(`${baseUrl}/api/issues/${p2IssueId}/comments`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${admin.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ body: "must fail", replyToId: otherComment.data.id }),
  });
  assert.equal(crossReplyResponse.status, 404);

  const [storedRows] = await pool.execute(
    "SELECT storage_name FROM issue_attachments WHERE issue_id = ?",
    [p2IssueId],
  );
  p2StorageNames = storedRows.map((row) => row.storage_name);

  const emptyResponse = await fetch(`${baseUrl}/api/issues/${p2IssueId}/comments`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${admin.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ body: " " }),
  });
  assert.equal(emptyResponse.status, 400);

  const rootListResponse = await fetch(`${baseUrl}/api/issues/${p2IssueId}/attachments`, {
    headers: { authorization: `Bearer ${admin.token}` },
  });
  assert.equal(rootListResponse.status, 200);
  const rootAttachments = await rootListResponse.json();
  assert.equal(rootAttachments.length, 1);
  assert.equal(rootAttachments[0].original_name, "root.png");

  const commentsResponse = await fetch(`${baseUrl}/api/issues/${p2IssueId}/comments`, {
    headers: { authorization: `Bearer ${admin.token}` },
  });
  assert.equal(commentsResponse.status, 200);
  const comments = await commentsResponse.json();
  const persistedComment = comments.items.find((item) => Number(item.id) === Number(comment.data.id));
  assert.equal(persistedComment.attachments.length, 1);
  assert.equal(persistedComment.attachments[0].original_name, "chat.png");
  const persistedReply = comments.items.find((item) => Number(item.id) === Number(reply.data.id));
  assert.equal(Number(persistedReply.reply_to_id), Number(comment.data.id));
  assert.equal(persistedReply.reply_preview.body, "ไฟล์แนบ");

  const inlineUrl = `${baseUrl}/api/issues/${p2IssueId}/attachments/${chatAttachment.id}/inline`;
  const unauthenticatedInline = await fetch(inlineUrl);
  assert.equal(unauthenticatedInline.status, 401);
  const inlineResponse = await fetch(inlineUrl, {
    headers: { authorization: `Bearer ${admin.token}` },
  });
  assert.equal(inlineResponse.status, 200);
  assert.match(inlineResponse.headers.get("content-disposition"), /^inline;/);
  assert.equal(inlineResponse.headers.get("x-content-type-options"), "nosniff");

  const downloadResponse = await fetch(
    `${baseUrl}/api/issues/${p2IssueId}/attachments/${chatAttachment.id}/download`,
    { headers: { authorization: `Bearer ${admin.token}` } },
  );
  assert.equal(downloadResponse.status, 200);
  assert.match(downloadResponse.headers.get("content-disposition"), /^attachment;/);

  const requester = await login("requester@projecthub.local");
  const switchResponse = await fetch(`${baseUrl}/api/auth/switch-company`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${requester.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ companyId: foreignCompanyId }),
  });
  assert.equal(switchResponse.status, 200);
  const foreignSession = await switchResponse.json();
  const foreignInline = await fetch(inlineUrl, {
    headers: { authorization: `Bearer ${foreignSession.token}` },
  });
  assert.equal(foreignInline.status, 404);
});

test("project chat supports JSON and private multipart attachments", { skip: !enabled }, async () => {
  const admin = await login("admin@projecthub.local");
  const headers = { authorization: `Bearer ${admin.token}` };

  const jsonResponse = await fetch(
    `${baseUrl}/api/projects/${approvalProjectId}/messages`,
    {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ body: "legacy JSON project message" }),
    },
  );
  assert.equal(jsonResponse.status, 201);
  const jsonMessage = await jsonResponse.json();
  assert.equal(jsonMessage.data.attachments.length, 0);

  const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const form = new FormData();
  form.append("files", new Blob([pngBytes], { type: "image/png" }), "project-chat.png");
  form.append("replyToId", String(jsonMessage.data.id));
  const multipartResponse = await fetch(
    `${baseUrl}/api/projects/${approvalProjectId}/messages`,
    { method: "POST", headers, body: form },
  );
  assert.equal(multipartResponse.status, 201);
  const multipartMessage = await multipartResponse.json();
  assert.equal(multipartMessage.data.body, "");
  assert.equal(multipartMessage.data.attachments.length, 1);
  assert.equal(Number(multipartMessage.data.reply_to_id), Number(jsonMessage.data.id));
  assert.equal(multipartMessage.data.reply_preview.body, "legacy JSON project message");
  const attachment = multipartMessage.data.attachments[0];

  const invalidReplyResponse = await fetch(
    `${baseUrl}/api/projects/${approvalProjectId}/messages`,
    {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ body: "bad reply", replyToId: "not-an-id" }),
    },
  );
  assert.equal(invalidReplyResponse.status, 400);
  const missingReplyResponse = await fetch(
    `${baseUrl}/api/projects/${approvalProjectId}/messages`,
    {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ body: "missing reply", replyToId: 2147483647 }),
    },
  );
  assert.equal(missingReplyResponse.status, 404);

  const [storedRows] = await pool.execute(
    `SELECT storage_name FROM project_message_attachments
     WHERE project_id = ? AND message_id = ?`,
    [approvalProjectId, multipartMessage.data.id],
  );
  p3StorageNames.push(...storedRows.map((row) => row.storage_name));

  const listResponse = await fetch(
    `${baseUrl}/api/projects/${approvalProjectId}/messages`,
    { headers },
  );
  assert.equal(listResponse.status, 200);
  const list = await listResponse.json();
  const persisted = list.items.find(
    (item) => Number(item.id) === Number(multipartMessage.data.id),
  );
  assert.equal(persisted.attachments.length, 1);
  assert.equal(persisted.attachments[0].original_name, "project-chat.png");
  assert.equal(Number(persisted.reply_to_id), Number(jsonMessage.data.id));
  assert.equal(persisted.reply_preview.body, "legacy JSON project message");

  const inlineUrl =
    `${baseUrl}/api/projects/${approvalProjectId}/messages/${multipartMessage.data.id}`
    + `/attachments/${attachment.id}/inline`;
  const unauthenticatedInline = await fetch(inlineUrl);
  assert.equal(unauthenticatedInline.status, 401);
  const inlineResponse = await fetch(inlineUrl, { headers });
  assert.equal(inlineResponse.status, 200);
  assert.match(inlineResponse.headers.get("content-disposition"), /^inline;/);
  assert.equal(inlineResponse.headers.get("x-content-type-options"), "nosniff");

  const downloadResponse = await fetch(
    `${baseUrl}/api/projects/${approvalProjectId}/messages/${multipartMessage.data.id}`
      + `/attachments/${attachment.id}/download`,
    { headers },
  );
  assert.equal(downloadResponse.status, 200);
  assert.match(downloadResponse.headers.get("content-disposition"), /^attachment;/);

  const requester = await login("requester@projecthub.local");
  const switchResponse = await fetch(`${baseUrl}/api/auth/switch-company`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${requester.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ companyId: foreignCompanyId }),
  });
  assert.equal(switchResponse.status, 200);
  const foreignSession = await switchResponse.json();
  const foreignInline = await fetch(inlineUrl, {
    headers: { authorization: `Bearer ${foreignSession.token}` },
  });
  assert.equal(foreignInline.status, 404);
});
