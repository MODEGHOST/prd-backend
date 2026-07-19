import jwt from "jsonwebtoken";
import { compatibilityRole, hasPermission, isCompanyManager } from "../core/authz.js";
import { wrap } from "./async-handler.js";

export function createAuth({ pool, jwtSecret, authTokenTtl }) {
  function sign(user) {
    return jwt.sign(
      {
        id: user.id,
        activeCompanyId: user.companyId,
        tokenVersion: Number(user.tokenVersion || 0),
      },
      jwtSecret,
      { expiresIn: authTokenTtl },
    );
  }

  async function loadSession(token) {
    const claims = jwt.verify(token, jwtSecret);
    const [[account]] = await pool.execute(
      `SELECT id, name, first_name, last_name, email, role legacy_role, department,
              status, email_verified_at, token_version
       FROM users WHERE id = ?`,
      [claims.id],
    );
    if (!account || account.status !== "active") throw new Error("inactive account");
    if (!account.email_verified_at) throw new Error("unverified account");
    if (claims.tokenVersion != null
        && Number(claims.tokenVersion) !== Number(account.token_version)) {
      throw new Error("revoked token");
    }

    let companyId = Number(claims.activeCompanyId || 0);
    if (!companyId) {
      const [[first]] = await pool.execute(
        `SELECT cm.company_id
         FROM company_memberships cm
         JOIN companies c ON c.id = cm.company_id
         WHERE cm.user_id = ? AND cm.status = 'active' AND c.is_active = TRUE
         ORDER BY cm.id LIMIT 1`,
        [account.id],
      );
      companyId = Number(first?.company_id || 0);
    }
    const [[membership]] = await pool.execute(
      `SELECT cm.id membership_id, cm.company_id, cm.employee_code, c.name company_name,
              GROUP_CONCAT(DISTINCT r.name ORDER BY r.name) role_names
       FROM company_memberships cm
       JOIN companies c ON c.id = cm.company_id AND c.is_active = TRUE
       LEFT JOIN membership_roles mr ON mr.membership_id = cm.id
       LEFT JOIN roles r
         ON r.id = mr.role_id
        AND (r.company_id IS NULL OR r.company_id = cm.company_id)
       WHERE cm.user_id = ? AND cm.company_id = ? AND cm.status = 'active'
       GROUP BY cm.id, cm.company_id, cm.employee_code, c.name`,
      [account.id, companyId],
    );
    if (!membership) throw new Error("inactive membership");
    const roleNames = membership.role_names
      ? membership.role_names.split(",")
      : [{
        admin: "group_admin",
        member: "dev",
        requester: "requester",
      }[account.legacy_role] || "requester"];
    const [permissionRows] = await pool.execute(
      `SELECT DISTINCT p.code
       FROM membership_roles mr
       JOIN company_memberships cm ON cm.id = mr.membership_id
       JOIN role_permissions rp ON rp.role_id = mr.role_id
       JOIN roles r
         ON r.id = mr.role_id
        AND (r.company_id IS NULL OR r.company_id = cm.company_id)
       JOIN permissions p ON p.id = rp.permission_id
       WHERE mr.membership_id = ?`,
      [membership.membership_id],
    );
    return {
      id: account.id,
      name: account.name,
      firstName: account.first_name,
      lastName: account.last_name,
      email: account.email,
      department: account.department,
      emailVerifiedAt: account.email_verified_at,
      tokenVersion: Number(account.token_version),
      companyId: Number(membership.company_id),
      companyName: membership.company_name,
      membershipId: Number(membership.membership_id),
      employeeCode: membership.employee_code,
      roles: roleNames,
      permissions: permissionRows.map((row) => row.code),
      role: compatibilityRole(roleNames),
    };
  }

  const auth = wrap(async (req, res, next) => {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
    if (!token) return res.status(401).json({ message: "กรุณาเข้าสู่ระบบ" });
    try {
      req.user = await loadSession(token);
      next();
    } catch {
      res.status(401).json({ message: "เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่" });
    }
  });

  const requirePermission = (...permissions) => (req, res, next) =>
    permissions.some((permission) => hasPermission(req.user, permission))
      ? next()
      : res.status(403).json({ message: "คุณไม่มีสิทธิ์ทำรายการนี้" });

  const requireCompanyManager = (req, res, next) =>
    isCompanyManager(req.user)
      ? next()
      : res.status(403).json({
        code: "COMPANY_ROLE_REQUIRED",
        message: "รายการนี้สำหรับ Group Admin หรือ Company Admin เท่านั้น",
      });

  return { auth, loadSession, requireCompanyManager, requirePermission, sign };
}
