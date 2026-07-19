export function registerCompanyMembershipRoutes(app, deps) {
  const {
    audit,
    auth,
    canAssignCompanyRole,
    canManageMembership,
    companyRoleRank,
    hasPermission,
    isHierarchyPermission,
    isRequesterPersona,
    paginatedJson,
    parsePagination,
    pool,
    randomBytes,
    requireCompanyManager,
    requirePermission,
    STAFF_MEMBERSHIP_SQL,
    wrap,
  } = deps;

  app.get("/api/companies", auth, wrap(async (req, res) => {
    const [rows] = await pool.execute(
      `SELECT c.id, c.name, c.slug, c.parent_id, c.is_active, c.allow_registration
       FROM company_memberships cm
       JOIN companies c ON c.id = cm.company_id
       WHERE cm.user_id = ? AND cm.status = 'active'
       ORDER BY c.name`,
      [req.user.id],
    );
    res.json(rows);
  }));

  app.get("/api/company", auth, wrap(async (req, res) => {
    const [[company]] = await pool.execute(
      `SELECT id, name, slug, parent_id, is_active, allow_registration,
              created_at, updated_at
       FROM companies WHERE id = ?`,
      [req.user.companyId],
    );
    res.json(company);
  }));

  app.patch("/api/company", auth, requirePermission("company.manage"), requireCompanyManager, wrap(async (req, res) => {
    const fields = [];
    const values = [];
    if (req.body.name !== undefined) {
      if (!String(req.body.name).trim()) return res.status(400).json({ message: "ชื่อบริษัทไม่ถูกต้อง" });
      fields.push("name = ?");
      values.push(String(req.body.name).trim());
    }
    if (req.body.allowRegistration !== undefined) {
      fields.push("allow_registration = ?");
      values.push(Boolean(req.body.allowRegistration));
    }
    if (!fields.length) return res.status(400).json({ message: "ไม่มีข้อมูลให้อัปเดต" });
    values.push(req.user.companyId);
    await pool.execute(`UPDATE companies SET ${fields.join(", ")} WHERE id = ?`, values);
    await audit(req, "company.updated", "company", req.user.companyId, req.body);
    res.json({ message: "อัปเดตบริษัทแล้ว" });
  }));

  app.post("/api/company/subsidiaries", auth, requirePermission("company.manage"), requireCompanyManager, wrap(async (req, res) => {
    if (companyRoleRank(req.user.roles) < 30) {
      return res.status(403).json({
        code: "GROUP_ADMIN_REQUIRED",
        message: "เฉพาะ Group Admin เท่านั้นที่สร้างบริษัทย่อยได้",
      });
    }
    const name = String(req.body.name || "").trim();
    const slug = String(req.body.slug || "").trim().toLowerCase();
    if (!name || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
      return res.status(400).json({ message: "ชื่อหรือ slug บริษัทไม่ถูกต้อง" });
    }
    const conn = await pool.getConnection();
    let companyId;
    try {
      await conn.beginTransaction();
      const [result] = await conn.execute(
        `INSERT INTO companies (parent_id, name, slug, allow_registration)
         VALUES (?, ?, ?, ?)`,
        [req.user.companyId, name, slug, Boolean(req.body.allowRegistration)],
      );
      companyId = result.insertId;
      const [membershipResult] = await conn.execute(
        `INSERT INTO company_memberships
          (company_id, user_id, employee_code, status, approved_by, approved_at)
         VALUES (?, ?, ?, 'active', ?, NOW())`,
        [companyId, req.user.id, req.user.employeeCode || `OWNER-${req.user.id}`, req.user.id],
      );
      const [[childRole]] = await conn.execute(
        "SELECT id FROM roles WHERE name = ? AND company_id IS NULL",
        ["group_admin"],
      );
      await conn.execute(
        `INSERT INTO membership_roles (membership_id, role_id, assigned_by)
         VALUES (?, ?, ?)`,
        [membershipResult.insertId, childRole.id, req.user.id],
      );
      await conn.commit();
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      conn.release();
    }
    await audit(req, "company.subsidiary_created", "company", companyId);
    res.status(201).json({ id: companyId, message: "สร้างบริษัทย่อยแล้ว" });
  }));

  app.get("/api/company/members", auth, requirePermission("members.read", "members.manage"), wrap(async (req, res) => {
    const values = [req.user.companyId];
    let statusSql = "";
    if (req.query.status) {
      if (!["pending", "active", "rejected", "suspended"].includes(req.query.status)) {
        return res.status(400).json({ message: "สถานะสมาชิกไม่ถูกต้อง" });
      }
      statusSql = "AND cm.status = ?";
      values.push(req.query.status);
    }
    const pagination = parsePagination(req, { defaultLimit: 20, maxLimit: 100 });
    const [[{ total }]] = await pool.execute(
      `SELECT COUNT(*) total
       FROM company_memberships cm
       WHERE cm.company_id = ? ${statusSql}`,
      values,
    );
    const [rows] = await pool.execute(
      `SELECT cm.id membership_id, cm.user_id, cm.employee_code, cm.status,
              cm.approved_at, cm.created_at, u.name, u.first_name, u.last_name,
              u.email, u.email_verified_at,
              GROUP_CONCAT(DISTINCT r.name ORDER BY r.name) roles
       FROM company_memberships cm
       JOIN users u ON u.id = cm.user_id
       LEFT JOIN membership_roles mr ON mr.membership_id = cm.id
       LEFT JOIN roles r ON r.id = mr.role_id
       WHERE cm.company_id = ? ${statusSql}
       GROUP BY cm.id, cm.user_id, cm.employee_code, cm.status, cm.approved_at,
                cm.created_at, u.name, u.first_name, u.last_name, u.email,
                u.email_verified_at
       ORDER BY cm.status = 'pending' DESC, cm.created_at DESC
       LIMIT ${pagination.limit} OFFSET ${pagination.offset}`,
      values,
    );
    paginatedJson(
      res,
      rows.map((row) => {
        const roles = row.roles ? row.roles.split(",") : [];
        const canManageTarget = canManageMembership(req.user, roles);
        return {
          ...row,
          roles,
          role_rank: companyRoleRank(roles),
          can_change_roles: hasPermission(req.user, "roles.manage") && canManageTarget,
          can_change_status: hasPermission(req.user, "members.manage") && canManageTarget,
          can_suspend: hasPermission(req.user, "members.manage") && canManageTarget,
        };
      }),
      total,
      pagination,
    );
  }));

  app.patch("/api/company/members/:membershipId/status", auth, requirePermission("members.manage"), requireCompanyManager, wrap(async (req, res) => {
    const status = req.body.status;
    if (!["active", "rejected", "suspended"].includes(status)) {
      return res.status(400).json({ message: "สถานะสมาชิกไม่ถูกต้อง" });
    }
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [[target]] = await connection.execute(
        `SELECT cm.id, cm.user_id, cm.status, u.email_verified_at,
                EXISTS (
                  SELECT 1
                  FROM membership_roles mr
                  JOIN roles r ON r.id = mr.role_id
                  WHERE mr.membership_id = cm.id
                    AND r.name IN ('group_admin', 'company_owner')
                ) is_owner
         FROM company_memberships cm
         JOIN users u ON u.id = cm.user_id
         WHERE cm.id = ? AND cm.company_id = ?
         FOR UPDATE`,
        [req.params.membershipId, req.user.companyId],
      );
      if (!target) {
        await connection.rollback();
        return res.status(404).json({ message: "ไม่พบสมาชิก" });
      }
      const [targetRoleRows] = await connection.execute(
        `SELECT r.name
         FROM membership_roles mr
         JOIN roles r ON r.id = mr.role_id
         WHERE mr.membership_id = ?`,
        [target.id],
      );
      const targetRoles = targetRoleRows.map((role) => role.name);
      if (!canManageMembership(req.user, targetRoles)) {
        await connection.rollback();
        return res.status(403).json({
          code: "MEMBERSHIP_HIERARCHY_DENIED",
          message: "คุณไม่สามารถจัดการ Group Admin หรือ Company Admin ระดับเดียวกันได้",
        });
      }
      if (status !== "active" && Number(target.is_owner)) {
        const [owners] = await connection.execute(
          `SELECT cm.id
           FROM company_memberships cm
           JOIN membership_roles mr ON mr.membership_id = cm.id
           JOIN roles r ON r.id = mr.role_id
           WHERE cm.company_id = ? AND cm.status = 'active'
             AND r.name IN ('group_admin', 'company_owner')
           FOR UPDATE`,
          [req.user.companyId],
        );
        if (owners.length <= 1) {
          await connection.rollback();
          return res.status(409).json({ message: "ไม่สามารถระงับ Group Admin คนสุดท้ายได้" });
        }
      }
      await connection.execute(
        `UPDATE company_memberships
         SET status = ?, approved_by = ?, approved_at = IF(? = 'active', NOW(), approved_at)
         WHERE id = ? AND company_id = ?`,
        [status, req.user.id, status, req.params.membershipId, req.user.companyId],
      );
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
    await audit(req, `membership.${status}`, "membership", req.params.membershipId);
    res.json({ message: "อัปเดตสถานะสมาชิกแล้ว" });
  }));

  app.get("/api/company/roles", auth, requirePermission("members.read", "roles.manage"), wrap(async (req, res) => {
    const [roles] = await pool.execute(
      `SELECT r.id, r.company_id, r.name, r.label, r.description, r.is_system,
              GROUP_CONCAT(DISTINCT p.code ORDER BY p.code) permissions
       FROM roles r
       LEFT JOIN role_permissions rp ON rp.role_id = r.id
       LEFT JOIN permissions p ON p.id = rp.permission_id
       WHERE r.company_id IS NULL OR r.company_id = ?
       GROUP BY r.id, r.company_id, r.name, r.label, r.description, r.is_system
       ORDER BY r.is_system DESC, r.id`,
      [req.user.companyId],
    );
    res.json(roles.map((role) => ({
      ...role,
      permissions: role.permissions ? role.permissions.split(",") : [],
      role_rank: companyRoleRank([role.name]),
      can_assign: canAssignCompanyRole(req.user, role.name),
      can_edit_permissions: !role.is_system,
    })));
  }));

  app.get("/api/company/permissions", auth, requirePermission("roles.manage"), requireCompanyManager, wrap(async (_req, res) => {
    const [rows] = await pool.execute(
      "SELECT id, code, description FROM permissions ORDER BY code",
    );
    res.json(rows.map((permission) => ({
      ...permission,
      grantable_to_custom_role: !isHierarchyPermission(permission.code),
    })));
  }));

  app.post("/api/company/roles", auth, requirePermission("roles.manage"), requireCompanyManager, wrap(async (req, res) => {
    const label = String(req.body.name || req.body.label || "").trim();
    const description = String(req.body.description || "").trim() || null;
    if (!label || label.length > 120) {
      return res.status(400).json({ message: "ชื่อ Role ไม่ถูกต้อง" });
    }
    const base = label.toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 30) || "role";
    const name = `custom_${req.user.companyId}_${base}_${randomBytes(3).toString("hex")}`;
    const [result] = await pool.execute(
      `INSERT INTO roles (company_id, name, label, description, is_system)
       VALUES (?, ?, ?, ?, FALSE)`,
      [req.user.companyId, name, label, description],
    );
    await audit(req, "role.created", "role", result.insertId, { name, label });
    res.status(201).json({ id: result.insertId, name, label, message: "สร้าง Role แล้ว" });
  }));

  app.put("/api/company/roles/:roleId/permissions", auth, requirePermission("roles.manage"), requireCompanyManager, wrap(async (req, res) => {
    const permissionIds = [...new Set(
      (Array.isArray(req.body.permissionIds) ? req.body.permissionIds : [])
        .map(Number)
        .filter((id) => Number.isInteger(id) && id > 0),
    )];
    const [[role]] = await pool.execute(
      `SELECT id, name FROM roles
       WHERE id = ? AND company_id = ? AND is_system = FALSE`,
      [req.params.roleId, req.user.companyId],
    );
    if (!role) {
      return res.status(403).json({ message: "Built-in Role แก้ไขไม่ได้ กรุณาสร้าง Custom Role" });
    }
    if (permissionIds.length) {
      const [valid] = await pool.execute(
        `SELECT id, code FROM permissions WHERE id IN (${permissionIds.map(() => "?").join(",")})`,
        permissionIds,
      );
      if (valid.length !== permissionIds.length) {
        return res.status(400).json({ message: "พบ Permission ที่ไม่ถูกต้อง" });
      }
      const forbidden = valid.filter((permission) =>
        isHierarchyPermission(permission.code));
      if (forbidden.length) {
        return res.status(403).json({
          code: "CUSTOM_ROLE_HIERARCHY_PERMISSION_DENIED",
          message: "Custom Role ไม่สามารถรับสิทธิ์จัดการบริษัท สมาชิก หรือบทบาทได้",
          forbiddenPermissions: forbidden.map((permission) => permission.code),
        });
      }
    }
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.execute("DELETE FROM role_permissions WHERE role_id = ?", [role.id]);
      for (const permissionId of permissionIds) {
        await conn.execute(
          "INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)",
          [role.id, permissionId],
        );
      }
      await conn.commit();
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      conn.release();
    }
    await audit(req, "role.permissions_updated", "role", role.id, { permissionIds });
    res.json({ message: "อัปเดต Permission แล้ว" });
  }));

  app.put("/api/company/members/:membershipId/roles", auth, requirePermission("roles.manage"), requireCompanyManager, wrap(async (req, res) => {
    const roleNames = [...new Set(
      (Array.isArray(req.body.roles) ? req.body.roles : []).map(String),
    )];
    if (!roleNames.length) return res.status(400).json({ message: "ต้องมีอย่างน้อยหนึ่งบทบาท" });
    const [[membership]] = await pool.execute(
      "SELECT id FROM company_memberships WHERE id = ? AND company_id = ?",
      [req.params.membershipId, req.user.companyId],
    );
    if (!membership) return res.status(404).json({ message: "ไม่พบสมาชิก" });
    const [roles] = await pool.execute(
      `SELECT id, name FROM roles
       WHERE name IN (${roleNames.map(() => "?").join(",")})
         AND (company_id IS NULL OR company_id = ?)`,
      [...roleNames, req.user.companyId],
    );
    if (roles.length !== roleNames.length) return res.status(400).json({ message: "พบบทบาทที่ไม่ถูกต้อง" });
    const forbiddenRoles = roles.filter((role) =>
      !canAssignCompanyRole(req.user, role.name));
    if (forbiddenRoles.length) {
      return res.status(403).json({
        code: "ROLE_ASSIGNMENT_HIERARCHY_DENIED",
        message: "Company Admin ไม่สามารถมอบหมายบทบาท Group Admin หรือ Company Admin ได้",
      });
    }
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [[lockedMembership]] = await conn.execute(
        `SELECT id FROM company_memberships
         WHERE id = ? AND company_id = ?
         FOR UPDATE`,
        [membership.id, req.user.companyId],
      );
      if (!lockedMembership) {
        await conn.rollback();
        return res.status(404).json({ message: "ไม่พบสมาชิก" });
      }
      const [currentRoleRows] = await conn.execute(
        `SELECT r.name
         FROM membership_roles mr
         JOIN roles r ON r.id = mr.role_id
         WHERE mr.membership_id = ?`,
        [membership.id],
      );
      const currentRoles = currentRoleRows.map((role) => role.name);
      if (!canManageMembership(req.user, currentRoles)) {
        await conn.rollback();
        return res.status(403).json({
          code: "MEMBERSHIP_HIERARCHY_DENIED",
          message: "คุณไม่สามารถเปลี่ยนบทบาทของ Group Admin หรือ Company Admin ได้",
        });
      }
      const [[{ is_owner: isOwner }]] = await conn.execute(
        `SELECT COUNT(*) > 0 is_owner
         FROM membership_roles mr JOIN roles r ON r.id = mr.role_id
         WHERE mr.membership_id = ?
           AND r.name IN ('group_admin', 'company_owner')`,
        [membership.id],
      );
      if (Number(isOwner)
          && !roleNames.some((roleName) => ["group_admin", "company_owner"].includes(roleName))) {
        const [owners] = await conn.execute(
          `SELECT cm.id
           FROM company_memberships cm
           JOIN membership_roles mr ON mr.membership_id = cm.id
           JOIN roles r ON r.id = mr.role_id
           WHERE cm.company_id = ? AND cm.status = 'active'
             AND r.name IN ('group_admin', 'company_owner')
           FOR UPDATE`,
          [req.user.companyId],
        );
        if (owners.length <= 1) {
          await conn.rollback();
          return res.status(409).json({ message: "กลุ่มบริษัทต้องมี Group Admin อย่างน้อยหนึ่งคน" });
        }
      }
      await conn.execute("DELETE FROM membership_roles WHERE membership_id = ?", [membership.id]);
      for (const role of roles) {
        await conn.execute(
          `INSERT INTO membership_roles (membership_id, role_id, assigned_by)
           VALUES (?, ?, ?)`,
          [membership.id, role.id, req.user.id],
        );
      }
      await conn.commit();
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      conn.release();
    }
    await audit(req, "membership.roles_updated", "membership", membership.id, { roles: roleNames });
    res.json({ message: "อัปเดตบทบาทแล้ว" });
  }));

  app.get("/api/company/audit-logs", auth, requirePermission("audit.read"), wrap(async (req, res) => {
    const pagination = parsePagination(req, { defaultLimit: 50, maxLimit: 200 });
    const [[{ total }]] = await pool.execute(
      "SELECT COUNT(*) total FROM audit_logs WHERE company_id = ?",
      [req.user.companyId],
    );
    const [rows] = await pool.execute(
      `SELECT a.*, u.name actor_name
       FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id
       WHERE a.company_id = ?
       ORDER BY a.created_at DESC, a.id DESC
       LIMIT ${pagination.limit} OFFSET ${pagination.offset}`,
      [req.user.companyId],
    );
    paginatedJson(res, rows, total, pagination);
  }));

  app.get("/api/users", auth, wrap(async (req, res) => {
    if (isRequesterPersona(req.user)
        && !hasPermission(req.user, "members.read")) {
      return res.status(403).json({ message: "คุณไม่มีสิทธิ์ดูรายชื่อพนักงาน" });
    }
    const values = [];
    const where = ["cm.company_id = ?", "cm.status = 'active'"];
    values.push(req.user.companyId);
    if (req.query.role === "staff") {
      where.push(STAFF_MEMBERSHIP_SQL);
    } else if (["admin", "member", "requester"].includes(req.query.role)) {
      const mappedRoles = {
        admin: ["group_admin", "company_owner", "company_admin"],
        member: ["project_manager", "dev"],
        requester: ["requester"],
      }[req.query.role];
      where.push(`r.name IN (${mappedRoles.map(() => "?").join(",")})`);
      values.push(...mappedRoles);
    }
    const [rows] = await pool.execute(
      `SELECT DISTINCT u.id, u.name, u.email,
              CASE
                WHEN MAX(r.name IN ('group_admin','company_owner','company_admin')) = 1 THEN 'admin'
                WHEN MAX(r.name IN ('project_manager','dev')) = 1 THEN 'member'
                ELSE 'requester'
              END role,
              u.department
       FROM users u
       JOIN company_memberships cm ON cm.user_id = u.id
       LEFT JOIN membership_roles mr ON mr.membership_id = cm.id
       LEFT JOIN roles r ON r.id = mr.role_id
       WHERE ${where.join(" AND ")}
       GROUP BY u.id, u.name, u.email, u.department
       ORDER BY u.name`,
      values,
    );
    res.json(rows);
  }));
}
