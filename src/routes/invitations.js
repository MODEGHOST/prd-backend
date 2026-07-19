import { invitationEmail } from "../services/email-templates.js";

function parseRoles(value) {
  if (Array.isArray(value)) return value.map(String);
  try {
    return JSON.parse(value || "[]").map(String);
  } catch {
    return [];
  }
}

export function registerInvitationRoutes(app, deps) {
  const {
    audit,
    auth,
    canAssignCompanyRole,
    createHash,
    createOneTimeToken,
    enqueueOutbox,
    frontendUrl,
    pool,
    requirePermission,
    wrap,
  } = deps;

  const inviteUrl = (token) =>
    `${frontendUrl}/invite?token=${encodeURIComponent(token)}`;

  async function queueInvite(connection, invitation, token) {
    const url = inviteUrl(token);
    await enqueueOutbox(connection, {
      companyId: invitation.company_id,
      eventType: "email.send",
      aggregateType: "invitation",
      aggregateId: invitation.id,
      dedupeKey: `email.invite:${invitation.id}:${invitation.token_hash}`,
      payload: {
        to: invitation.email,
        ...invitationEmail({
          url,
          companyName: invitation.company_name,
        }),
        developmentUrl: url,
      },
    });
  }

  async function resolveAssignableRoles(user, roleNames) {
    const unique = [...new Set((roleNames || []).map(String))];
    if (!unique.length) return null;
    const [roles] = await pool.execute(
      `SELECT id, name FROM roles
       WHERE name IN (${unique.map(() => "?").join(",")})
         AND (company_id IS NULL OR company_id = ?)`,
      [...unique, user.companyId],
    );
    if (roles.length !== unique.length
        || roles.some((role) => !canAssignCompanyRole(user, role.name))) {
      return null;
    }
    return roles;
  }

  app.get("/api/invitations/preview", wrap(async (req, res) => {
    const tokenHash = createHash("sha256").update(String(req.query.token || "")).digest("hex");
    const [[invitation]] = await pool.execute(
      `SELECT i.email, i.status, i.expires_at, c.id company_id, c.name company_name
       FROM invitations i
       JOIN companies c ON c.id = i.company_id AND c.is_active = TRUE
       WHERE i.token_hash = ?`,
      [tokenHash],
    );
    if (!invitation || invitation.status !== "pending"
        || new Date(invitation.expires_at) <= new Date()) {
      return res.status(400).json({ message: "คำเชิญไม่ถูกต้องหรือหมดอายุ" });
    }
    res.json(invitation);
  }));

  app.get("/api/company/invitations", auth, requirePermission("members.manage"), wrap(async (req, res) => {
    await pool.execute(
      `UPDATE invitations SET status = 'expired'
       WHERE company_id = ? AND status = 'pending' AND expires_at <= NOW()`,
      [req.user.companyId],
    );
    const [rows] = await pool.execute(
      `SELECT id, email, employee_code, status, roles_json, expires_at,
              accepted_at, revoked_at, created_at
       FROM invitations WHERE company_id = ?
       ORDER BY created_at DESC`,
      [req.user.companyId],
    );
    res.json(rows.map((row) => ({ ...row, roles: parseRoles(row.roles_json) })));
  }));

  app.post("/api/company/invitations", auth, requirePermission("members.manage"), wrap(async (req, res) => {
    const email = String(req.body.email || "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.status(400).json({ message: "อีเมลไม่ถูกต้อง" });
    }
    const roles = await resolveAssignableRoles(req.user, req.body.roles);
    if (!roles) {
      return res.status(403).json({
        code: "INVITE_ROLE_HIERARCHY_DENIED",
        message: "ไม่สามารถกำหนดบทบาทที่เลือกผ่านคำเชิญได้",
      });
    }
    const [[company]] = await pool.execute(
      "SELECT id, name FROM companies WHERE id = ? AND is_active = TRUE",
      [req.user.companyId],
    );
    if (!company) return res.status(400).json({ message: "บริษัทปัจจุบันไม่พร้อมใช้งาน" });
    const { token, hash } = createOneTimeToken();
    const connection = await pool.getConnection();
    let invitationId;
    try {
      await connection.beginTransaction();
      await connection.execute(
        `UPDATE invitations SET status = 'revoked', revoked_at = NOW()
         WHERE company_id = ? AND email = ? AND status = 'pending'`,
        [company.id, email],
      );
      const [result] = await connection.execute(
        `INSERT INTO invitations
          (company_id, email, employee_code, status, roles_json, token_hash, invited_by, expires_at)
         VALUES (?, ?, ?, 'pending', ?, ?, ?, DATE_ADD(NOW(), INTERVAL 7 DAY))`,
        [
          company.id,
          email,
          String(req.body.employeeCode || "").trim() || null,
          JSON.stringify(roles.map((role) => role.name)),
          hash,
          req.user.id,
        ],
      );
      invitationId = result.insertId;
      await queueInvite(connection, {
        id: invitationId,
        company_id: company.id,
        company_name: company.name,
        email,
        token_hash: hash,
      }, token);
      await audit(req, "invitation.created", "invitation", invitationId, {
        email,
        roles: roles.map((role) => role.name),
      }, connection);
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
    res.status(201).json({ id: invitationId, message: "ส่งคำเชิญแล้ว" });
  }));

  app.post("/api/company/invitations/:id/resend", auth, requirePermission("members.manage"), wrap(async (req, res) => {
    const { token, hash } = createOneTimeToken();
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [[invitation]] = await connection.execute(
        `SELECT i.*, c.name company_name
         FROM invitations i JOIN companies c ON c.id = i.company_id
         WHERE i.id = ? AND i.company_id = ? AND i.status = 'pending'
         FOR UPDATE`,
        [req.params.id, req.user.companyId],
      );
      if (!invitation) {
        await connection.rollback();
        return res.status(404).json({ message: "ไม่พบคำเชิญที่ส่งซ้ำได้" });
      }
      if (parseRoles(invitation.roles_json).some((role) =>
        !canAssignCompanyRole(req.user, role))) {
        await connection.rollback();
        return res.status(403).json({
          code: "INVITE_ROLE_HIERARCHY_DENIED",
          message: "คุณไม่มีสิทธิ์ส่งคำเชิญที่มีบทบาทระดับนี้ซ้ำ",
        });
      }
      await connection.execute(
        `UPDATE invitations
         SET token_hash = ?, expires_at = DATE_ADD(NOW(), INTERVAL 7 DAY)
         WHERE id = ?`,
        [hash, invitation.id],
      );
      await queueInvite(connection, { ...invitation, token_hash: hash }, token);
      await audit(req, "invitation.resent", "invitation", invitation.id, null, connection);
      await connection.commit();
      res.json({ message: "ส่งคำเชิญซ้ำแล้ว" });
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }));

  app.post("/api/company/invitations/:id/revoke", auth, requirePermission("members.manage"), wrap(async (req, res) => {
    const [result] = await pool.execute(
      `UPDATE invitations SET status = 'revoked', revoked_at = NOW()
       WHERE id = ? AND company_id = ? AND status = 'pending'`,
      [req.params.id, req.user.companyId],
    );
    if (!result.affectedRows) return res.status(404).json({ message: "ไม่พบคำเชิญที่เพิกถอนได้" });
    await audit(req, "invitation.revoked", "invitation", req.params.id);
    res.json({ message: "เพิกถอนคำเชิญแล้ว" });
  }));

  app.post("/api/invitations/accept", auth, wrap(async (req, res) => {
    const tokenHash = createHash("sha256").update(String(req.body.token || "")).digest("hex");
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [[invitation]] = await connection.execute(
        `SELECT i.*, c.is_active
         FROM invitations i JOIN companies c ON c.id = i.company_id
         WHERE i.token_hash = ? FOR UPDATE`,
        [tokenHash],
      );
      if (!invitation || invitation.status !== "pending"
          || !invitation.is_active || new Date(invitation.expires_at) <= new Date()) {
        await connection.rollback();
        return res.status(400).json({ message: "คำเชิญไม่ถูกต้องหรือหมดอายุ" });
      }
      if (invitation.email.toLowerCase() !== req.user.email.toLowerCase()) {
        await connection.rollback();
        return res.status(403).json({ message: "คำเชิญนี้เป็นของบัญชีอีเมลอื่น" });
      }
      const roleNames = parseRoles(invitation.roles_json);
      if (!roleNames.length) {
        await connection.rollback();
        return res.status(409).json({ message: "คำเชิญนี้ไม่มีบทบาทที่ใช้งานได้" });
      }
      const [roles] = await connection.execute(
        `SELECT id, name FROM roles
         WHERE name IN (${roleNames.map(() => "?").join(",")})
           AND (company_id IS NULL OR company_id = ?)`,
        [...roleNames, invitation.company_id],
      );
      if (!roles.length || roles.length !== roleNames.length) {
        await connection.rollback();
        return res.status(409).json({ message: "บทบาทในคำเชิญไม่พร้อมใช้งาน" });
      }
      await connection.execute(
        `INSERT INTO company_memberships
          (company_id, user_id, employee_code, status, approved_by, approved_at)
         VALUES (?, ?, ?, 'active', ?, NOW())
         ON DUPLICATE KEY UPDATE employee_code = COALESCE(VALUES(employee_code), employee_code),
           status = 'active', approved_by = VALUES(approved_by), approved_at = NOW()`,
        [invitation.company_id, req.user.id, invitation.employee_code, invitation.invited_by],
      );
      const [[membership]] = await connection.execute(
        "SELECT id FROM company_memberships WHERE company_id = ? AND user_id = ?",
        [invitation.company_id, req.user.id],
      );
      await connection.execute("DELETE FROM membership_roles WHERE membership_id = ?", [membership.id]);
      for (const role of roles) {
        await connection.execute(
          "INSERT INTO membership_roles (membership_id, role_id, assigned_by) VALUES (?, ?, ?)",
          [membership.id, role.id, invitation.invited_by],
        );
      }
      await connection.execute(
        `UPDATE invitations
         SET status = 'accepted', accepted_at = NOW(), accepted_by = ?
         WHERE id = ?`,
        [req.user.id, invitation.id],
      );
      await audit(
        { ...req, user: { ...req.user, companyId: invitation.company_id } },
        "invitation.accepted",
        "invitation",
        invitation.id,
        null,
        connection,
      );
      await connection.commit();
      res.json({ companyId: invitation.company_id, message: "รับคำเชิญแล้ว" });
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }));
}
