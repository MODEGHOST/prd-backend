import test from "node:test";
import assert from "node:assert/strict";
import {
  canAssignCompanyRole,
  canManageMembership,
  compatibilityRole,
  companyRoleRank,
  hasAnyPermission,
  hasAnyRole,
  hasPermission,
  isCompanyManager,
  isHierarchyPermission,
  isRequesterPersona,
  matchesLegacyRole,
} from "../src/core/authz.js";

test("compatibility roles preserve existing built-in behavior", () => {
  assert.equal(compatibilityRole(["group_admin"]), "admin");
  assert.equal(compatibilityRole(["company_owner"]), "admin");
  assert.equal(compatibilityRole(["company_admin"]), "admin");
  assert.equal(compatibilityRole(["project_manager"]), "member");
  assert.equal(compatibilityRole(["dev"]), "member");
  assert.equal(compatibilityRole(["requester"]), "requester");
  assert.equal(compatibilityRole(["auditor"]), "requester");
});

test("permission helpers use effective membership permissions", () => {
  const user = { permissions: ["issues.read_all", "audit.read"] };
  assert.equal(hasPermission(user, "issues.read_all"), true);
  assert.equal(hasPermission(user, "issues.manage_all"), false);
  assert.equal(hasAnyPermission(user, ["issues.manage_all", "audit.read"]), true);
});

test("resource manage_all grants specific actions for built-in administrators", () => {
  const user = { permissions: ["issues.manage_all", "projects.manage_all"] };
  assert.equal(hasPermission(user, "issues.assign"), true);
  assert.equal(hasPermission(user, "issues.transition"), true);
  assert.equal(hasPermission(user, "projects.update"), true);
  assert.equal(hasPermission(user, "members.manage"), false);
});

test("legacy role matching does not promote auditor or custom roles", () => {
  assert.equal(matchesLegacyRole({ roles: ["auditor"] }, ["admin"]), false);
  assert.equal(matchesLegacyRole({ roles: ["custom_1_support"] }, ["member"]), false);
  assert.equal(matchesLegacyRole({ roles: ["project_manager"] }, ["member"]), true);
});

test("requester persona is exact and does not collapse auditor into requester UX", () => {
  assert.equal(isRequesterPersona({
    roles: ["requester"],
    permissions: ["issues.create"],
  }), true);
  assert.equal(isRequesterPersona({
    roles: ["auditor"],
    permissions: ["issues.read_all", "audit.read"],
  }), false);
  assert.equal(isRequesterPersona({
    roles: ["requester"],
    permissions: ["issues.read_all"],
  }), false);
});

test("role helper supports users with more than one company-scoped role", () => {
  const user = { roles: ["dev", "custom_1_team_lead"] };
  assert.equal(hasAnyRole(user, ["company_admin", "dev"]), true);
  assert.equal(hasAnyRole(user, ["company_owner"]), false);
});

test("company role hierarchy protects owner and admin peers", () => {
  const groupAdmin = { roles: ["group_admin"] };
  const legacyOwner = { roles: ["company_owner"] };
  const admin = { roles: ["company_admin"] };
  const developer = { roles: ["dev"] };
  const custom = { roles: ["custom_1_team_lead"], permissions: ["roles.manage"] };

  assert.equal(companyRoleRank(groupAdmin.roles), 30);
  assert.equal(companyRoleRank(legacyOwner.roles), 30);
  assert.equal(companyRoleRank(admin.roles), 20);
  assert.equal(companyRoleRank(developer.roles), 10);
  assert.equal(isCompanyManager(groupAdmin), true);
  assert.equal(isCompanyManager(admin), true);
  assert.equal(isCompanyManager(custom), false);
  assert.equal(canManageMembership(groupAdmin, ["group_admin"]), true);
  assert.equal(canManageMembership(groupAdmin, ["company_admin"]), true);
  assert.equal(canManageMembership(admin, ["group_admin"]), false);
  assert.equal(canManageMembership(admin, ["company_owner"]), false);
  assert.equal(canManageMembership(admin, ["company_admin"]), false);
  assert.equal(canManageMembership(admin, ["dev"]), true);
  assert.equal(canAssignCompanyRole(admin, "group_admin"), false);
  assert.equal(canAssignCompanyRole(admin, "company_owner"), false);
  assert.equal(canAssignCompanyRole(admin, "company_admin"), false);
  assert.equal(canAssignCompanyRole(admin, "dev"), true);
  assert.equal(canAssignCompanyRole(groupAdmin, "company_owner"), false);
  assert.equal(canAssignCompanyRole(groupAdmin, "company_admin"), true);
});

test("custom roles cannot receive company hierarchy permissions", () => {
  assert.equal(isHierarchyPermission("company.manage"), true);
  assert.equal(isHierarchyPermission("members.manage"), true);
  assert.equal(isHierarchyPermission("roles.manage"), true);
  assert.equal(isHierarchyPermission("issues.manage_all"), false);
});
