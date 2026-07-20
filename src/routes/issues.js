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

function ticketNumber() {
  const date = new Date().toISOString().slice(2, 10).replaceAll("-", "");
  return `ISS-${date}-${randomBytes(5).toString("hex").toUpperCase()}`;
}

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

const TERMINAL_ISSUE_STATUSES = new Set(["closed", "cancelled", "rejected"]);
const ISSUE_REJECTOR_ROLES = new Set([
  "group_admin",
  "company_owner",
  "company_admin",
  "project_manager",
  "dev",
]);

function isTerminalIssue(issue) {
  return TERMINAL_ISSUE_STATUSES.has(issue?.status);
}

function canRejectIssues(user) {
  return Boolean(user?.roles?.some((role) => ISSUE_REJECTOR_ROLES.has(role)));
}

export function registerIssueRoutes(app, deps) {
  const {
    addIssueActivity,
    auth,
    canAccessProject,
    canViewIssue,
    config,
    ensureIssueMember,
    ensureLinkedIssueTask,
    ensureProjectMember,
    getIssueById,
    hasPermission,
    io,
    isIssueParticipant,
    isRequesterPersona,
    issueStateForTaskStatus,
    normalizeBudget,
    normalizeCurrency,
    notify,
    notifyIssueRecipients,
    notifyIssueRecipientsLater,
    paginatedJson,
    parsePagination,
    pool,
    requirePermission,
    STAFF_MEMBERSHIP_SQL,
    syncIssueMembersFromProject,
    syncSingleLinkedTask,
    uniquePositiveIds,
    usersExist,
    wrap,
  } = deps;
  const issueAttachmentRoot = attachmentRoot(config);
  const upload = createAttachmentUpload(config);

  const canMutateAttachments = async (user, issue) => {
    if (isTerminalIssue(issue)) return false;
    if (Number(issue.requester_id) === Number(user.id)) {
      return issue.status === "open" && !issue.assignee_id;
    }
    return hasPermission(user, "issues.manage_all")
      || (hasPermission(user, "issues.update")
        && await isIssueParticipant(issue.id, user.id));
  };

  app.get("/api/issues", auth, wrap(async (req, res) => {
    const where = ["i.company_id = ?"];
    const values = [req.user.companyId];
    if (isRequesterPersona(req.user)) {
      where.push("i.requester_id = ?");
      values.push(req.user.id);
    } else if (!hasPermission(req.user, "issues.read_all") || req.query.mine === "true") {
      where.push(`(
        i.requester_id = ?
        OR
        i.assignee_id = ?
        OR EXISTS (
          SELECT 1 FROM issue_members mine
          WHERE mine.issue_id = i.id AND mine.user_id = ?
        )
        OR EXISTS (
          SELECT 1
          FROM projects related_project
          WHERE related_project.id = i.project_id
            AND related_project.company_id = i.company_id
            AND (
              related_project.owner_id = ?
              OR related_project.created_by = ?
              OR EXISTS (
                SELECT 1 FROM project_members related_member
                WHERE related_member.project_id = related_project.id
                  AND related_member.user_id = ?
              )
            )
        )
      )`);
      values.push(
        req.user.id,
        req.user.id,
        req.user.id,
        req.user.id,
        req.user.id,
        req.user.id,
      );
    }
    if (req.query.status) {
      where.push("i.status = ?");
      values.push(req.query.status);
    }
    if (req.query.excludeStatus) {
      where.push("i.status <> ?");
      values.push(req.query.excludeStatus);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const pagination = parsePagination(req, { defaultLimit: 50, maxLimit: 200 });
  
    const [[{ total }]] = await pool.execute(
      `SELECT COUNT(*) total FROM issues i ${whereSql}`,
      values,
    );
  
    const [rows] = await pool.execute(
      `SELECT i.id, i.ticket_no, i.title, i.type, i.priority, i.status, i.board_status,
              i.project_id, i.system_component, i.requester_id, i.assignee_id, i.created_at, i.updated_at,
              i.started_at, i.completed_at, i.estimated_completion_at,
              LEFT(i.description, 220) AS description,
              p.code project_code, p.name project_name, r.name requester_name, a.name assignee_name,
              COALESCE(mc.member_count, 0) member_count,
              (
                i.assignee_id = ?
                OR EXISTS (
                  SELECT 1 FROM issue_members viewer_issue_member
                  WHERE viewer_issue_member.issue_id = i.id
                    AND viewer_issue_member.user_id = ?
                )
                OR p.owner_id = ?
                OR p.created_by = ?
                OR EXISTS (
                  SELECT 1 FROM project_members viewer_project_member
                  WHERE viewer_project_member.project_id = p.id
                    AND viewer_project_member.user_id = ?
                )
              ) issue_participant
       FROM issues i
       LEFT JOIN projects p ON p.id = i.project_id AND p.company_id = i.company_id
       JOIN users r ON r.id = i.requester_id
       LEFT JOIN users a ON a.id = i.assignee_id
       LEFT JOIN (
         SELECT im.issue_id, COUNT(*) member_count
         FROM issue_members im
         JOIN issues member_issue ON member_issue.id = im.issue_id
         JOIN company_memberships cm
           ON cm.company_id = member_issue.company_id
          AND cm.user_id = im.user_id
          AND cm.status = 'active'
         GROUP BY im.issue_id
       ) mc ON mc.issue_id = i.id
       ${whereSql}
       ORDER BY i.updated_at DESC
       LIMIT ${pagination.limit} OFFSET ${pagination.offset}`,
      [req.user.id, req.user.id, req.user.id, req.user.id, req.user.id, ...values],
    );
    paginatedJson(
      res,
      rows.map((row) => {
        if (isRequesterPersona(req.user)) {
          return {
            id: row.id,
            ticket_no: row.ticket_no,
            title: row.title,
            description: row.description,
            type: row.type,
            status: row.status,
            project_id: row.project_id,
            project_code: row.project_code,
            project_name: row.project_name,
            system_component: row.system_component,
            created_at: row.created_at,
            updated_at: row.updated_at,
          };
        }
        return {
          ...row,
          member_count: Number(row.member_count || 0),
          issue_participant: Boolean(row.issue_participant),
        };
      }),
      total,
      pagination,
    );
  }));
  
  app.post("/api/issues", auth, requirePermission("issues.create"), wrap(async (req, res) => {
    const { title, description, type, priority, projectId, systemComponent } = req.body;
    if (!title || !description || !["bug", "feature", "support"].includes(type)) {
      return res.status(400).json({ message: "ข้อมูลแจ้งปัญหาไม่ครบถ้วน" });
    }
    const requesterView = isRequesterPersona(req.user);
    const effectivePriority = requesterView ? "medium" : (priority || "medium");
    if (!["low", "medium", "high", "urgent"].includes(effectivePriority)) {
      return res.status(400).json({ message: "ความสำคัญไม่ถูกต้อง" });
    }
    let linkedProjectId = null;
    if (projectId !== undefined && projectId !== null && projectId !== "") {
      linkedProjectId = Number(projectId);
      let projectAccess = false;
      if (Number.isInteger(linkedProjectId) && linkedProjectId > 0) {
        if (isRequesterPersona(req.user)) {
          const [[selectableProject]] = await pool.execute(
            `SELECT id FROM projects
             WHERE id = ? AND company_id = ? AND status = 'active'`,
            [linkedProjectId, req.user.companyId],
          );
          projectAccess = Boolean(selectableProject);
        } else {
          projectAccess = await canAccessProject(req.user, linkedProjectId);
        }
      }
      if (!projectAccess) {
        return res.status(400).json({ message: "โครงการไม่ถูกต้องหรืออยู่นอกบริษัท" });
      }
    }
    const component = String(systemComponent || "").trim().slice(0, 160) || null;
    let ticketNo;
    let result;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      ticketNo = ticketNumber();
      try {
        [result] = await pool.execute(
          `INSERT INTO issues
            (company_id, ticket_no, title, description, type, priority, project_id,
             system_component, requester_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            req.user.companyId,
            ticketNo,
            title,
            description,
            type,
            effectivePriority,
            linkedProjectId,
            component,
            req.user.id,
          ],
        );
        break;
      } catch (error) {
        if (error.code !== "ER_DUP_ENTRY" || attempt === 3) throw error;
      }
    }
    await addIssueActivity(pool, result.insertId, req.user.id, "created", "เปิด Ticket");
    const [issueResponders] = await pool.execute(
      `SELECT cm.user_id id
       FROM company_memberships cm
       JOIN membership_roles mr ON mr.membership_id = cm.id
       JOIN role_permissions rp ON rp.role_id = mr.role_id
       JOIN permissions permission ON permission.id = rp.permission_id
       WHERE cm.company_id = ? AND cm.status = 'active'
         AND permission.code IN ('issues.read_all', 'issues.accept', 'issues.manage_all')
       GROUP BY cm.user_id
       HAVING MAX(permission.code = 'issues.manage_all') = 1
          OR (
            MAX(permission.code = 'issues.read_all') = 1
            AND MAX(permission.code = 'issues.accept') = 1
          )`,
      [req.user.companyId],
    );
    await Promise.all(issueResponders.map((responder) =>
      notify(responder.id, "มี Issue ใหม่", `${ticketNo}: ${title}`, {
        targetUrl: `/issues?issue=${result.insertId}`,
        entityType: "issue",
        entityId: result.insertId,
        actorName: req.user.name,
        actorId: req.user.id,
        companyId: req.user.companyId,
      }),
    ));
    res.status(201).json({ id: result.insertId, ticketNo, message: "ส่งเรื่องเรียบร้อย" });
  }));
  
  app.get("/api/issues/:id", auth, wrap(async (req, res) => {
    const issue = await getIssueById(req.params.id, req.user.companyId);
    if (!issue) return res.status(404).json({ message: "ไม่พบ Ticket" });
    if (!(await canViewIssue(req.user, issue))) {
      return res.status(403).json({ message: "คุณไม่มีสิทธิ์ดู Ticket นี้" });
    }
    const requesterView = isRequesterPersona(req.user);
    if (requesterView) {
      const requesterCanChange = Number(issue.requester_id) === Number(req.user.id)
        && issue.status === "open"
        && !issue.assignee_id;
      const projectEndEstimate = issue.project_end_date
        ? `${String(issue.project_end_date).slice(0, 10)} 23:59:59`
        : null;
      return res.json({
        id: issue.id,
        ticket_no: issue.ticket_no,
        title: issue.title,
        description: issue.description,
        type: issue.type,
        priority: issue.priority,
        status: issue.status,
        project_id: issue.project_id,
        project_code: issue.project_code,
        project_name: issue.project_name,
        system_component: issue.system_component,
        assignee_name: issue.assignee_name || null,
        estimated_completion_at: issue.estimated_completion_at || projectEndEstimate,
        created_at: issue.created_at,
        updated_at: issue.updated_at,
        completed_at: issue.completed_at,
        rejection_reason: issue.rejection_reason,
        permissions: {
          canAccept: false,
          canAssign: false,
          canConvertToProject: false,
          canManageMembers: false,
          canWork: false,
          canUpdate: false,
          canEdit: requesterCanChange,
          canCancel: requesterCanChange,
          canReject: false,
          canDeleteAttachments: requesterCanChange,
          canUploadAttachments: requesterCanChange,
          canComment: !isTerminalIssue(issue)
            && Number(issue.requester_id) === Number(req.user.id),
        },
      });
    }
  
    const [members] = await pool.execute(
      `SELECT im.user_id, u.name, u.email, u.department, u.role, im.joined_at
       FROM issue_members im
       JOIN users u ON u.id = im.user_id
       JOIN issues member_issue ON member_issue.id = im.issue_id
       JOIN company_memberships cm
         ON cm.company_id = member_issue.company_id
        AND cm.user_id = im.user_id
        AND cm.status = 'active'
       WHERE im.issue_id = ?
       ORDER BY u.name`,
      [req.params.id],
    );
    const [activities] = await pool.execute(
      `SELECT activity.*, actor.name actor_name
       FROM issue_activities activity
       LEFT JOIN users actor ON actor.id = activity.actor_id
       WHERE activity.issue_id = ?
       ORDER BY activity.created_at DESC, activity.id DESC
       LIMIT 80`,
      [req.params.id],
    );
    activities.reverse();
    const participant = hasPermission(req.user, "issues.manage_all")
      || await isIssueParticipant(req.params.id, req.user.id);
    const projectEndEstimate = issue.project_end_date
      ? `${String(issue.project_end_date).slice(0, 10)} 23:59:59`
      : null;
    const estimatedCompletionAt = issue.estimated_completion_at || projectEndEstimate;
    const etaLocked = Boolean(issue.project_id && (issue.estimated_completion_at || issue.project_end_date));
    res.json({
      ...issue,
      estimated_completion_at: estimatedCompletionAt,
      eta_locked: etaLocked,
      members,
      activities,
      permissions: {
        canAccept: hasPermission(req.user, "issues.accept")
          && issue.status === "open"
          && !issue.assignee_id,
        canAssign: !isTerminalIssue(issue)
          && hasPermission(req.user, "issues.assign")
          && participant,
        canConvertToProject: !isTerminalIssue(issue)
          && !issue.project_id
          && participant
          && (
            hasPermission(req.user, "projects.create")
            || (
              hasPermission(req.user, "issues.transition")
              && Number(issue.assignee_id) === Number(req.user.id)
            )
          ),
        canManageMembers: !isTerminalIssue(issue)
          && hasPermission(req.user, "issues.members.manage")
          && participant,
        canWork: !isTerminalIssue(issue)
          && hasPermission(req.user, "issues.transition")
          && participant,
        canUpdate: !isTerminalIssue(issue)
          && hasPermission(req.user, "issues.update")
          && participant,
        canEdit: false,
        canCancel: false,
        canReject: canRejectIssues(req.user)
          && issue.status === "open"
          && !issue.assignee_id,
        canDeleteAttachments: !isTerminalIssue(issue)
          && (hasPermission(req.user, "issues.manage_all")
            || (hasPermission(req.user, "issues.update") && participant)),
        canUploadAttachments: !isTerminalIssue(issue)
          && (hasPermission(req.user, "issues.manage_all")
            || (hasPermission(req.user, "issues.update") && participant)),
        canComment: !isTerminalIssue(issue)
          && (Number(issue.requester_id) === Number(req.user.id) || participant),
      },
    });
  }));
  
  app.post("/api/issues/:id/accept", auth, requirePermission("issues.accept"), wrap(async (req, res) => {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [[issue]] = await connection.execute(
        "SELECT * FROM issues WHERE id = ? AND company_id = ? FOR UPDATE",
        [req.params.id, req.user.companyId],
      );
      if (!issue) {
        await connection.rollback();
        return res.status(404).json({ message: "ไม่พบ Ticket" });
      }
      if (isTerminalIssue(issue)) {
        await connection.rollback();
        return res.status(409).json({ message: "Ticket นี้ปิดแล้ว" });
      }
      if (issue.assignee_id) {
        await connection.rollback();
        return res.status(409).json({ message: "Ticket นี้มีผู้รับผิดชอบแล้ว" });
      }
      await connection.execute(
        `UPDATE issues
         SET assignee_id = ?, status = 'accepted', board_status = 'todo',
             accepted_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [req.user.id, req.params.id],
      );
      await ensureLinkedIssueTask(
        connection,
        { ...issue, status: "accepted", board_status: "todo", assignee_id: req.user.id },
        req.user.id,
      );
      await addIssueActivity(
        connection,
        req.params.id,
        req.user.id,
        "accepted",
        `${req.user.name} รับเรื่องและเป็นผู้รับผิดชอบหลัก`,
      );
      await connection.commit();
      await notify(issue.requester_id, "มีผู้รับเรื่องแล้ว", `${issue.ticket_no}: ${req.user.name} รับเรื่องแล้ว`, {
        targetUrl: `/issues?issue=${issue.id}`,
        entityType: "issue",
        entityId: issue.id,
        actorName: req.user.name,
      });
      res.json({ message: "รับเรื่องเรียบร้อย" });
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }));
  
  app.post("/api/issues/:id/assign", auth, requirePermission("issues.assign"), wrap(async (req, res) => {
    const assigneeId = Number(req.body.assigneeId);
    if (!Number.isInteger(assigneeId) || assigneeId <= 0) {
      return res.status(400).json({ message: "กรุณาเลือกผู้รับผิดชอบ" });
    }
    const [[assignee]] = await pool.execute(
      `SELECT u.id, u.name
       FROM users u
       JOIN company_memberships cm ON cm.user_id = u.id
       JOIN membership_roles mr ON mr.membership_id = cm.id
       JOIN roles r ON r.id = mr.role_id
       WHERE u.id = ? AND cm.company_id = ? AND cm.status = 'active'
         AND ${STAFF_MEMBERSHIP_SQL}
       LIMIT 1`,
      [assigneeId, req.user.companyId],
    );
    if (!assignee) return res.status(400).json({ message: "ผู้รับผิดชอบต้องเป็น Admin หรือ Developer" });
  
    const connection = await pool.getConnection();
    let issue;
    let previousOwner;
    try {
      await connection.beginTransaction();
      [[issue]] = await connection.execute(
        `SELECT i.*, owner.name assignee_name
         FROM issues i
         LEFT JOIN users owner ON owner.id = i.assignee_id
         WHERE i.id = ? AND i.company_id = ? FOR UPDATE`,
        [req.params.id, req.user.companyId],
      );
      if (!issue) {
        await connection.rollback();
        return res.status(404).json({ message: "ไม่พบ Ticket" });
      }
      if (isTerminalIssue(issue)) {
        await connection.rollback();
        return res.status(409).json({ message: "Ticket นี้ปิดแล้วและแก้ไขไม่ได้" });
      }
      const canAssign = hasPermission(req.user, "issues.manage_all")
        || await isIssueParticipant(req.params.id, req.user.id, connection);
      if (!canAssign) {
        await connection.rollback();
        return res.status(403).json({ message: "คุณไม่ได้อยู่ในทีมของ Ticket นี้" });
      }
      previousOwner = issue.assignee_id;
      if (previousOwner && Number(previousOwner) !== assigneeId) {
        if (req.body.keepPreviousAsMember) {
          await connection.execute(
            `INSERT INTO issue_members (issue_id, user_id, added_by)
             VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE added_by = VALUES(added_by)`,
            [req.params.id, previousOwner, req.user.id],
          );
        } else {
          await connection.execute(
            "DELETE FROM issue_members WHERE issue_id = ? AND user_id = ?",
            [req.params.id, previousOwner],
          );
        }
      }
      await connection.execute(
        "DELETE FROM issue_members WHERE issue_id = ? AND user_id = ?",
        [req.params.id, assigneeId],
      );
      await connection.execute(
        `UPDATE issues
         SET assignee_id = ?,
             status = IF(status = 'open', 'accepted', status),
             board_status = COALESCE(
               board_status,
               IF(status = 'in_progress', 'doing', IF(status = 'closed', 'done', 'todo'))
             ),
             accepted_at = COALESCE(accepted_at, CURRENT_TIMESTAMP)
         WHERE id = ?`,
        [assigneeId, req.params.id],
      );
      await ensureLinkedIssueTask(
        connection,
        {
          ...issue,
          assignee_id: assigneeId,
          status: issue.status === "open" ? "accepted" : issue.status,
          board_status: issue.status === "open" ? "todo" : (issue.board_status || "todo"),
        },
        assigneeId,
      );
      const description = previousOwner
        ? `เปลี่ยนผู้รับผิดชอบจาก ${issue.assignee_name} เป็น ${assignee.name}`
        : `มอบหมายให้ ${assignee.name} เป็นผู้รับผิดชอบหลัก`;
      await addIssueActivity(connection, req.params.id, req.user.id, "assigned", description);
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  
    await Promise.all([
      notify(assigneeId, "ได้รับมอบหมาย Ticket", `${issue.ticket_no}: ${issue.title}`, {
        targetUrl: `/issues?issue=${issue.id}`,
        entityType: "issue",
        entityId: issue.id,
        actorName: req.user.name,
      }),
      previousOwner && Number(previousOwner) !== assigneeId
        ? notify(previousOwner, "มีการเปลี่ยนผู้รับผิดชอบ", `${issue.ticket_no} ถูกมอบหมายให้ ${assignee.name}`, {
          targetUrl: `/issues?issue=${issue.id}`,
          entityType: "issue",
          entityId: issue.id,
          actorName: req.user.name,
        })
        : null,
      notify(issue.requester_id, "เปลี่ยนผู้รับผิดชอบ Ticket", `${issue.ticket_no}: ${assignee.name} เป็นผู้ดูแล`, {
        targetUrl: `/issues?issue=${issue.id}`,
        entityType: "issue",
        entityId: issue.id,
        actorName: req.user.name,
      }),
    ]);
    res.json({ message: "มอบหมายผู้รับผิดชอบแล้ว" });
  }));
  
  app.post("/api/issues/:id/convert-to-project", auth, requirePermission("projects.create", "issues.transition"), wrap(async (req, res) => {
    const issue = await getIssueById(req.params.id, req.user.companyId);
    if (!issue) return res.status(404).json({ message: "ไม่พบ Ticket" });
    if (isTerminalIssue(issue)) {
      return res.status(409).json({ message: "Ticket นี้ปิดแล้วและแปลงเป็นโครงการไม่ได้" });
    }
    if (issue.project_id) {
      return res.status(409).json({ message: "Ticket นี้เชื่อมกับโครงการแล้ว" });
    }
    const participant = await isIssueParticipant(req.params.id, req.user.id);
    const canConvert = participant && (
      hasPermission(req.user, "projects.create")
      || (
        hasPermission(req.user, "issues.transition")
        && Number(issue.assignee_id) === Number(req.user.id)
      )
    );
    if (!canConvert) {
      return res.status(403).json({ message: "เฉพาะผู้รับผิดชอบ Ticket หรือผู้มีสิทธิ์สร้างโครงการเท่านั้น" });
    }
  
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
    if (!name?.trim() || !code?.trim()) {
      return res.status(400).json({ message: "กรุณาระบุชื่อและรหัสโครงการ" });
    }
    const owner = Number(ownerId || issue.assignee_id || req.user.id);
    if (!Number.isInteger(owner) || owner <= 0) {
      return res.status(400).json({ message: "ownerId ไม่ถูกต้อง" });
    }
    const [issueMemberRows] = await pool.execute(
      "SELECT user_id FROM issue_members WHERE issue_id = ?",
      [issue.id],
    );
    const extraMembers = uniquePositiveIds([
      ...(memberIds || []),
      ...issueMemberRows.map((member) => member.user_id),
      issue.requester_id,
    ]).filter((id) => id !== owner && id !== req.user.id);
    const allUserIds = uniquePositiveIds([owner, req.user.id, ...extraMembers]);
    if (!(await usersExist(allUserIds, req.user.companyId))) {
      return res.status(400).json({ message: "พบผู้ใช้ที่ไม่ถูกต้องในสมาชิกโครงการ" });
    }
  
    const connection = await pool.getConnection();
    let projectId;
    try {
      await connection.beginTransaction();
      const [result] = await connection.execute(
        `INSERT INTO projects
          (company_id, name, code, description, prd, status, start_date, end_date,
           owner_id, approved_by, created_by, budget, currency)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          req.user.companyId,
          name.trim(),
          code.trim().toUpperCase(),
          description || issue.description || null,
          prd || issue.description || null,
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
      await ensureProjectMember(connection, projectId, req.user.id, "Creator");
      await ensureProjectMember(
        connection,
        projectId,
        owner,
        owner === req.user.id ? "Creator / Owner" : "Project owner",
      );
      for (const memberId of extraMembers) {
        await ensureProjectMember(
          connection,
          projectId,
          memberId,
          Number(memberId) === Number(issue.requester_id) ? "ผู้เสนอ / ผู้เกี่ยวข้อง" : null,
        );
      }
      const nextStatus = issue.status === "open" ? "accepted" : issue.status;
      const nextBoardStatus = issue.status === "open" ? "todo" : (issue.board_status || "todo");
      const estimatedFromProject = endDate ? `${endDate} 23:59:59` : null;
      await connection.execute(
        `UPDATE issues
         SET project_id = ?, assignee_id = ?, status = ?, board_status = ?,
             accepted_at = COALESCE(accepted_at, CURRENT_TIMESTAMP),
             estimated_completion_at = COALESCE(?, estimated_completion_at)
         WHERE id = ?`,
        [projectId, owner, nextStatus, nextBoardStatus, estimatedFromProject, issue.id],
      );
      // Staff selected for the project become Ticket members (exclude Owner)
      const staffMemberIds = [];
      if ((memberIds || []).length) {
        const placeholders = uniquePositiveIds(memberIds).map(() => "?").join(",");
        if (placeholders) {
          const [staffRows] = await connection.execute(
            `SELECT DISTINCT u.id, u.name
             FROM users u
             JOIN company_memberships cm ON cm.user_id = u.id
             JOIN membership_roles mr ON mr.membership_id = cm.id
             JOIN roles r ON r.id = mr.role_id
             WHERE u.id IN (${placeholders})
               AND cm.company_id = ? AND cm.status = 'active'
               AND ${STAFF_MEMBERSHIP_SQL}
               AND u.id <> ?`,
            [...uniquePositiveIds(memberIds), req.user.companyId, owner],
          );
          for (const row of staffRows) {
            await ensureIssueMember(connection, issue.id, row.id, req.user.id);
            staffMemberIds.push(row.name);
          }
        }
      }
      // Also sync any existing issue members + other project staff into consistency
      const convertedIssue = {
        ...issue,
        project_id: projectId,
        assignee_id: owner,
        status: nextStatus,
        board_status: nextBoardStatus,
        estimated_completion_at: estimatedFromProject || issue.estimated_completion_at,
        project_start_date: startDate || null,
        project_end_date: endDate || null,
      };
      await syncIssueMembersFromProject(connection, convertedIssue, req.user.id);
      await ensureLinkedIssueTask(connection, convertedIssue, owner);
      await addIssueActivity(
        connection,
        issue.id,
        req.user.id,
        "converted_to_project",
        `สร้างเป็นโครงการ ${name.trim()} (${code.trim().toUpperCase()})`,
      );
      if (estimatedFromProject) {
        await addIssueActivity(
          connection,
          issue.id,
          req.user.id,
          "updated",
          `กำหนดคาดว่าจะเสร็จตามวันสิ้นสุดโครงการ: ${endDate}`,
        );
      }
      if (staffMemberIds.length) {
        await addIssueActivity(
          connection,
          issue.id,
          req.user.id,
          "members_updated",
          `เพิ่มสมาชิกจากโครงการ: ${staffMemberIds.join(", ")}`,
        );
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
    await notifyIssueRecipients(
      issue.id,
      req.user.id,
      "Ticket ถูกสร้างเป็นโครงการแล้ว",
      `${issue.ticket_no}: ${name.trim()}`,
    );
    res.status(201).json({
      id: projectId,
      projectId,
      message: "สร้างโครงการจาก Ticket เรียบร้อย",
    });
  }));
  
  app.put("/api/issues/:id/members", auth, requirePermission("issues.members.manage"), wrap(async (req, res) => {
    const issue = await getIssueById(req.params.id, req.user.companyId);
    if (!issue) return res.status(404).json({ message: "ไม่พบ Ticket" });
    if (isTerminalIssue(issue)) {
      return res.status(409).json({ message: "Ticket นี้ปิดแล้วและแก้ไขไม่ได้" });
    }
    const canManage = hasPermission(req.user, "issues.manage_all")
      || await isIssueParticipant(req.params.id, req.user.id);
    if (!canManage) return res.status(403).json({ message: "คุณไม่ได้อยู่ในทีมของ Ticket นี้" });
  
    const memberIds = [...new Set(
      (req.body.memberIds || [])
        .map(Number)
        .filter((id) => Number.isInteger(id) && id > 0 && id !== Number(issue.assignee_id)),
    )];
    if (memberIds.length) {
      const placeholders = memberIds.map(() => "?").join(",");
      const [validMembers] = await pool.execute(
        `SELECT DISTINCT u.id, u.name
         FROM users u
         JOIN company_memberships cm ON cm.user_id = u.id
         JOIN membership_roles mr ON mr.membership_id = cm.id
         JOIN roles r ON r.id = mr.role_id
         WHERE u.id IN (${placeholders}) AND cm.company_id = ? AND cm.status = 'active'
           AND ${STAFF_MEMBERSHIP_SQL}`,
        [...memberIds, req.user.companyId],
      );
      if (validMembers.length !== memberIds.length) {
        return res.status(400).json({ message: "สมาชิกต้องเป็น Admin หรือ Developer เท่านั้น" });
      }
    }
  
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [oldRows] = await connection.execute(
        "SELECT user_id FROM issue_members WHERE issue_id = ?",
        [req.params.id],
      );
      const oldIds = oldRows.map((row) => Number(row.user_id));
      await connection.execute("DELETE FROM issue_members WHERE issue_id = ?", [req.params.id]);
      for (const memberId of memberIds) {
        await connection.execute(
          "INSERT INTO issue_members (issue_id, user_id, added_by) VALUES (?, ?, ?)",
          [req.params.id, memberId, req.user.id],
        );
        if (issue.project_id) {
          await ensureProjectMember(connection, issue.project_id, memberId, "ร่วมดูแล Ticket");
        }
      }
      const [names] = memberIds.length
        ? await connection.execute(
          `SELECT name FROM users WHERE id IN (${memberIds.map(() => "?").join(",")}) ORDER BY name`,
          memberIds,
        )
        : [[]];
      const description = names.length
        ? `อัปเดตสมาชิกทีม: ${names.map((member) => member.name).join(", ")}`
        : "นำสมาชิกทั้งหมดออกจากทีม";
      await addIssueActivity(connection, req.params.id, req.user.id, "members_updated", description);
      await connection.commit();
      const addedIds = memberIds.filter((id) => !oldIds.includes(id));
      await Promise.all(addedIds.map((id) =>
        notify(id, "ถูกเพิ่มเข้าร่วม Ticket", `${issue.ticket_no}: ${issue.title}`, {
          targetUrl: `/issues?issue=${issue.id}`,
          entityType: "issue",
          entityId: issue.id,
          actorName: req.user.name,
        }),
      ));
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
    await notify(issue.requester_id, "ทีมดูแล Ticket มีการเปลี่ยนแปลง", issue.ticket_no, {
      targetUrl: `/issues?issue=${issue.id}`,
      entityType: "issue",
      entityId: issue.id,
      actorName: req.user.name,
    });
    res.json({ message: "อัปเดตสมาชิกแล้ว" });
  }));
  
  app.patch("/api/issues/:id", auth, requirePermission("issues.update"), wrap(async (req, res) => {
    const requesterView = isRequesterPersona(req.user);
    const connection = await pool.getConnection();
    let issue;
    let activities = [];
    try {
      await connection.beginTransaction();
      [[issue]] = await connection.execute(
        "SELECT * FROM issues WHERE id = ? AND company_id = ? FOR UPDATE",
        [req.params.id, req.user.companyId],
      );
      if (!issue) {
        await connection.rollback();
        return res.status(404).json({ message: "ไม่พบ Ticket" });
      }
      if (isTerminalIssue(issue)) {
        await connection.rollback();
        return res.status(409).json({ message: "Ticket นี้สิ้นสุดแล้วและแก้ไขไม่ได้" });
      }

      if (requesterView) {
        if (Number(issue.requester_id) !== Number(req.user.id)) {
          await connection.rollback();
          return res.status(403).json({ message: "คุณแก้ไขได้เฉพาะคำขอของตนเอง" });
        }
        if (issue.status !== "open" || issue.assignee_id) {
          await connection.rollback();
          return res.status(409).json({ message: "คำขอนี้มีผู้รับเรื่องแล้ว จึงแก้ไขไม่ได้" });
        }

        const title = String(req.body.title || "").trim().slice(0, 220);
        const description = String(req.body.description || "").trim();
        const type = req.body.type;
        if (!title || !description || !["bug", "feature", "support"].includes(type)) {
          await connection.rollback();
          return res.status(400).json({ message: "ข้อมูลคำขอไม่ครบถ้วน" });
        }

        let projectId = null;
        if (req.body.projectId !== undefined
            && req.body.projectId !== null
            && req.body.projectId !== "") {
          projectId = Number(req.body.projectId);
          let project = null;
          if (Number.isInteger(projectId) && projectId > 0) {
            [[project]] = await connection.execute(
              `SELECT id FROM projects
               WHERE id = ? AND company_id = ? AND status = 'active'`,
              [projectId, req.user.companyId],
            );
          }
          if (!project) {
            await connection.rollback();
            return res.status(400).json({ message: "โครงการไม่ถูกต้องหรืออยู่นอกบริษัท" });
          }
        }
        const systemComponent = String(req.body.systemComponent || "").trim().slice(0, 160) || null;
        await connection.execute(
          `UPDATE issues
           SET title = ?, description = ?, type = ?, project_id = ?, system_component = ?
           WHERE id = ?`,
          [title, description, type, projectId, systemComponent, issue.id],
        );
        activities = ["ผู้แจ้งแก้ไขรายละเอียดคำขอ"];
      } else {
        const participant = hasPermission(req.user, "issues.manage_all")
          || await isIssueParticipant(req.params.id, req.user.id, connection);
        if (!participant) {
          await connection.rollback();
          return res.status(403).json({ message: "คุณไม่ได้อยู่ในทีมของ Ticket นี้" });
        }
        const fields = [];
        const values = [];
        if (req.body.estimatedCompletionAt !== undefined) {
          fields.push("estimated_completion_at = ?");
          values.push(req.body.estimatedCompletionAt || null);
          activities.push(req.body.estimatedCompletionAt
            ? `กำหนดเวลาคาดว่าจะเสร็จเป็น ${req.body.estimatedCompletionAt}`
            : "ยกเลิกเวลาคาดว่าจะเสร็จ");
        }
        if (req.body.priority && ["low", "medium", "high", "urgent"].includes(req.body.priority)) {
          fields.push("priority = ?");
          values.push(req.body.priority);
          activities.push("เปลี่ยนระดับความสำคัญ");
        }
        if (!fields.length) {
          await connection.rollback();
          return res.status(400).json({ message: "ไม่มีข้อมูลให้อัปเดต" });
        }
        await connection.execute(
          `UPDATE issues SET ${fields.join(", ")} WHERE id = ?`,
          [...values, issue.id],
        );
      }

      for (const activity of activities) {
        await addIssueActivity(connection, issue.id, req.user.id, "updated", activity);
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
    if (!requesterView) {
      await notifyIssueRecipients(
        req.params.id,
        req.user.id,
        "Ticket มีการอัปเดต",
        `${issue.ticket_no}: ${activities.join(", ")}`,
      );
    }
    res.json({ message: "อัปเดต Ticket แล้ว" });
  }));

  app.post("/api/issues/:id/cancel", auth, requirePermission("issues.update"), wrap(async (req, res) => {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [[issue]] = await connection.execute(
        "SELECT * FROM issues WHERE id = ? AND company_id = ? FOR UPDATE",
        [req.params.id, req.user.companyId],
      );
      if (!issue) {
        await connection.rollback();
        return res.status(404).json({ message: "ไม่พบ Ticket" });
      }
      if (Number(issue.requester_id) !== Number(req.user.id)) {
        await connection.rollback();
        return res.status(403).json({ message: "คุณยกเลิกได้เฉพาะคำขอของตนเอง" });
      }
      if (issue.status !== "open" || issue.assignee_id) {
        await connection.rollback();
        return res.status(409).json({ message: "คำขอนี้มีผู้รับเรื่องแล้ว จึงยกเลิกไม่ได้" });
      }
      await connection.execute(
        `UPDATE issues
         SET status = 'cancelled', cancelled_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [issue.id],
      );
      await addIssueActivity(
        connection,
        issue.id,
        req.user.id,
        "cancelled",
        "ผู้แจ้งยกเลิกคำขอ",
      );
      await connection.commit();
      res.json({ message: "ยกเลิกคำขอเรียบร้อย" });
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }));

  app.post("/api/issues/:id/reject", auth, requirePermission("issues.accept"), wrap(async (req, res) => {
    const reason = String(req.body.reason || "").trim();
    if (!reason) return res.status(400).json({ message: "กรุณาระบุเหตุผลที่ Reject" });
    if (reason.length > 1000) {
      return res.status(400).json({ message: "เหตุผลต้องไม่เกิน 1,000 ตัวอักษร" });
    }
    if (!canRejectIssues(req.user)) {
      return res.status(403).json({ message: "เฉพาะ Developer, PM หรือ Admin เท่านั้นที่ Reject ได้" });
    }

    const connection = await pool.getConnection();
    let issue;
    try {
      await connection.beginTransaction();
      [[issue]] = await connection.execute(
        "SELECT * FROM issues WHERE id = ? AND company_id = ? FOR UPDATE",
        [req.params.id, req.user.companyId],
      );
      if (!issue) {
        await connection.rollback();
        return res.status(404).json({ message: "ไม่พบ Ticket" });
      }
      if (issue.status !== "open" || issue.assignee_id) {
        await connection.rollback();
        return res.status(409).json({ message: "Reject ได้เฉพาะคำขอที่ยังไม่มีผู้รับเรื่อง" });
      }
      await connection.execute(
        `UPDATE issues
         SET status = 'rejected', rejection_reason = ?, rejected_by = ?,
             rejected_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [reason, req.user.id, issue.id],
      );
      await addIssueActivity(
        connection,
        issue.id,
        req.user.id,
        "rejected",
        `Reject คำขอ: ${reason}`.slice(0, 500),
      );
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
    await notify(issue.requester_id, "คำขอถูก Reject", `${issue.ticket_no}: ${reason}`, {
      targetUrl: `/issues?issue=${issue.id}`,
      entityType: "issue",
      entityId: issue.id,
      actorName: req.user.name,
    });
    res.json({ message: "Reject คำขอเรียบร้อย" });
  }));
  
  app.post("/api/issues/:id/board-status", auth, requirePermission("issues.transition"), wrap(async (req, res) => {
    const boardStatus = req.body.boardStatus;
    if (!["todo", "doing", "review", "done"].includes(boardStatus)) {
      return res.status(400).json({ message: "สถานะบนกระดานไม่ถูกต้อง" });
    }
    const issue = await getIssueById(req.params.id, req.user.companyId);
    if (!issue) return res.status(404).json({ message: "ไม่พบ Ticket" });
    if (isTerminalIssue(issue)) {
      return res.status(409).json({ message: "Ticket นี้ปิดแล้วและย้ายไม่ได้" });
    }
    const participant = hasPermission(req.user, "issues.manage_all")
      || await isIssueParticipant(req.params.id, req.user.id);
    if (!participant) return res.status(403).json({ message: "คุณไม่ได้อยู่ในทีมของ Ticket นี้" });
    if (!issue.assignee_id) return res.status(409).json({ message: "ต้องมีผู้รับผิดชอบก่อนย้ายงาน" });
  
    const next = issueStateForTaskStatus(boardStatus);
    const labels = {
      todo: "สิ่งที่ต้องทำ",
      doing: "กำลังทำ",
      review: "ตรวจสอบ",
      done: "เสร็จแล้ว",
    };
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute(
        `UPDATE issues
         SET status = ?,
             board_status = ?,
             started_at = IF(? IN ('doing', 'review'), COALESCE(started_at, CURRENT_TIMESTAMP), started_at),
             completed_at = IF(? = 'done', CURRENT_TIMESTAMP, completed_at)
         WHERE id = ?`,
        [next.status, next.boardStatus, boardStatus, boardStatus, req.params.id],
      );
      await syncSingleLinkedTask(connection, {
        ...issue,
        status: next.status,
        board_status: next.boardStatus,
      });
      await addIssueActivity(
        connection,
        req.params.id,
        req.user.id,
        boardStatus === "done" ? "completed" : "board_moved",
        `${req.user.name} ย้ายงานไป "${labels[boardStatus]}"`,
      );
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
    await notifyIssueRecipients(
      req.params.id,
      req.user.id,
      boardStatus === "done" ? "Ticket เสร็จสิ้นแล้ว" : "Ticket มีการเปลี่ยนสถานะ",
      `${issue.ticket_no}: ${labels[boardStatus]}`,
    );
    res.json({ message: boardStatus === "done" ? "ปิด Ticket เรียบร้อย" : "ย้าย Ticket แล้ว" });
  }));
  
  app.post("/api/issues/:id/workflow", auth, requirePermission("issues.transition"), wrap(async (req, res) => {
    if (!["in_progress", "closed"].includes(req.body.status)) {
      return res.status(400).json({ message: "สถานะไม่ถูกต้อง" });
    }
    const issue = await getIssueById(req.params.id, req.user.companyId);
    if (!issue) return res.status(404).json({ message: "ไม่พบ Ticket" });
    if (isTerminalIssue(issue)) {
      return res.status(409).json({ message: "Ticket นี้ปิดแล้วและแก้ไขไม่ได้" });
    }
    const participant = hasPermission(req.user, "issues.manage_all")
      || await isIssueParticipant(req.params.id, req.user.id);
    if (!participant) return res.status(403).json({ message: "คุณไม่ได้อยู่ในทีมของ Ticket นี้" });
    if (!issue.assignee_id) return res.status(409).json({ message: "ต้องมีผู้รับผิดชอบก่อนเริ่มงาน" });
    if (req.body.status === "in_progress" && issue.status !== "accepted") {
      return res.status(409).json({ message: "เริ่มงานได้หลังจากรับเรื่องแล้วเท่านั้น" });
    }
    if (req.body.status === "closed" && !["accepted", "in_progress"].includes(issue.status)) {
      return res.status(409).json({ message: "ไม่สามารถปิด Ticket จากสถานะปัจจุบันได้" });
    }
  
    const isStarting = req.body.status === "in_progress";
    const description = isStarting
      ? `${req.user.name} เริ่มดำเนินการ`
      : `${req.user.name} เสร็จสิ้นและปิด Ticket`;
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute(
        `UPDATE issues
         SET status = ?,
             board_status = IF(? = 'closed', 'done', 'doing'),
             started_at = IF(? = 'in_progress', COALESCE(started_at, CURRENT_TIMESTAMP), started_at),
             completed_at = IF(? = 'closed', CURRENT_TIMESTAMP, completed_at)
         WHERE id = ?`,
        [req.body.status, req.body.status, req.body.status, req.body.status, req.params.id],
      );
      await syncSingleLinkedTask(connection, {
        ...issue,
        status: req.body.status,
        board_status: req.body.status === "closed" ? "done" : "doing",
      });
      await addIssueActivity(
        connection,
        req.params.id,
        req.user.id,
        isStarting ? "started" : "completed",
        description,
      );
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
    await notifyIssueRecipients(
      req.params.id,
      req.user.id,
      isStarting ? "เริ่มดำเนินการแล้ว" : "Ticket เสร็จสิ้นแล้ว",
      `${issue.ticket_no}: ${issue.title}`,
    );
    res.json({ message: isStarting ? "เริ่มดำเนินการแล้ว" : "ปิด Ticket เรียบร้อย" });
  }));
  
  app.get("/api/issues/:id/attachments", auth, wrap(async (req, res) => {
    const issue = await getIssueById(req.params.id, req.user.companyId);
    if (!issue) return res.status(404).json({ message: "ไม่พบ Ticket" });
    if (!(await canViewIssue(req.user, issue))) {
      return res.status(403).json({ message: "คุณไม่มีสิทธิ์ดูไฟล์ของ Ticket นี้" });
    }
    const [rows] = await pool.execute(
      `SELECT id, issue_id, uploaded_by, original_name, mime_type, size_bytes, created_at
       FROM issue_attachments
       WHERE issue_id = ? AND company_id = ? AND comment_id IS NULL
       ORDER BY created_at, id`,
      [issue.id, req.user.companyId],
    );
    res.json(rows);
  }));

  app.post(
    "/api/issues/:id/attachments",
    auth,
    upload.array("files", config.attachments.maxFiles),
    wrap(async (req, res) => {
      const issue = await getIssueById(req.params.id, req.user.companyId);
      if (!issue) return res.status(404).json({ message: "ไม่พบ Ticket" });
      if (!(await canViewIssue(req.user, issue))
          || !(await canMutateAttachments(req.user, issue))) {
        return res.status(403).json({ message: "คุณไม่มีสิทธิ์แนบไฟล์ใน Ticket นี้" });
      }
      const files = req.files || [];
      if (!files.length) return res.status(400).json({ message: "กรุณาเลือกไฟล์" });
      if (files.some((file) => !validAttachment(file))) {
        return res.status(415).json({
          message: "รองรับเฉพาะ JPG, PNG, GIF, WebP, PDF และ TXT ที่ชนิดไฟล์ตรงกับนามสกุล",
        });
      }
      const [[{ total }]] = await pool.execute(
        "SELECT COUNT(*) total FROM issue_attachments WHERE issue_id = ? AND comment_id IS NULL",
        [issue.id],
      );
      if (Number(total) + files.length > config.attachments.maxFiles) {
        return res.status(413).json({
          message: `แนบไฟล์ได้ไม่เกิน ${config.attachments.maxFiles} ไฟล์ต่อ Ticket`,
        });
      }

      await mkdir(issueAttachmentRoot, { recursive: true });
      const stored = [];
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const [[lockedIssue]] = await connection.execute(
          `SELECT id, status, requester_id, assignee_id
           FROM issues WHERE id = ? AND company_id = ? FOR UPDATE`,
          [issue.id, req.user.companyId],
        );
        const requesterUpload = Number(lockedIssue?.requester_id) === Number(req.user.id);
        if (!lockedIssue
            || isTerminalIssue(lockedIssue)
            || (requesterUpload && (lockedIssue.status !== "open" || lockedIssue.assignee_id))) {
          await connection.rollback();
          return res.status(409).json({ message: "คำขอนี้ไม่อนุญาตให้แก้ไขไฟล์แนบแล้ว" });
        }
        const [[{ locked_total: lockedTotal }]] = await connection.execute(
          "SELECT COUNT(*) locked_total FROM issue_attachments WHERE issue_id = ? AND comment_id IS NULL",
          [issue.id],
        );
        if (Number(lockedTotal) + files.length > config.attachments.maxFiles) {
          await connection.rollback();
          return res.status(413).json({
            message: `แนบไฟล์ได้ไม่เกิน ${config.attachments.maxFiles} ไฟล์ต่อ Ticket`,
          });
        }
        for (const file of files) {
          const storageName = randomBytes(24).toString("hex");
          const target = storagePath(issueAttachmentRoot, storageName);
          await writeFile(target, file.buffer, { flag: "wx", mode: 0o600 });
          stored.push(target);
          await connection.execute(
            `INSERT INTO issue_attachments
              (issue_id, company_id, uploaded_by, storage_name, original_name, mime_type, size_bytes)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
              issue.id,
              req.user.companyId,
              req.user.id,
              storageName,
              safeDisplayName(file.originalname),
              file.mimetype,
              file.size,
            ],
          );
        }
        await connection.commit();
      } catch (error) {
        await connection.rollback();
        await Promise.all(stored.map((target) => unlink(target).catch(() => {})));
        throw error;
      } finally {
        connection.release();
      }
      res.status(201).json({ message: "อัปโหลดไฟล์แล้ว", count: files.length });
    }),
  );

  app.get("/api/issues/:id/attachments/:attachmentId/download", auth, wrap(async (req, res) => {
    const issue = await getIssueById(req.params.id, req.user.companyId);
    if (!issue) return res.status(404).json({ message: "ไม่พบ Ticket" });
    if (!(await canViewIssue(req.user, issue))) {
      return res.status(403).json({ message: "คุณไม่มีสิทธิ์ดาวน์โหลดไฟล์นี้" });
    }
    const [[attachment]] = await pool.execute(
      `SELECT storage_name, original_name, mime_type
       FROM issue_attachments
       WHERE id = ? AND issue_id = ? AND company_id = ?`,
      [req.params.attachmentId, issue.id, req.user.companyId],
    );
    if (!attachment) return res.status(404).json({ message: "ไม่พบไฟล์" });
    res.setHeader("Content-Type", attachment.mime_type);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(attachment.original_name)}`,
    );
    createReadStream(storagePath(issueAttachmentRoot, attachment.storage_name))
      .on("error", () => {
        if (!res.headersSent) res.status(404).json({ message: "ไม่พบไฟล์ใน storage" });
        else res.destroy();
      })
      .pipe(res);
  }));

  app.get("/api/issues/:id/attachments/:attachmentId/inline", auth, wrap(async (req, res) => {
    const issue = await getIssueById(req.params.id, req.user.companyId);
    if (!issue) return res.status(404).json({ message: "ไม่พบ Ticket" });
    if (!(await canViewIssue(req.user, issue))) {
      return res.status(403).json({ message: "คุณไม่มีสิทธิ์ดูไฟล์นี้" });
    }
    const [[attachment]] = await pool.execute(
      `SELECT storage_name, original_name, mime_type
       FROM issue_attachments
       WHERE id = ? AND issue_id = ? AND company_id = ?`,
      [req.params.attachmentId, issue.id, req.user.companyId],
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
    createReadStream(storagePath(issueAttachmentRoot, attachment.storage_name))
      .on("error", () => {
        if (!res.headersSent) res.status(404).json({ message: "ไม่พบไฟล์ใน storage" });
        else res.destroy();
      })
      .pipe(res);
  }));

  app.delete("/api/issues/:id/attachments/:attachmentId", auth, wrap(async (req, res) => {
    const issue = await getIssueById(req.params.id, req.user.companyId);
    if (!issue) return res.status(404).json({ message: "ไม่พบ Ticket" });
    if (!(await canViewIssue(req.user, issue))
        || !(await canMutateAttachments(req.user, issue))) {
      return res.status(403).json({ message: "คุณไม่มีสิทธิ์ลบไฟล์นี้" });
    }
    const [[attachment]] = await pool.execute(
      `SELECT id, storage_name FROM issue_attachments
       WHERE id = ? AND issue_id = ? AND company_id = ? AND comment_id IS NULL`,
      [req.params.attachmentId, issue.id, req.user.companyId],
    );
    if (!attachment) return res.status(404).json({ message: "ไม่พบไฟล์" });
    await pool.execute("DELETE FROM issue_attachments WHERE id = ?", [attachment.id]);
    await unlink(storagePath(issueAttachmentRoot, attachment.storage_name)).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    res.json({ message: "ลบไฟล์แล้ว" });
  }));

  app.get("/api/issues/:id/comments", auth, wrap(async (req, res) => {
    const issue = await getIssueById(req.params.id, req.user.companyId);
    if (!issue) return res.status(404).json({ message: "ไม่พบ Ticket" });
    if (!(await canViewIssue(req.user, issue))) {
      return res.status(403).json({ message: "คุณไม่มีสิทธิ์ดู Ticket นี้" });
    }
    const pagination = parsePagination(req, { defaultLimit: 200, maxLimit: 500 });
    const [[{ total }]] = await pool.execute(
      "SELECT COUNT(*) total FROM comments WHERE issue_id = ?",
      [req.params.id],
    );
    const [rows] = await pool.execute(
      `SELECT c.id, c.issue_id, c.user_id, c.reply_to_id, c.body, c.created_at,
              u.name user_name, u.role user_role,
              parent.id reply_id, parent.user_id reply_user_id,
              parent_user.name reply_user_name, LEFT(parent.body, 280) reply_body,
              EXISTS (
                SELECT 1 FROM issue_attachments reply_attachment
                WHERE reply_attachment.comment_id = parent.id
                  AND reply_attachment.issue_id = c.issue_id
                  AND reply_attachment.company_id = ?
              ) reply_has_attachments
       FROM comments c
       JOIN users u ON u.id = c.user_id
       LEFT JOIN comments parent
         ON parent.id = c.reply_to_id AND parent.issue_id = c.issue_id
       LEFT JOIN users parent_user ON parent_user.id = parent.user_id
       WHERE c.issue_id = ?
       ORDER BY c.created_at DESC, c.id DESC
       LIMIT ${pagination.limit} OFFSET ${pagination.offset}`,
      [req.user.companyId, req.params.id],
    );
    const commentIds = rows.map((row) => Number(row.id));
    let attachmentRows = [];
    if (commentIds.length) {
      const placeholders = commentIds.map(() => "?").join(",");
      [attachmentRows] = await pool.execute(
        `SELECT id, issue_id, comment_id, uploaded_by, original_name, mime_type,
                size_bytes, created_at
         FROM issue_attachments
         WHERE issue_id = ? AND company_id = ?
           AND comment_id IN (${placeholders})
         ORDER BY created_at, id`,
        [issue.id, req.user.companyId, ...commentIds],
      );
    }
    const attachmentsByComment = new Map();
    for (const attachment of attachmentRows) {
      const key = Number(attachment.comment_id);
      const current = attachmentsByComment.get(key) || [];
      current.push(attachment);
      attachmentsByComment.set(key, current);
    }
    const comments = rows.reverse().map((row) => ({
      id: row.id,
      issue_id: row.issue_id,
      user_id: row.user_id,
      user_name: row.user_name,
      user_role: row.user_role,
      reply_to_id: row.reply_to_id,
      reply_preview: replyPreview(row),
      body: row.body,
      created_at: row.created_at,
      attachments: attachmentsByComment.get(Number(row.id)) || [],
    }));
    paginatedJson(res, comments, total, pagination);
  }));
  
  app.post("/api/issues/:id/comments",
    auth,
    requirePermission("issues.comment"),
    upload.array("files", config.attachments.maxFiles),
    wrap(async (req, res) => {
      const files = req.files || [];
      const commentBody = String(req.body?.body || "").trim();
      const replyToId = optionalReplyId(req.body?.replyToId);
      if (Number.isNaN(replyToId)) {
        return res.status(400).json({ message: "replyToId ต้องเป็นจำนวนเต็มบวก" });
      }
      if (!commentBody && !files.length) {
        return res.status(400).json({ message: "กรุณากรอกข้อความหรือแนบไฟล์" });
      }
      if (files.some((file) => !validAttachment(file))) {
        return res.status(415).json({
          message: "รองรับเฉพาะ JPG, PNG, GIF, WebP, PDF และ TXT ที่ชนิดไฟล์ตรงกับนามสกุล",
        });
      }
      const issue = await getIssueById(req.params.id, req.user.companyId);
      if (!issue) return res.status(404).json({ message: "ไม่พบ Ticket" });
      if (isTerminalIssue(issue)) {
        return res.status(409).json({ message: "Ticket นี้ปิดแล้ว แชทเป็นแบบอ่านอย่างเดียว" });
      }
      const participant = hasPermission(req.user, "issues.manage_all")
        || await isIssueParticipant(req.params.id, req.user.id);
      const isRequester = Number(issue.requester_id) === Number(req.user.id);
      if (!participant && !isRequester) {
        return res.status(403).json({ message: "คุณไม่ได้อยู่ใน Ticket นี้" });
      }

      let parentPreview = null;
      if (replyToId) {
        const [[parent]] = await pool.execute(
          `SELECT parent.id reply_id, parent.user_id reply_user_id,
                  parent_user.name reply_user_name,
                  LEFT(parent.body, 280) reply_body,
                  EXISTS (
                    SELECT 1 FROM issue_attachments reply_attachment
                    WHERE reply_attachment.comment_id = parent.id
                      AND reply_attachment.issue_id = parent.issue_id
                      AND reply_attachment.company_id = ?
                  ) reply_has_attachments
           FROM comments parent
           JOIN issues parent_issue
             ON parent_issue.id = parent.issue_id AND parent_issue.company_id = ?
           JOIN users parent_user ON parent_user.id = parent.user_id
           WHERE parent.id = ? AND parent.issue_id = ?`,
          [req.user.companyId, req.user.companyId, replyToId, issue.id],
        );
        if (!parent) {
          return res.status(404).json({
            message: "ไม่พบข้อความต้นทางในบทสนทนา Ticket นี้",
          });
        }
        parentPreview = replyPreview(parent);
      }

      if (files.length) await mkdir(issueAttachmentRoot, { recursive: true });
      const stored = [];
      const attachments = [];
      const connection = await pool.getConnection();
      let commentId;
      try {
        await connection.beginTransaction();
        const [[lockedIssue]] = await connection.execute(
          "SELECT id FROM issues WHERE id = ? AND company_id = ? FOR UPDATE",
          [issue.id, req.user.companyId],
        );
        if (!lockedIssue) throw Object.assign(new Error("issue tenant changed"), { code: "ISSUE_NOT_FOUND" });
        const [result] = await connection.execute(
          `INSERT INTO comments (issue_id, user_id, reply_to_id, body)
           VALUES (?, ?, ?, ?)`,
          [issue.id, req.user.id, replyToId, commentBody],
        );
        commentId = result.insertId;
        for (const file of files) {
          const storageName = randomBytes(24).toString("hex");
          const target = storagePath(issueAttachmentRoot, storageName);
          await writeFile(target, file.buffer, { flag: "wx", mode: 0o600 });
          stored.push(target);
          const originalName = safeDisplayName(file.originalname);
          const [attachmentResult] = await connection.execute(
            `INSERT INTO issue_attachments
              (issue_id, comment_id, company_id, uploaded_by, storage_name,
               original_name, mime_type, size_bytes)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              issue.id,
              commentId,
              req.user.companyId,
              req.user.id,
              storageName,
              originalName,
              file.mimetype,
              file.size,
            ],
          );
          attachments.push({
            id: attachmentResult.insertId,
            issue_id: Number(issue.id),
            comment_id: Number(commentId),
            uploaded_by: Number(req.user.id),
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
        id: commentId,
        issue_id: Number(req.params.id),
        user_id: Number(req.user.id),
        user_name: req.user.name,
        user_role: req.user.role,
        reply_to_id: replyToId,
        reply_preview: parentPreview,
        body: commentBody,
        attachments,
        created_at: new Date().toISOString(),
      };
      io.to(`company:${req.user.companyId}:issue:${req.params.id}`).emit("issueMessage", message);
      res.status(201).json({
        id: commentId,
        message: "เพิ่มความคิดเห็นแล้ว",
        data: message,
      });
    
      addIssueActivity(
        pool,
        req.params.id,
        req.user.id,
        "commented",
        `${req.user.name} ส่งข้อความ${files.length ? `พร้อมไฟล์ ${files.length} รายการ` : ""}`,
      ).catch((err) => console.error("issue activity failed", err));
    
      const preview = commentBody || "แนบไฟล์";
      notifyIssueRecipientsLater(
        req.params.id,
        req.user.id,
        `${issue.ticket_no} · ${issue.title}`,
        preview.length > 180 ? `${preview.slice(0, 180)}…` : preview,
        {
          type: "chat",
          actorName: req.user.name,
          actorId: req.user.id,
        },
      );
    }),
  );
}
