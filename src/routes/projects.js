import { createReadStream } from "node:fs";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import {
  INLINE_IMAGE_TYPES,
  attachmentRoot,
  createAttachmentUpload,
  safeDisplayName,
  storagePath,
  validAttachment,
} from "../core/attachments.js";
import {
  emitWeeklyPlanChanged,
  fetchWeeklyPlanRow,
} from "../services/realtime-patches.js";

function optionalReplyId(value) {
  if (value === undefined || value === null || value === "") return null;
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : NaN;
}

function replyPreview(row, prefix = "reply_") {
  const id = Number(row[`${prefix}id`]);
  if (!id) return null;
  const body = String(row[`${prefix}body`] || "").trim();
  const hasAttachments = Boolean(row[`${prefix}has_attachments`]);
  return {
    id,
    user_id: Number(row[`${prefix}user_id`]),
    user_name: row[`${prefix}user_name`] || "",
    body: body || (hasAttachments ? "ไฟล์แนบ" : ""),
    has_attachments: hasAttachments,
  };
}

export function registerProjectRoutes(app, deps) {
  const {
    audit,
    auth,
    canAccessProject,
    canManageProject,
    config,
    ensureProjectMember,
    getProjectBoardGate,
    getProjectById,
    hasPermission,
    io,
    isProjectStaffMember,
    isRequesterPersona,
    normalizeBudget,
    normalizeCurrency,
    notify,
    notifyProjectRecipientsLater,
    paginatedJson,
    parsePagination,
    pool,
    requirePermission,
    STAFF_MEMBERSHIP_SQL,
    syncIssueMembersFromProject,
    toDateOnly,
    uniquePositiveIds,
    usersExist,
    wrap,
  } = deps;
  const projectAttachmentRoot = attachmentRoot(config, "project-chat");
  const upload = createAttachmentUpload(config);

  app.get("/api/projects/picker", auth, wrap(async (req, res) => {
    const [rows] = await pool.execute(
      `SELECT id, code, name
       FROM projects
       WHERE company_id = ? AND status = 'active'
       ORDER BY name`,
      [req.user.companyId],
    );
    res.json(rows);
  }));

  app.get("/api/projects", auth, wrap(async (req, res) => {
    const readAll = hasPermission(req.user, "projects.read_all");
    const pagination = parsePagination(req, { defaultLimit: 100, maxLimit: 200 });
    if (isRequesterPersona(req.user) && !readAll) {
      return paginatedJson(res, [], 0, pagination);
    }
    const accessParams = [req.user.companyId, readAll ? 1 : 0, req.user.id, req.user.id, req.user.id];
    const accessWhere = `WHERE p.company_id = ? AND ((? = 1)
          OR p.created_by = ?
          OR p.owner_id = ?
          OR EXISTS (
            SELECT 1 FROM project_members m
            WHERE m.project_id = p.id AND m.user_id = ?
          ))`;
  
    const [[{ total }]] = await pool.execute(
      `SELECT COUNT(*) total FROM projects p ${accessWhere}`,
      accessParams,
    );
  
    const [rows] = await pool.execute(
      `SELECT p.id, p.name, p.code, p.status, p.start_date, p.end_date,
              p.budget, p.currency, p.owner_id, p.created_by, p.created_at,
              LEFT(p.description, 280) AS description,
              creator.name creator_name,
              owner.name owner_name,
              COALESCE(member_stats.member_count, 0) member_count,
              COALESCE(task_stats.task_count, 0) task_count,
              COALESCE(task_stats.done_count, 0) done_count,
              COALESCE(task_stats.standalone_total, 0)
                + COALESCE(issue_stats.issue_count, 0) work_total,
              COALESCE(task_stats.standalone_done, 0)
                + COALESCE(issue_stats.issue_closed, 0) work_done
       FROM projects p
       JOIN users owner ON owner.id = p.owner_id
       JOIN users creator ON creator.id = p.created_by
       LEFT JOIN (
         SELECT pm.project_id, COUNT(*) member_count
         FROM project_members pm
         JOIN projects scoped ON scoped.id = pm.project_id
         JOIN company_memberships cm
           ON cm.company_id = scoped.company_id
          AND cm.user_id = pm.user_id
          AND cm.status = 'active'
         WHERE scoped.company_id = ?
         GROUP BY pm.project_id
       ) member_stats ON member_stats.project_id = p.id
       LEFT JOIN (
         SELECT t.project_id,
                COUNT(*) task_count,
                SUM(t.status = 'done') done_count,
                SUM(t.issue_id IS NULL) standalone_total,
                SUM(t.issue_id IS NULL AND t.status = 'done') standalone_done
         FROM tasks t
         JOIN projects scoped ON scoped.id = t.project_id
         WHERE scoped.company_id = ?
         GROUP BY t.project_id
       ) task_stats ON task_stats.project_id = p.id
       LEFT JOIN (
         SELECT i.project_id,
                COUNT(*) issue_count,
                SUM(i.status = 'closed') issue_closed
         FROM issues i
         WHERE i.company_id = ? AND i.project_id IS NOT NULL
         GROUP BY i.project_id
       ) issue_stats ON issue_stats.project_id = p.id
       ${accessWhere}
       ORDER BY p.created_at DESC
       LIMIT ${pagination.limit} OFFSET ${pagination.offset}`,
      [req.user.companyId, req.user.companyId, req.user.companyId, ...accessParams],
    );
    paginatedJson(
      res,
      rows.map((row) => ({
        ...row,
        member_count: Number(row.member_count || 0),
        task_count: Number(row.task_count || 0),
        done_count: Number(row.done_count || 0),
        work_total: Number(row.work_total || 0),
        work_done: Number(row.work_done || 0),
        budget: Number(row.budget || 0),
      })),
      total,
      pagination,
    );
  }));
  
  app.post("/api/projects", auth, requirePermission("projects.create"), wrap(async (req, res) => {
    const {
      name,
      code,
      description,
      prd,
      startDate,
      endDate,
      ownerId,
      memberIds,
    } = req.body;
  
    if (!name || !code) {
      return res.status(400).json({ message: "กรุณาระบุชื่อและรหัสโครงการ" });
    }
  
    const owner = Number(ownerId || req.user.id);
    if (!Number.isInteger(owner) || owner <= 0) {
      return res.status(400).json({ message: "ownerId ไม่ถูกต้อง" });
    }
  
    const extraMembers = uniquePositiveIds(memberIds).filter((id) => id !== owner && id !== req.user.id);
    const allUserIds = uniquePositiveIds([owner, req.user.id, ...extraMembers]);
    if (!(await usersExist(allUserIds, req.user.companyId))) {
      return res.status(400).json({ message: "พบผู้ใช้ที่ไม่ถูกต้องในสมาชิกโครงการ" });
    }
  
    const conn = await pool.getConnection();
    let projectId;
    try {
      await conn.beginTransaction();
      const [result] = await conn.execute(
        `INSERT INTO projects
          (company_id, name, code, description, prd, status, start_date, end_date,
           owner_id, approved_by, created_by, budget, currency)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          req.user.companyId,
          name,
          String(code).toUpperCase(),
          description || null,
          prd || null,
          "pending",
          startDate || null,
          endDate || null,
          owner,
          null,
          req.user.id,
          0,
          "THB",
        ],
      );
      projectId = result.insertId;
  
      await ensureProjectMember(conn, projectId, req.user.id, "Creator");
      await ensureProjectMember(
        conn,
        projectId,
        owner,
        owner === req.user.id ? "Creator / Owner" : "Project owner",
      );
      for (const memberId of extraMembers) {
        await ensureProjectMember(conn, projectId, memberId, null);
      }
      await conn.commit();
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      conn.release();
    }
  
    const notifyIds = uniquePositiveIds([owner, ...extraMembers])
      .filter((id) => id !== req.user.id);
    await Promise.all(notifyIds.map((userId) =>
      notify(
        userId,
        "เพิ่มเข้าโครงการ",
        `คุณถูกเพิ่มเข้าโครงการ ${name} (${String(code).toUpperCase()})`,
        {
          targetUrl: `/projects/${projectId}`,
          entityType: "project",
          entityId: projectId,
        },
      ),
    ));
  
    res.status(201).json({ id: projectId, message: "สร้างโครงการเรียบร้อย" });
  }));
  
  app.get("/api/projects/:id", auth, wrap(async (req, res) => {
    const projectId = Number(req.params.id);
    const access = await canAccessProject(req.user, projectId);
    if (access === null) return res.status(404).json({ message: "ไม่พบโครงการ" });
    if (!access) return res.status(403).json({ message: "คุณไม่มีสิทธิ์เข้าถึงโครงการนี้" });
  
    const project = await getProjectById(projectId, req.user.companyId);
    const [members] = await pool.execute(
      `SELECT pm.user_id, pm.responsibility, pm.joined_at,
              u.name, u.email, u.role, u.department,
              EXISTS (
                SELECT 1
                FROM membership_roles mr
                JOIN roles r ON r.id = mr.role_id
                WHERE mr.membership_id = cm.id
                  AND ${STAFF_MEMBERSHIP_SQL}
              ) is_staff
       FROM project_members pm
       JOIN users u ON u.id = pm.user_id
       JOIN projects member_project ON member_project.id = pm.project_id
       JOIN company_memberships cm
         ON cm.company_id = member_project.company_id
        AND cm.user_id = pm.user_id
        AND cm.status = 'active'
       WHERE pm.project_id = ?
       ORDER BY u.name`,
      [projectId],
    );
    const canManage = await canManageProject(req.user, projectId);
    const isMember = hasPermission(req.user, "projects.read_all")
      || members.some((m) => Number(m.user_id) === Number(req.user.id));
    const canEditPlans = await isProjectStaffMember(projectId, req.user.id);
    const boardGate = await getProjectBoardGate(pool, projectId);
    const canCreateTasks = hasPermission(req.user, "tasks.create")
      && await isProjectStaffMember(projectId, req.user.id)
      && !boardGate.boardLocked;
    const [[work]] = await pool.execute(
      `SELECT
         (
           SELECT COUNT(*) FROM tasks t
           WHERE t.project_id = ? AND t.issue_id IS NULL
         ) + (
           SELECT COUNT(*) FROM issues i WHERE i.project_id = ?
         ) total,
         (
           SELECT COUNT(*) FROM tasks t
           WHERE t.project_id = ? AND t.issue_id IS NULL AND t.status = 'done'
         ) + (
           SELECT COUNT(*) FROM issues i WHERE i.project_id = ? AND i.status = 'closed'
         ) done`,
      [projectId, projectId, projectId, projectId],
    );
  
    res.json({
      project: {
        ...project,
        budget: Number(project.budget || 0),
        work_total: Number(work.total || 0),
        work_done: Number(work.done || 0),
        completion_percent: Number(work.total || 0)
          ? Math.round((Number(work.done || 0) / Number(work.total)) * 100)
          : 0,
        board_locked: boardGate.boardLocked,
        open_task_count: boardGate.openTaskCount,
      },
      members,
      permissions: {
        canManage: Boolean(canManage),
        isMember,
        canEditPlans,
        canCreateTasks,
        boardLocked: boardGate.boardLocked,
      },
    });
  }));
  
  app.patch("/api/projects/:id", auth, requirePermission("projects.update"), wrap(async (req, res) => {
    const projectId = Number(req.params.id);
    const manage = await canManageProject(req.user, projectId);
    if (manage === null) return res.status(404).json({ message: "ไม่พบโครงการ" });
    if (!manage) return res.status(403).json({ message: "คุณไม่มีสิทธิ์จัดการโครงการนี้" });
  
    const project = await getProjectById(projectId, req.user.companyId);
    const fields = [];
    const values = [];
  
    if (req.body.name !== undefined) {
      if (!String(req.body.name).trim()) {
        return res.status(400).json({ message: "ชื่อโครงการไม่ถูกต้อง" });
      }
      fields.push("name = ?");
      values.push(String(req.body.name).trim());
    }
    if (req.body.description !== undefined) {
      fields.push("description = ?");
      values.push(req.body.description || null);
    }
    if (req.body.prd !== undefined) {
      fields.push("prd = ?");
      values.push(req.body.prd || null);
    }
    if (req.body.startDate !== undefined) {
      fields.push("start_date = ?");
      values.push(req.body.startDate || null);
    }
    if (req.body.endDate !== undefined) {
      fields.push("end_date = ?");
      values.push(req.body.endDate || null);
    }
    let nextOwnerId = Number(project.owner_id);
    if (req.body.ownerId !== undefined) {
      nextOwnerId = Number(req.body.ownerId);
      if (!Number.isInteger(nextOwnerId) || nextOwnerId <= 0) {
        return res.status(400).json({ message: "ownerId ไม่ถูกต้อง" });
      }
      if (!(await usersExist([nextOwnerId], req.user.companyId))) {
        return res.status(400).json({ message: "ไม่พบผู้ใช้ที่เป็นเจ้าของโครงการ" });
      }
      fields.push("owner_id = ?");
      values.push(nextOwnerId);
    }
  
    if (!fields.length) {
      return res.status(400).json({ message: "ไม่มีข้อมูลให้อัปเดต" });
    }
  
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      values.push(projectId);
      await conn.execute(
        `UPDATE projects SET ${fields.join(", ")} WHERE id = ?`,
        values,
      );
      await ensureProjectMember(conn, projectId, nextOwnerId, "Project owner");
      await ensureProjectMember(conn, projectId, project.created_by, "Creator");
      await conn.commit();
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      conn.release();
    }
  
    res.json({ message: "อัปเดตโครงการแล้ว" });
  }));
  
  app.put("/api/projects/:id/members", auth, requirePermission("projects.members.manage"), wrap(async (req, res) => {
    const projectId = Number(req.params.id);
    const manage = await canManageProject(req.user, projectId);
    if (manage === null) return res.status(404).json({ message: "ไม่พบโครงการ" });
    if (!manage) return res.status(403).json({ message: "คุณไม่มีสิทธิ์จัดการสมาชิกโครงการ" });
  
    const project = await getProjectById(projectId, req.user.companyId);
    const ownerId = Number(req.body.ownerId || project.owner_id);
    if (!Number.isInteger(ownerId) || ownerId <= 0) {
      return res.status(400).json({ message: "ownerId ไม่ถูกต้อง" });
    }
  
    const incoming = Array.isArray(req.body.members) ? req.body.members : [];
    const memberMap = new Map();
    for (const item of incoming) {
      const userId = Number(item?.userId);
      if (!Number.isInteger(userId) || userId <= 0) {
        return res.status(400).json({ message: "รายชื่อสมาชิกไม่ถูกต้อง" });
      }
      const responsibility = item?.responsibility == null
        ? null
        : String(item.responsibility).slice(0, 500);
      memberMap.set(userId, responsibility);
    }
  
    // Always keep creator + owner
    if (!memberMap.has(Number(project.created_by))) {
      memberMap.set(Number(project.created_by), "Creator");
    }
    if (!memberMap.has(ownerId)) {
      memberMap.set(ownerId, "Project owner");
    } else if (!memberMap.get(ownerId)) {
      memberMap.set(ownerId, "Project owner");
    }
  
    const allIds = [...memberMap.keys()];
    if (!(await usersExist(allIds, req.user.companyId))) {
      return res.status(400).json({ message: "พบผู้ใช้ที่ไม่ถูกต้องในสมาชิกโครงการ" });
    }
  
    const [existingRows] = await pool.execute(
      "SELECT user_id FROM project_members WHERE project_id = ?",
      [projectId],
    );
    const existingIds = new Set(existingRows.map((row) => Number(row.user_id)));
  
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.execute("UPDATE projects SET owner_id = ? WHERE id = ?", [ownerId, projectId]);
      await conn.execute("DELETE FROM project_members WHERE project_id = ?", [projectId]);
      for (const [userId, responsibility] of memberMap.entries()) {
        await conn.execute(
          `INSERT INTO project_members (project_id, user_id, responsibility)
           VALUES (?, ?, ?)`,
          [projectId, userId, responsibility],
        );
      }
      await conn.commit();
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      conn.release();
    }
  
    // Keep Ticket members in sync for open tickets linked to this project
    const [linkedIssues] = await pool.execute(
      `SELECT i.* FROM issues i
       WHERE i.project_id = ? AND i.status <> 'closed'`,
      [projectId],
    );
    await Promise.all(linkedIssues.map((linked) =>
      syncIssueMembersFromProject(pool, linked, req.user.id),
    ));
  
    const newlyAdded = allIds.filter((id) => !existingIds.has(id) && id !== req.user.id);
    await Promise.all(newlyAdded.map((userId) =>
      notify(
        userId,
        "เพิ่มเข้าโครงการ",
        `คุณถูกเพิ่มเข้าโครงการ ${project.name} (${project.code})`,
        {
          targetUrl: `/projects/${projectId}`,
          entityType: "project",
          entityId: projectId,
        },
      ),
    ));
  
    res.json({ message: "อัปเดตสมาชิกโครงการแล้ว" });
  }));
  
  app.patch("/api/projects/:id/status", auth, requirePermission("projects.status.update"), wrap(async (req, res) => {
    const projectId = Number(req.params.id);
    const manage = await canManageProject(req.user, projectId);
    if (manage === null) return res.status(404).json({ message: "ไม่พบโครงการ" });
    if (!manage) return res.status(403).json({ message: "คุณไม่มีสิทธิ์เปลี่ยนสถานะโครงการ" });
  
    const nextStatus = req.body.status;
    const allowed = ["pending", "active", "on_hold", "completed", "rejected"];
    if (!allowed.includes(nextStatus)) {
      return res.status(400).json({ message: "สถานะไม่ถูกต้อง" });
    }
    const isApprovalDecision = ["active", "rejected"].includes(nextStatus);
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [[lockedProject]] = await conn.execute(
        `SELECT status FROM projects
         WHERE id = ? AND company_id = ?
         FOR UPDATE`,
        [projectId, req.user.companyId],
      );
      if (!lockedProject) {
        await conn.rollback();
        return res.status(404).json({ message: "ไม่พบโครงการ" });
      }
      if (isApprovalDecision && lockedProject.status !== "pending") {
        await conn.rollback();
        return res.status(409).json({
          message: "อนุมัติหรือปฏิเสธได้เฉพาะโครงการที่รออนุมัติ",
        });
      }
      if (["on_hold", "completed"].includes(nextStatus)
          && !["active", "on_hold"].includes(lockedProject.status)) {
        await conn.rollback();
        return res.status(409).json({
          message: "ต้องอนุมัติโครงการก่อนจึงจะพักหรือปิดโครงการได้",
        });
      }
      await conn.execute(
        `UPDATE projects
         SET status = ?,
             approved_by = CASE WHEN ? THEN ? WHEN ? = 'pending' THEN NULL ELSE approved_by END,
             approved_at = CASE WHEN ? THEN NOW() WHEN ? = 'pending' THEN NULL ELSE approved_at END
         WHERE id = ? AND company_id = ?`,
        [
          nextStatus,
          isApprovalDecision,
          req.user.id,
          nextStatus,
          isApprovalDecision,
          nextStatus,
          projectId,
          req.user.companyId,
        ],
      );
      await audit(
        req,
        isApprovalDecision ? `project.${nextStatus}` : "project.status_updated",
        "project",
        projectId,
        { from: lockedProject.status, to: nextStatus },
        conn,
      );
      await conn.commit();
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      conn.release();
    }
    res.json({ message: "อัปเดตสถานะโครงการแล้ว" });
  }));
  
  app.get("/api/projects/:id/weekly-plans", auth, wrap(async (req, res) => {
    const projectId = Number(req.params.id);
    const access = await canAccessProject(req.user, projectId);
    if (access === null) return res.status(404).json({ message: "ไม่พบโครงการ" });
    if (!access) return res.status(403).json({ message: "คุณไม่มีสิทธิ์เข้าถึงโครงการนี้" });
  
    const [rows] = await pool.execute(
      `SELECT wp.*, a.name assignee_name, c.name created_by_name
       FROM weekly_plans wp
       LEFT JOIN users a ON a.id = wp.assignee_id
       JOIN users c ON c.id = wp.created_by
       WHERE wp.project_id = ?
       ORDER BY wp.week_start ASC, wp.week_end ASC, wp.id ASC`,
      [projectId],
    );
    res.json(rows);
  }));
  
  app.post("/api/projects/:id/weekly-plans", auth, requirePermission("projects.plan.manage"), wrap(async (req, res) => {
    const projectId = Number(req.params.id);
    const project = await getProjectById(projectId, req.user.companyId);
    if (!project) return res.status(404).json({ message: "ไม่พบโครงการ" });
    if (!(await isProjectStaffMember(projectId, req.user.id))) {
      return res.status(403).json({ message: "เฉพาะสมาชิกทีมโครงการที่แก้ไขแผนงานได้" });
    }
  
    const {
      title,
      description,
      weekStart,
      weekEnd,
      assigneeId,
      status = "planned",
    } = req.body;
  
    if (!title?.trim() || !weekStart || !weekEnd) {
      return res.status(400).json({ message: "กรุณาระบุชื่อแผนและช่วงวันที่" });
    }
    if (weekStart > weekEnd) {
      return res.status(400).json({ message: "วันสิ้นสุดต้องไม่น้อยกว่าวันเริ่ม" });
    }
    const allowedStatus = ["planned", "in_progress", "done"];
    if (!allowedStatus.includes(status)) {
      return res.status(400).json({ message: "สถานะแผนไม่ถูกต้อง" });
    }
    if (!project.start_date || !project.end_date) {
      return res.status(400).json({ message: "กรุณากำหนดวันเริ่มและวันสิ้นสุดของโครงการก่อน" });
    }
    // อนุญาตให้ช่วงงานเกินวันสิ้นสุดโครงการได้ (กรณีงานล่าช้า) — ฝั่ง UI จะทำเครื่องหมายให้เห็นชัด
  
    let assignee = null;
    if (assigneeId !== undefined && assigneeId !== null && assigneeId !== "") {
      assignee = Number(assigneeId);
      if (!Number.isInteger(assignee) || assignee <= 0) {
        return res.status(400).json({ message: "assigneeId ไม่ถูกต้อง" });
      }
      if (!(await isProjectStaffMember(projectId, assignee))) {
        return res.status(400).json({ message: "ผู้รับมอบหมายต้องเป็นสมาชิกทีมโครงการ" });
      }
    }
  
    const [result] = await pool.execute(
      `INSERT INTO weekly_plans
        (project_id, title, description, week_start, week_end, assignee_id, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        projectId,
        title.trim(),
        description || null,
        weekStart,
        weekEnd,
        assignee,
        status,
        req.user.id,
      ],
    );
  
    if (assignee) {
      await notify(assignee, "มอบหมายช่วงงานในแผนโปรเจกต์", title.trim(), {
        targetUrl: `/projects/${projectId}?tab=weekly`,
        entityType: "project",
        entityId: projectId,
      });
    }

    const plan = await fetchWeeklyPlanRow(pool, result.insertId);
    emitWeeklyPlanChanged(io, {
      companyId: req.user.companyId,
      projectId,
      actorId: req.user.id,
      op: "create",
      plan,
    });
    res.status(201).json({
      id: result.insertId,
      message: "สร้างช่วงงานในแผนโปรเจกต์แล้ว",
      plan,
    });
  }));
  
  app.patch("/api/projects/:id/weekly-plans/:planId", auth, requirePermission("projects.plan.manage"), wrap(async (req, res) => {
    const projectId = Number(req.params.id);
    const planId = Number(req.params.planId);
    const project = await getProjectById(projectId, req.user.companyId);
    if (!project) return res.status(404).json({ message: "ไม่พบโครงการ" });
    if (!(await isProjectStaffMember(projectId, req.user.id))) {
      return res.status(403).json({ message: "เฉพาะสมาชิกทีมโครงการที่แก้ไขแผนงานได้" });
    }
  
    const [[plan]] = await pool.execute(
      "SELECT id, week_start, week_end FROM weekly_plans WHERE id = ? AND project_id = ?",
      [planId, projectId],
    );
    if (!plan) return res.status(404).json({ message: "ไม่พบช่วงงานในแผนโปรเจกต์" });
  
    const fields = [];
    const values = [];
    if (req.body.title !== undefined) {
      if (!String(req.body.title).trim()) {
        return res.status(400).json({ message: "ชื่อแผนไม่ถูกต้อง" });
      }
      fields.push("title = ?");
      values.push(String(req.body.title).trim());
    }
    if (req.body.description !== undefined) {
      fields.push("description = ?");
      values.push(req.body.description || null);
    }
    if (req.body.weekStart !== undefined) {
      fields.push("week_start = ?");
      values.push(req.body.weekStart || null);
    }
    if (req.body.weekEnd !== undefined) {
      fields.push("week_end = ?");
      values.push(req.body.weekEnd || null);
    }
    const nextStart = toDateOnly(
      req.body.weekStart !== undefined ? req.body.weekStart : plan.week_start,
    );
    const nextEnd = toDateOnly(
      req.body.weekEnd !== undefined ? req.body.weekEnd : plan.week_end,
    );
    if (!nextStart || !nextEnd || nextStart > nextEnd) {
      return res.status(400).json({ message: "ช่วงวันที่ของแผนไม่ถูกต้อง" });
    }
    if (!project.start_date || !project.end_date) {
      return res.status(400).json({ message: "กรุณากำหนดวันเริ่มและวันสิ้นสุดของโครงการก่อน" });
    }
    // อนุญาตให้ช่วงงานเกินวันสิ้นสุดโครงการได้ (กรณีงานล่าช้า)
    if (req.body.status !== undefined) {
      if (!["planned", "in_progress", "done"].includes(req.body.status)) {
        return res.status(400).json({ message: "สถานะแผนไม่ถูกต้อง" });
      }
      fields.push("status = ?");
      values.push(req.body.status);
    }
    if (req.body.assigneeId !== undefined) {
      if (req.body.assigneeId === null || req.body.assigneeId === "") {
        fields.push("assignee_id = ?");
        values.push(null);
      } else {
        const assignee = Number(req.body.assigneeId);
        if (!Number.isInteger(assignee) || assignee <= 0) {
          return res.status(400).json({ message: "assigneeId ไม่ถูกต้อง" });
        }
        if (!(await isProjectStaffMember(projectId, assignee))) {
          return res.status(400).json({ message: "ผู้รับมอบหมายต้องเป็นสมาชิกทีมโครงการ" });
        }
        fields.push("assignee_id = ?");
        values.push(assignee);
      }
    }
  
    if (!fields.length) {
      return res.status(400).json({ message: "ไม่มีข้อมูลให้อัปเดต" });
    }
  
    values.push(planId, projectId);
    await pool.execute(
      `UPDATE weekly_plans SET ${fields.join(", ")} WHERE id = ? AND project_id = ?`,
      values,
    );
    const patchedPlan = await fetchWeeklyPlanRow(pool, planId);
    emitWeeklyPlanChanged(io, {
      companyId: req.user.companyId,
      projectId,
      actorId: req.user.id,
      op: "update",
      plan: patchedPlan,
    });
    res.json({ message: "อัปเดตแผนงานโปรเจกต์แล้ว", plan: patchedPlan });
  }));
  
  app.get("/api/projects/:id/messages", auth, wrap(async (req, res) => {
    const projectId = Number(req.params.id);
    const access = await canAccessProject(req.user, projectId);
    if (access === null) return res.status(404).json({ message: "ไม่พบโครงการ" });
    if (!access) return res.status(403).json({ message: "คุณไม่มีสิทธิ์เข้าถึงโครงการนี้" });
  
    const pagination = parsePagination(req, { defaultLimit: 200, maxLimit: 500 });
    const [[{ total }]] = await pool.execute(
      "SELECT COUNT(*) total FROM project_messages WHERE project_id = ?",
      [projectId],
    );
    const [rows] = await pool.execute(
      `SELECT m.id, m.project_id, m.user_id, m.reply_to_id, m.body, m.created_at,
              u.name user_name, u.role user_role,
              parent.id reply_id, parent.user_id reply_user_id,
              parent_user.name reply_user_name, LEFT(parent.body, 280) reply_body,
              EXISTS (
                SELECT 1 FROM project_message_attachments reply_attachment
                WHERE reply_attachment.message_id = parent.id
                  AND reply_attachment.project_id = m.project_id
                  AND reply_attachment.company_id = ?
              ) reply_has_attachments
       FROM project_messages m
       JOIN users u ON u.id = m.user_id
       LEFT JOIN project_messages parent
         ON parent.id = m.reply_to_id AND parent.project_id = m.project_id
       LEFT JOIN users parent_user ON parent_user.id = parent.user_id
       WHERE m.project_id = ?
       ORDER BY m.created_at DESC, m.id DESC
       LIMIT ${pagination.limit} OFFSET ${pagination.offset}`,
      [req.user.companyId, projectId],
    );
    const messageIds = rows.map((row) => Number(row.id));
    let attachmentRows = [];
    if (messageIds.length) {
      const placeholders = messageIds.map(() => "?").join(",");
      [attachmentRows] = await pool.execute(
        `SELECT id, project_id, message_id, uploader_id, original_name, mime_type,
                size_bytes, created_at
         FROM project_message_attachments
         WHERE project_id = ? AND company_id = ?
           AND message_id IN (${placeholders})
         ORDER BY created_at, id`,
        [projectId, req.user.companyId, ...messageIds],
      );
    }
    const attachmentsByMessage = new Map();
    for (const attachment of attachmentRows) {
      const key = Number(attachment.message_id);
      const current = attachmentsByMessage.get(key) || [];
      current.push(attachment);
      attachmentsByMessage.set(key, current);
    }
    const messages = rows.reverse().map((row) => ({
      id: row.id,
      project_id: row.project_id,
      user_id: row.user_id,
      user_name: row.user_name,
      user_role: row.user_role,
      reply_to_id: row.reply_to_id,
      reply_preview: replyPreview(row),
      body: row.body,
      created_at: row.created_at,
      attachments: attachmentsByMessage.get(Number(row.id)) || [],
    }));
    paginatedJson(res, messages, total, pagination);
  }));
  
  app.post("/api/projects/:id/messages",
    auth,
    requirePermission("projects.chat"),
    upload.array("files", config.attachments.maxFiles),
    wrap(async (req, res) => {
      const projectId = Number(req.params.id);
      const access = await canAccessProject(req.user, projectId);
      if (access === null) return res.status(404).json({ message: "ไม่พบโครงการ" });
      if (!access) return res.status(403).json({ message: "คุณไม่มีสิทธิ์เข้าถึงโครงการนี้" });

      const project = await getProjectById(projectId, req.user.companyId);
      if (!project) return res.status(404).json({ message: "ไม่พบโครงการ" });
      const boardGate = await getProjectBoardGate(pool, projectId);
      const [[work]] = await pool.execute(
        `SELECT
           (
             SELECT COUNT(*) FROM tasks t
             WHERE t.project_id = ? AND t.issue_id IS NULL
           ) + (
             SELECT COUNT(*) FROM issues i WHERE i.project_id = ?
           ) total,
           (
             SELECT COUNT(*) FROM tasks t
             WHERE t.project_id = ? AND t.issue_id IS NULL AND t.status = 'done'
           ) + (
             SELECT COUNT(*) FROM issues i WHERE i.project_id = ? AND i.status = 'closed'
           ) done`,
        [projectId, projectId, projectId, projectId],
      );
      const workTotal = Number(work?.total || 0);
      const workDone = Number(work?.done || 0);
      const workComplete = workTotal > 0 && workDone >= workTotal;
      if (boardGate.boardLocked || workComplete || project.status === "completed") {
        return res.status(409).json({
          message: "งานทั้งหมดเสร็จสิ้นแล้ว ไม่สามารถส่งข้อความในแชททีมได้อีก",
        });
      }

      const files = req.files || [];
      const body = String(req.body?.body || "").trim();
      const replyToId = optionalReplyId(req.body?.replyToId);
      if (Number.isNaN(replyToId)) {
        return res.status(400).json({ message: "replyToId ต้องเป็นจำนวนเต็มบวก" });
      }
      if (!body && !files.length) {
        return res.status(400).json({ message: "กรุณากรอกข้อความหรือแนบไฟล์" });
      }
      if (files.some((file) => !validAttachment(file))) {
        return res.status(415).json({
          message: "รองรับเฉพาะ JPG, PNG, GIF, WebP, PDF และ TXT ที่ชนิดไฟล์ตรงกับนามสกุล",
        });
      }

      let parentPreview = null;
      if (replyToId) {
        const [[parent]] = await pool.execute(
          `SELECT parent.id reply_id, parent.user_id reply_user_id,
                  parent_user.name reply_user_name,
                  LEFT(parent.body, 280) reply_body,
                  EXISTS (
                    SELECT 1 FROM project_message_attachments reply_attachment
                    WHERE reply_attachment.message_id = parent.id
                      AND reply_attachment.project_id = parent.project_id
                      AND reply_attachment.company_id = ?
                  ) reply_has_attachments
           FROM project_messages parent
           JOIN projects parent_project
             ON parent_project.id = parent.project_id
            AND parent_project.company_id = ?
           JOIN users parent_user ON parent_user.id = parent.user_id
           WHERE parent.id = ? AND parent.project_id = ?`,
          [req.user.companyId, req.user.companyId, replyToId, projectId],
        );
        if (!parent) {
          return res.status(404).json({
            message: "ไม่พบข้อความต้นทางในแชทโครงการนี้",
          });
        }
        parentPreview = replyPreview(parent);
      }

      if (files.length) await mkdir(projectAttachmentRoot, { recursive: true });
      const stored = [];
      const attachments = [];
      const connection = await pool.getConnection();
      let messageId;
      try {
        await connection.beginTransaction();
        const [[lockedProject]] = await connection.execute(
          "SELECT id FROM projects WHERE id = ? AND company_id = ? FOR UPDATE",
          [projectId, req.user.companyId],
        );
        if (!lockedProject) {
          throw Object.assign(new Error("project tenant changed"), { code: "PROJECT_NOT_FOUND" });
        }
        const [result] = await connection.execute(
          `INSERT INTO project_messages (project_id, user_id, reply_to_id, body)
           VALUES (?, ?, ?, ?)`,
          [projectId, req.user.id, replyToId, body],
        );
        messageId = result.insertId;

        for (const file of files) {
          const storageName = randomBytes(24).toString("hex");
          const target = storagePath(projectAttachmentRoot, storageName);
          await writeFile(target, file.buffer, { flag: "wx", mode: 0o600 });
          stored.push(target);
          const originalName = safeDisplayName(file.originalname);
          const [attachmentResult] = await connection.execute(
            `INSERT INTO project_message_attachments
              (company_id, project_id, message_id, uploader_id, storage_name,
               original_name, mime_type, size_bytes)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              req.user.companyId,
              projectId,
              messageId,
              req.user.id,
              storageName,
              originalName,
              file.mimetype,
              file.size,
            ],
          );
          attachments.push({
            id: attachmentResult.insertId,
            project_id: projectId,
            message_id: Number(messageId),
            uploader_id: Number(req.user.id),
            original_name: originalName,
            mime_type: file.mimetype,
            size_bytes: file.size,
            created_at: new Date().toISOString(),
          });
        }
        await connection.commit();
      } catch (error) {
        await connection.rollback();
        await Promise.all(stored.map((target) => unlink(target).catch(() => {})));
        throw error;
      } finally {
        connection.release();
      }

      const message = {
        id: messageId,
        project_id: projectId,
        user_id: Number(req.user.id),
        user_name: req.user.name,
        user_role: req.user.role,
        reply_to_id: replyToId,
        reply_preview: parentPreview,
        body,
        attachments,
        created_at: new Date().toISOString().slice(0, 19).replace("T", " "),
      };
      io.to(`company:${req.user.companyId}:project:${projectId}`).emit("projectMessage", message);
      res.status(201).json({ id: messageId, message: "ส่งข้อความแล้ว", data: message });

      pool.execute(
        "SELECT name FROM projects WHERE id = ? AND company_id = ?",
        [projectId, req.user.companyId],
      )
        .then(([[project]]) => {
          const preview = body || "แนบไฟล์";
          notifyProjectRecipientsLater(
            projectId,
            req.user.id,
            project?.name || "แชททีม",
            preview.length > 180 ? `${preview.slice(0, 180)}…` : preview,
            {
              type: "chat",
              targetUrl: `/projects/${projectId}?tab=chat`,
              actorName: req.user.name,
              actorId: req.user.id,
            },
          );
        })
        .catch((err) => console.error("project chat notify failed", err));
    }),
  );

  app.get(
    "/api/projects/:id/messages/:messageId/attachments/:attachmentId/download",
    auth,
    wrap(async (req, res) => {
      const projectId = Number(req.params.id);
      const access = await canAccessProject(req.user, projectId);
      if (access === null) return res.status(404).json({ message: "ไม่พบโครงการ" });
      if (!access) return res.status(403).json({ message: "คุณไม่มีสิทธิ์ดาวน์โหลดไฟล์นี้" });
      const [[attachment]] = await pool.execute(
        `SELECT storage_name, original_name, mime_type
         FROM project_message_attachments
         WHERE id = ? AND message_id = ? AND project_id = ? AND company_id = ?`,
        [req.params.attachmentId, req.params.messageId, projectId, req.user.companyId],
      );
      if (!attachment) return res.status(404).json({ message: "ไม่พบไฟล์" });
      res.setHeader("Content-Type", attachment.mime_type);
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename*=UTF-8''${encodeURIComponent(attachment.original_name)}`,
      );
      createReadStream(storagePath(projectAttachmentRoot, attachment.storage_name))
        .on("error", () => {
          if (!res.headersSent) res.status(404).json({ message: "ไม่พบไฟล์ใน storage" });
          else res.destroy();
        })
        .pipe(res);
    }),
  );

  app.get(
    "/api/projects/:id/messages/:messageId/attachments/:attachmentId/inline",
    auth,
    wrap(async (req, res) => {
      const projectId = Number(req.params.id);
      const access = await canAccessProject(req.user, projectId);
      if (access === null) return res.status(404).json({ message: "ไม่พบโครงการ" });
      if (!access) return res.status(403).json({ message: "คุณไม่มีสิทธิ์ดูไฟล์นี้" });
      const [[attachment]] = await pool.execute(
        `SELECT storage_name, original_name, mime_type
         FROM project_message_attachments
         WHERE id = ? AND message_id = ? AND project_id = ? AND company_id = ?`,
        [req.params.attachmentId, req.params.messageId, projectId, req.user.companyId],
      );
      if (!attachment) return res.status(404).json({ message: "ไม่พบไฟล์" });
      if (!INLINE_IMAGE_TYPES.has(attachment.mime_type)) {
        return res.status(415).json({ message: "เปิดดูแบบ inline ได้เฉพาะไฟล์รูปภาพ" });
      }
      res.setHeader("Content-Type", attachment.mime_type);
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader(
        "Content-Disposition",
        `inline; filename*=UTF-8''${encodeURIComponent(attachment.original_name)}`,
      );
      createReadStream(storagePath(projectAttachmentRoot, attachment.storage_name))
        .on("error", () => {
          if (!res.headersSent) res.status(404).json({ message: "ไม่พบไฟล์ใน storage" });
          else res.destroy();
        })
        .pipe(res);
    }),
  );
}
