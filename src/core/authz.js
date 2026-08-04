const LEGACY_ROLE_GROUPS = Object.freeze({
  admin: Object.freeze(["group_admin", "company_owner", "company_admin"]),
  member: Object.freeze(["project_manager", "dev"]),
  requester: Object.freeze(["requester"]),
});

export function compatibilityRole(roleNames = []) {
  if (roleNames.some((role) => LEGACY_ROLE_GROUPS.admin.includes(role))) return "admin";
  if (roleNames.some((role) => LEGACY_ROLE_GROUPS.member.includes(role))) return "member";
  return "requester";
}

export function hasPermission(user, permission) {
  if (user?.permissions?.includes(permission)) return true;
  const resource = String(permission || "").split(".")[0];
  return Boolean(resource && user?.permissions?.includes(`${resource}.manage_all`));
}

export function hasAnyPermission(user, permissions = []) {
  return permissions.some((permission) => hasPermission(user, permission));
}

export function hasAnyRole(user, roles = []) {
  return Boolean(user?.roles?.some((role) => roles.includes(role)));
}

export const HIERARCHY_PERMISSION_CODES = Object.freeze([
  "company.manage",
  "members.manage",
  "roles.manage",
]);

export function companyRoleRank(roleNames = []) {
  if (roleNames.some((role) => ["group_admin", "company_owner"].includes(role))) return 30;
  if (roleNames.includes("company_admin")) return 20;
  return 10;
}

export function isCompanyManager(user) {
  return companyRoleRank(user?.roles) >= 20;
}

export function canManageMembership(actor, targetRoleNames = []) {
  const actorRank = companyRoleRank(actor?.roles);
  const targetRank = companyRoleRank(targetRoleNames);
  if (actorRank === 30) return true;
  if (actorRank === 20) return targetRank < 20;
  // Developers (or anyone granted members/roles manage) may manage non-admin members only.
  if (hasPermission(actor, "members.manage") || hasPermission(actor, "roles.manage")) {
    return targetRank < 20;
  }
  return false;
}

export function canAssignCompanyRole(actor, roleName) {
  if (roleName === "company_owner") return false;
  const actorRank = companyRoleRank(actor?.roles);
  const adminRoles = ["group_admin", "company_owner", "company_admin"];
  if (actorRank === 30) return true;
  if (actorRank === 20) return !adminRoles.includes(roleName);
  if (hasPermission(actor, "roles.manage")) {
    return !adminRoles.includes(roleName);
  }
  return false;
}

export function isHierarchyPermission(code) {
  return HIERARCHY_PERMISSION_CODES.includes(code);
}

export function matchesLegacyRole(user, requestedRoles = []) {
  return requestedRoles.some((legacyRole) =>
    hasAnyRole(user, LEGACY_ROLE_GROUPS[legacyRole] || []));
}

export function isRequesterPersona(user) {
  return hasAnyRole(user, ["requester"]) && !hasPermission(user, "issues.read_all");
}

export { LEGACY_ROLE_GROUPS };
