import {
  passwordResetEmail,
  verificationEmail,
} from "../services/email-templates.js";
import { passwordPolicyErrors } from "../core/password-policy.js";
import { JWT_SIGN_OPTIONS } from "../middleware/auth.js";

export function registerPublicAuthRoutes(app, deps) {
  const {
    audit,
    auth,
    authRateLimit,
    bcrypt,
    clearSessionCookie,
    config,
    createHash,
    createOneTimeToken,
    enqueueOutbox,
    frontendUrl,
    invalidateSessionCache,
    jwt,
    jwtSecret,
    loadSession,
    notifyLater,
    pool,
    setSessionCookie,
    sign,
    wrap,
  } = deps;

  app.get("/api/companies/public", authRateLimit({ limit: 60 }), wrap(async (_req, res) => {
    const [rows] = await pool.execute(
      `SELECT c.id, c.name, c.parent_id, parent.name parent_name
       FROM companies c
       LEFT JOIN companies parent ON parent.id = c.parent_id
       WHERE c.is_active = TRUE AND c.allow_registration = TRUE
       ORDER BY c.parent_id IS NOT NULL, c.name`,
    );
    res.json(rows);
  }));

  app.post("/api/auth/register", authRateLimit({ limit: 5 }), wrap(async (req, res) => {
    const { employeeCode, firstName, lastName, email, password, companyId, inviteToken } = req.body;
    const normalizedEmail = String(email || "").trim().toLowerCase();
    const inviteHash = inviteToken
      ? createHash("sha256").update(String(inviteToken)).digest("hex")
      : null;
    if (!employeeCode?.trim() || !firstName?.trim() || !lastName?.trim()
        || !normalizedEmail || !password || !companyId) {
      return res.status(400).json({ message: "กรุณากรอกข้อมูลสมัครสมาชิกให้ครบถ้วน" });
    }
    const passwordErrors = passwordPolicyErrors(password);
    if (passwordErrors.length) {
      return res.status(400).json({
        code: "PASSWORD_POLICY_FAILED",
        message: passwordErrors[0],
        errors: passwordErrors,
      });
    }
    const [[invitation]] = inviteHash
      ? await pool.execute(
        `SELECT i.*, c.name company_name
         FROM invitations i JOIN companies c ON c.id = i.company_id AND c.is_active = TRUE
         WHERE i.token_hash = ? AND i.status = 'pending' AND i.expires_at > NOW()`,
        [inviteHash],
      )
      : [[]];
    if (inviteHash && (!invitation || invitation.email.toLowerCase() !== normalizedEmail
        || Number(invitation.company_id) !== Number(companyId))) {
      return res.status(400).json({ message: "คำเชิญไม่ถูกต้อง หมดอายุ หรืออีเมลไม่ตรงกัน" });
    }
    const [[company]] = invitation
      ? [[{ id: invitation.company_id, name: invitation.company_name }]]
      : await pool.execute(
        `SELECT id, name FROM companies
         WHERE id = ? AND is_active = TRUE AND allow_registration = TRUE`,
        [companyId],
      );
    if (!company) return res.status(400).json({ message: "บริษัทไม่เปิดรับสมัคร" });

    const passwordHash = await bcrypt.hash(password, 12);
    const { token, hash } = createOneTimeToken();
    const verificationUrl =
      `${frontendUrl}/verify-email?token=${encodeURIComponent(token)}`;
    const conn = await pool.getConnection();
    let userId;
    try {
      await conn.beginTransaction();
      const [result] = await conn.execute(
        `INSERT INTO users
          (name, first_name, last_name, email, password_hash, role, status)
         VALUES (?, ?, ?, ?, ?, 'requester', 'pending')`,
        [
          `${firstName.trim()} ${lastName.trim()}`,
          firstName.trim(),
          lastName.trim(),
          normalizedEmail,
          passwordHash,
        ],
      );
      userId = result.insertId;
      const [membershipResult] = await conn.execute(
        `INSERT INTO company_memberships
          (company_id, user_id, employee_code, status, approved_by, approved_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          company.id,
          userId,
          employeeCode.trim(),
          invitation ? "active" : "pending",
          invitation?.invited_by || null,
          invitation ? new Date() : null,
        ],
      );
      const invitedRoles = invitation
        ? (typeof invitation.roles_json === "string"
          ? JSON.parse(invitation.roles_json)
          : invitation.roles_json)
        : ["requester"];
      const [roleRows] = await conn.execute(
        `SELECT id FROM roles
         WHERE name IN (${invitedRoles.map(() => "?").join(",")})
           AND (company_id IS NULL OR company_id = ?)`,
        [...invitedRoles, company.id],
      );
      if (!roleRows.length || roleRows.length !== invitedRoles.length) {
        throw new Error("invitation roles are no longer valid");
      }
      for (const role of roleRows) {
        await conn.execute(
          "INSERT INTO membership_roles (membership_id, role_id, assigned_by) VALUES (?, ?, ?)",
          [membershipResult.insertId, role.id, invitation?.invited_by || null],
        );
      }
      if (invitation) {
        await conn.execute(
          `UPDATE invitations
           SET status = 'accepted', accepted_at = NOW(), accepted_by = ?
           WHERE id = ? AND status = 'pending'`,
          [userId, invitation.id],
        );
      }
      await conn.execute(
        `INSERT INTO email_verification_tokens (user_id, token_hash, expires_at)
         VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 24 HOUR))`,
        [userId, hash],
      );
      await enqueueOutbox(conn, {
        companyId: company.id,
        eventType: "email.send",
        aggregateType: "user",
        aggregateId: userId,
        dedupeKey: `email.verify:${userId}:${hash}`,
        payload: {
          to: normalizedEmail,
          ...verificationEmail({
            url: verificationUrl,
            approvalRequired: !invitation,
          }),
          developmentUrl: verificationUrl,
        },
      });
      await conn.commit();
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      conn.release();
    }
    if (!invitation) {
      const [companyAdmins] = await pool.execute(
        `SELECT DISTINCT cm.user_id
         FROM company_memberships cm
         JOIN membership_roles mr ON mr.membership_id = cm.id
         JOIN roles r ON r.id = mr.role_id
         WHERE cm.company_id = ? AND cm.status = 'active'
           AND r.name IN ('group_admin','company_owner','company_admin')`,
        [company.id],
      );
      notifyLater(
        companyAdmins.map((row) => row.user_id),
        "มีคำขอสมัครสมาชิกใหม่",
        `${firstName.trim()} ${lastName.trim()} (${employeeCode.trim()}) สมัครเข้าบริษัท`,
        {
          type: "membership",
          targetUrl: "/admin/access",
          entityType: "membership",
          entityId: userId,
          companyId: company.id,
        },
      );
    }
    res.status(201).json({
      id: userId,
      message: invitation
        ? "สร้างบัญชีและรับคำเชิญแล้ว กรุณายืนยันอีเมลก่อนเข้าสู่ระบบ"
        : "สมัครสมาชิกแล้ว กรุณายืนยันอีเมลและรอผู้ดูแลบริษัทอนุมัติ",
    });
  }));

  app.post("/api/auth/verify-email", authRateLimit({ limit: 10 }), wrap(async (req, res) => {
    const tokenHash = createHash("sha256").update(String(req.body.token || "")).digest("hex");
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [[record]] = await conn.execute(
        `SELECT id, user_id FROM email_verification_tokens
         WHERE token_hash = ? AND used_at IS NULL AND expires_at > NOW()
         FOR UPDATE`,
        [tokenHash],
      );
      if (!record) {
        await conn.rollback();
        return res.status(400).json({ message: "ลิงก์ยืนยันอีเมลไม่ถูกต้องหรือหมดอายุ" });
      }
      await conn.execute(
        "UPDATE email_verification_tokens SET used_at = NOW() WHERE id = ?",
        [record.id],
      );
      await conn.execute(
        `UPDATE users
         SET email_verified_at = COALESCE(email_verified_at, NOW()), status = 'active'
         WHERE id = ?`,
        [record.user_id],
      );
      await conn.commit();
      res.json({ message: "ยืนยันอีเมลแล้ว กรุณารอผู้ดูแลบริษัทอนุมัติ" });
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      conn.release();
    }
  }));

  app.post("/api/auth/resend-verification", authRateLimit({ limit: 5 }), wrap(async (req, res) => {
    const email = String(req.body.email || "").trim().toLowerCase();
    const [[user]] = await pool.execute(
      `SELECT u.id, u.email, cm.company_id, cm.status membership_status
       FROM users u
       JOIN company_memberships cm
         ON cm.user_id = u.id AND cm.status IN ('pending', 'active')
       JOIN companies c ON c.id = cm.company_id AND c.is_active = TRUE
       WHERE u.email = ?
         AND u.status <> 'suspended'
         AND u.email_verified_at IS NULL
       ORDER BY cm.status = 'active' DESC, cm.id
       LIMIT 1`,
      [email],
    );
    if (user) {
      const { token, hash } = createOneTimeToken();
      const verificationUrl =
        `${frontendUrl}/verify-email?token=${encodeURIComponent(token)}`;
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        await connection.execute(
          `UPDATE email_verification_tokens
           SET used_at = NOW()
           WHERE user_id = ? AND used_at IS NULL`,
          [user.id],
        );
        await connection.execute(
          `INSERT INTO email_verification_tokens (user_id, token_hash, expires_at)
           VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 24 HOUR))`,
          [user.id, hash],
        );
        await enqueueOutbox(connection, {
          companyId: user.company_id,
          eventType: "email.send",
          aggregateType: "user",
          aggregateId: user.id,
          dedupeKey: `email.verify:${user.id}:${hash}`,
          payload: {
            to: user.email,
            ...verificationEmail({
              url: verificationUrl,
              approvalRequired: user.membership_status !== "active",
            }),
            developmentUrl: verificationUrl,
          },
        });
        await connection.commit();
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
    }
    res.json({
      message: "หากบัญชีนี้ยังไม่ได้ยืนยันอีเมล ระบบจะส่งลิงก์ยืนยันให้",
    });
  }));

  app.post("/api/auth/forgot-password", authRateLimit({ limit: 5 }), wrap(async (req, res) => {
    const email = String(req.body.email || "").trim().toLowerCase();
    const [[user]] = await pool.execute(
      `SELECT u.id, u.email, cm.company_id
       FROM users u
       JOIN company_memberships cm ON cm.user_id = u.id AND cm.status = 'active'
       JOIN companies c ON c.id = cm.company_id AND c.is_active = TRUE
       WHERE u.email = ?
         AND u.status <> 'suspended'
         AND u.email_verified_at IS NOT NULL
       ORDER BY cm.id
       LIMIT 1`,
      [email],
    );
    if (user) {
      const { token, hash } = createOneTimeToken();
      const resetUrl = `${frontendUrl}/reset-password?token=${encodeURIComponent(token)}`;
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        await connection.execute(
          `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
           VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 30 MINUTE))`,
          [user.id, hash],
        );
        await enqueueOutbox(connection, {
          companyId: user.company_id,
          eventType: "email.send",
          aggregateType: "user",
          aggregateId: user.id,
          dedupeKey: `email.reset:${user.id}:${hash}`,
          payload: {
            to: user.email,
            ...passwordResetEmail({ url: resetUrl }),
            developmentUrl: resetUrl,
          },
        });
        await connection.commit();
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
    }
    res.json({ message: "หากพบอีเมล ระบบจะส่งลิงก์ตั้งรหัสผ่านใหม่ให้" });
  }));

  app.post("/api/auth/reset-password", authRateLimit({ limit: 5 }), wrap(async (req, res) => {
    const passwordErrors = passwordPolicyErrors(req.body.password);
    if (passwordErrors.length) {
      return res.status(400).json({
        code: "PASSWORD_POLICY_FAILED",
        message: passwordErrors[0],
        errors: passwordErrors,
      });
    }
    const tokenHash = createHash("sha256").update(String(req.body.token || "")).digest("hex");
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [[record]] = await conn.execute(
        `SELECT prt.id, prt.user_id, u.password_hash
         FROM password_reset_tokens prt
         JOIN users u ON u.id = prt.user_id
         WHERE prt.token_hash = ? AND prt.used_at IS NULL AND prt.expires_at > NOW()
         FOR UPDATE`,
        [tokenHash],
      );
      if (!record) {
        await conn.rollback();
        return res.status(400).json({ message: "ลิงก์ตั้งรหัสผ่านไม่ถูกต้องหรือหมดอายุ" });
      }
      if (await bcrypt.compare(req.body.password, record.password_hash)) {
        await conn.rollback();
        return res.status(400).json({
          code: "PASSWORD_REUSED",
          message: "รหัสผ่านใหม่ต้องไม่ซ้ำกับรหัสผ่านปัจจุบัน",
        });
      }
      const passwordHash = await bcrypt.hash(req.body.password, 12);
      await conn.execute(
        "UPDATE password_reset_tokens SET used_at = NOW() WHERE id = ?",
        [record.id],
      );
      await conn.execute(
        `UPDATE users SET password_hash = ?, token_version = token_version + 1
         WHERE id = ?`,
        [passwordHash, record.user_id],
      );
      await conn.execute(
        `UPDATE password_reset_tokens SET used_at = NOW()
         WHERE user_id = ? AND used_at IS NULL`,
        [record.user_id],
      );
      await conn.commit();
      invalidateSessionCache?.();
      res.json({ message: "ตั้งรหัสผ่านใหม่แล้ว" });
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      conn.release();
    }
  }));

  app.post("/api/auth/login", authRateLimit({ limit: 10 }), wrap(async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ message: "กรุณากรอกอีเมลและรหัสผ่าน" });
    }
    const [rows] = await pool.execute(
      `SELECT id, name, email, password_hash, status, email_verified_at, token_version
       FROM users WHERE email = ?`,
      [email.toLowerCase()],
    );
    const user = rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ message: "อีเมลหรือรหัสผ่านไม่ถูกต้อง" });
    }
    if (!user.email_verified_at) {
      return res.status(403).json({
        code: "EMAIL_NOT_VERIFIED",
        message: "กรุณายืนยันอีเมลก่อนเข้าสู่ระบบ",
      });
    }
    if (user.status !== "active") {
      return res.status(403).json({ message: "บัญชียังไม่พร้อมใช้งาน" });
    }
    const [[membership]] = await pool.execute(
      `SELECT cm.company_id
       FROM company_memberships cm
       JOIN companies c ON c.id = cm.company_id AND c.is_active = TRUE
       WHERE cm.user_id = ? AND cm.status = 'active'
       ORDER BY cm.id LIMIT 1`,
      [user.id],
    );
    if (!membership) {
      return res.status(403).json({ message: "บัญชียังไม่ได้รับอนุมัติจากผู้ดูแลบริษัท" });
    }
    const session = await loadSession(jwt.sign(
      { id: user.id, activeCompanyId: membership.company_id, tokenVersion: user.token_version },
      jwtSecret,
      { ...JWT_SIGN_OPTIONS, expiresIn: "2m" },
    ));
    const token = sign(session);
    setSessionCookie(res, token, config);
    const [companies] = await pool.execute(
      `SELECT c.id, c.name, c.parent_id, cm.employee_code, cm.status
       FROM company_memberships cm
       JOIN companies c ON c.id = cm.company_id
       WHERE cm.user_id = ? AND cm.status = 'active' AND c.is_active = TRUE
       ORDER BY c.name`,
      [session.id],
    );
    res.json({ token, user: session, companies });
  }));

  app.post("/api/auth/logout", auth, wrap(async (req, res) => {
    await pool.execute(
      "UPDATE users SET token_version = token_version + 1 WHERE id = ?",
      [req.user.id],
    );
    invalidateSessionCache?.();
    clearSessionCookie(res, config);
    await audit(req, "auth.logout", "user", req.user.id);
    res.json({ message: "ออกจากระบบแล้ว" });
  }));

  app.get("/api/auth/me", auth, wrap(async (req, res) => {
    const [companies] = await pool.execute(
      `SELECT c.id, c.name, c.parent_id, cm.employee_code, cm.status
       FROM company_memberships cm
       JOIN companies c ON c.id = cm.company_id
       WHERE cm.user_id = ? AND cm.status = 'active' AND c.is_active = TRUE
       ORDER BY c.name`,
      [req.user.id],
    );
    res.json({ user: req.user, companies });
  }));

  app.post("/api/auth/switch-company", auth, wrap(async (req, res) => {
    const companyId = Number(req.body.companyId);
    if (!Number.isInteger(companyId) || companyId <= 0) {
      return res.status(400).json({ message: "companyId ไม่ถูกต้อง" });
    }
    const switched = await loadSession(jwt.sign(
      { id: req.user.id, activeCompanyId: companyId, tokenVersion: req.user.tokenVersion },
      jwtSecret,
      { ...JWT_SIGN_OPTIONS, expiresIn: "2m" },
    ));
    const token = sign(switched);
    setSessionCookie(res, token, config);
    await audit(
      { user: switched, ip: req.ip },
      "auth.company_switched",
      "company",
      companyId,
    );
    res.json({ token, user: switched });
  }));
}
