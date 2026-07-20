export function registerTaskRoutes(app, deps) {
  const {
    addIssueActivity,
    auth,
    canAccessProject,
    canManageProject,
    getIssueById,
    hasPermission,
    isIssueParticipant,
    isProjectMember,
    isProjectStaffMember,
    isRequesterPersona,
    issueStateForTaskStatus,
    notify,
    notifyIssueRecipients,
    paginatedJson,
    parsePagination,
    pool,
    requirePermission,
    STAFF_MEMBERSHIP_SQL,
    wrap,
  } = deps;

  app.get("/api/tasks", auth, wrap(async (req, res) => {
    if (isRequesterPersona(req.user)) {
      const pagination = parsePagination(req, { defaultLimit: 200, maxLimit: 500 });
      return paginatedJson(res, [], 0, pagination);
    }
    const values = [];
    let filter = "";

    if (req.query.projectId) {
      const projectId = Number(req.query.projectId);
      if (!Number.isInteger(projectId) || projectId <= 0) {
        return res.status(400).json({ message: "projectId ไม่ถูกต้อง" });
      }
      const access = await canAccessProject(req.user, projectId);
      if (access === null) return res.status(404).json({ message: "ไม่พบโครงการ" });
      if (!access) return res.status(403).json({ message: "คุณไม่มีสิทธิ์เข้าถึงโครงการนี้" });
      filter = `WHERE t.project_id = ?
        AND EXISTS (SELECT 1 FROM projects tenant_project
                    WHERE tenant_project.id = t.project_id AND tenant_project.company_id = ?)`;
      values.push(projectId, req.user.companyId);
    } else if (req.query.mine === "true") {
      filter = `WHERE t.assignee_id = ?
        AND EXISTS (SELECT 1 FROM projects tenant_project
                    WHERE tenant_project.id = t.project_id AND tenant_project.company_id = ?)`;
      values.push(req.user.id, req.user.companyId);
    } else {
      return res.status(400).json({ message: "ระบุ projectId หรือ mine=true" });
    }
    if (req.query.standalone === "true") {
      filter += " AND t.issue_id IS NULL";
    }
    if (req.query.status) {
      if (!["todo", "doing", "review", "done"].includes(req.query.status)) {
        return res.status(400).json({ message: "สถานะงานไม่ถูกต้อง" });
      }
      filter += " AND t.status = ?";
      values.push(req.query.status);
    }
    if (req.query.priority) {
      if (!["low", "medium", "high", "urgent"].includes(req.query.priority)) {
        return res.status(400).json({ message: "ความสำคัญไม่ถูกต้อง" });
      }
      filter += " AND t.priority = ?";
      values.push(req.query.priority);
    }
    if (req.query.assigneeId) {
      const assigneeId = Number(req.query.assigneeId);
      if (!Number.isInteger(assigneeId) || assigneeId <= 0) {
        return res.status(400).json({ message: "assigneeId ไม่ถูกต้อง" });
      }
      filter += " AND t.assignee_id = ?";
      values.push(assigneeId);
    }
    const query = String(req.query.q || "").trim();
    if (query) {
      filter += " AND (t.title LIKE ? OR t.description LIKE ?)";
      values.push(`%${query}%`, `%${query}%`);
    }
    const dateFrom = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.dateFrom || ""))
      ? req.query.dateFrom
      : null;
    const dateTo = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.dateTo || ""))
      ? req.query.dateTo
      : null;
    if (dateFrom) {
      filter += " AND COALESCE(t.due_date, DATE(t.updated_at)) >= ?";
      values.push(dateFrom);
    }
    if (dateTo) {
      filter += " AND COALESCE(t.due_date, DATE(t.updated_at)) <= ?";
      values.push(dateTo);
    }
    if (req.query.overdue === "true") {
      filter += " AND t.due_date IS NOT NULL AND t.due_date < CURDATE() AND t.status <> 'done'";
    }

    const pagination = parsePagination(req, { defaultLimit: 200, maxLimit: 500 });
    const [[{ total }]] = await pool.execute(
      `SELECT COUNT(*) total FROM tasks t ${filter}`,
      values,
    );

    const [rows] = await pool.execute(
      `SELECT t.id, t.project_id, t.issue_id, t.title, t.description, t.status, t.priority,
              t.difficulty,
              t.assignee_id, t.position, t.created_at, t.updated_at,
              COALESCE(t.start_date, p.start_date) AS start_date,
              CASE
                WHEN t.issue_id IS NOT NULL
                  THEN COALESCE(t.due_date, DATE(i.estimated_completion_at), p.end_date)
                ELSE t.due_date
              END AS due_date,
              p.name project_name, u.name assignee_name,
              CASE
                WHEN t.issue_id IS NULL THEN 0
                WHEN i.assignee_id = ? THEN 1
                WHEN im.user_id IS NOT NULL THEN 1
                WHEN p.owner_id = ? OR p.created_by = ? THEN 1
                WHEN pm.user_id IS NOT NULL THEN 1
                ELSE 0
              END AS issue_participant
       FROM tasks t
       JOIN projects p ON p.id = t.project_id
       LEFT JOIN users u ON u.id = t.assignee_id
       LEFT JOIN issues i ON i.id = t.issue_id
       LEFT JOIN issue_members im ON im.issue_id = t.issue_id AND im.user_id = ?
       LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = ?
       ${filter}
       ORDER BY t.status, t.position, t.created_at DESC
       LIMIT ${pagination.limit} OFFSET ${pagination.offset}`,
      [req.user.id, req.user.id, req.user.id, req.user.id, req.user.id, ...values],
    );
    paginatedJson(res, rows, total, pagination);
  }));

  app.post("/api/tasks", auth, requirePermission("tasks.create"), wrap(async (req, res) => {
    const {
      projectId,
      issueId,
      title,
      description,
      priority,
      difficulty,
      assigneeId,
      startDate,
      dueDate,
    } = req.body;
    if (!projectId || !title) return res.status(400).json({ message: "กรุณาระบุโครงการและชื่องาน" });

    const pid = Number(projectId);
    if (!Number.isInteger(pid) || pid <= 0) {
      return res.status(400).json({ message: "projectId ไม่ถูกต้อง" });
    }

    const manage = await canManageProject(req.user, pid);
    if (manage === null) return res.status(404).json({ message: "ไม่พบโครงการ" });
    const isStaffMember = await isProjectStaffMember(pid, req.user.id);
    if (!manage && !isStaffMember) {
      return res.status(403).json({ message: "คุณไม่มีสิทธิ์สร้างงานในโครงการนี้" });
    }
    if (priority && !["low", "medium", "high", "urgent"].includes(priority)) {
      return res.status(400).json({ message: "ความสำคัญไม่ถูกต้อง" });
    }
    if (difficulty && !["easy", "medium", "hard"].includes(difficulty)) {
      return res.status(400).json({ message: "ความยากไม่ถูกต้อง" });
    }
    if (startDate && dueDate && startDate > dueDate) {
      return res.status(400).json({ message: "วันสิ้นสุดต้องไม่น้อยกว่าวันเริ่ม" });
    }

    let assignee = null;
    if (assigneeId !== undefined && assigneeId !== null && assigneeId !== "") {
      assignee = Number(assigneeId);
      if (!Number.isInteger(assignee) || assignee <= 0) {
        return res.status(400).json({ message: "assigneeId ไม่ถูกต้อง" });
      }
      if (!(await isProjectMember(pid, assignee))) {
        return res.status(400).json({ message: "ผู้รับมอบหมายต้องเป็นสมาชิกโครงการ" });
      }
      const [[assigneeUser]] = await pool.execute(
        `SELECT r.name
         FROM company_memberships cm
         JOIN membership_roles mr ON mr.membership_id = cm.id
         JOIN roles r ON r.id = mr.role_id
         WHERE cm.user_id = ? AND cm.company_id = ? AND cm.status = 'active'
           AND ${STAFF_MEMBERSHIP_SQL}
         LIMIT 1`,
        [assignee, req.user.companyId],
      );
      if (!assigneeUser) {
        return res.status(400).json({ message: "ผู้รับผิดชอบต้องเป็นเจ้าหน้าที่ในโครงการ (admin/member)" });
      }
    }

    let linkedIssueId = null;
    if (issueId !== undefined && issueId !== null && issueId !== "") {
      linkedIssueId = Number(issueId);
      const linkedIssue = Number.isInteger(linkedIssueId)
        ? await getIssueById(linkedIssueId, req.user.companyId)
        : null;
      if (!linkedIssue || Number(linkedIssue.project_id) !== pid) {
        return res.status(400).json({ message: "issueId ต้องเป็น Ticket ของโครงการและบริษัทเดียวกัน" });
      }
    }

    const [result] = await pool.execute(
      `INSERT INTO tasks
        (company_id, project_id, issue_id, title, description, priority, difficulty,
         assignee_id, start_date, due_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        req.user.companyId,
        pid,
        linkedIssueId,
        title,
        description || null,
        priority || "medium",
        difficulty || "medium",
        assignee,
        startDate || null,
        dueDate || null,
      ],
    );
    await notify(assignee, "ได้รับมอบหมายงานใหม่", title, {
      targetUrl: `/projects/${pid}?tab=tasks`,
      entityType: "project",
      entityId: pid,
    });
    res.status(201).json({ id: result.insertId, message: "สร้างงานเรียบร้อย" });
  }));

  app.patch("/api/tasks/:id", auth, requirePermission("tasks.update"), wrap(async (req, res) => {
    const taskId = Number(req.params.id);
    const [[task]] = await pool.execute(
      `SELECT t.id, t.project_id, t.issue_id, t.assignee_id, t.status,
              i.status issue_status, i.ticket_no, i.title issue_title
       FROM tasks t
       JOIN projects tenant_project
         ON tenant_project.id = t.project_id AND tenant_project.company_id = ?
       LEFT JOIN issues i ON i.id = t.issue_id
       WHERE t.id = ?`,
      [req.user.companyId, taskId],
    );
    if (!task) return res.status(404).json({ message: "ไม่พบงาน" });

    const manage = await canManageProject(req.user, task.project_id);
    const isAssignee = Number(task.assignee_id) === Number(req.user.id);
    const canMoveLinkedIssue = task.issue_id
      ? hasPermission(req.user, "issues.manage_all") || await isIssueParticipant(task.issue_id, req.user.id)
      : false;
    if (task.issue_id ? !canMoveLinkedIssue : (!manage && !isAssignee)) {
      return res.status(403).json({ message: "คุณไม่มีสิทธิ์อัปเดตงานนี้" });
    }

    const detailFields = ["title", "description", "priority", "difficulty", "assigneeId", "startDate", "dueDate"];
    const updatesDetails = detailFields.some((field) => Object.hasOwn(req.body, field));
    let detailUpdateValues = null;
    if (updatesDetails) {
      const canEditDetails = Boolean(manage) || isAssignee || canMoveLinkedIssue;
      if (!canEditDetails) {
        return res.status(403).json({ message: "คุณไม่มีสิทธิ์แก้ไขรายละเอียดงานนี้" });
      }

      const {
        title,
        description,
        priority,
        difficulty,
        assigneeId,
        startDate,
        dueDate,
      } = req.body;
      if (!title?.trim()) return res.status(400).json({ message: "กรุณาระบุชื่องาน" });
      if (!["low", "medium", "high", "urgent"].includes(priority)) {
        return res.status(400).json({ message: "ความสำคัญไม่ถูกต้อง" });
      }
      if (!["easy", "medium", "hard"].includes(difficulty)) {
        return res.status(400).json({ message: "ความยากไม่ถูกต้อง" });
      }
      if (startDate && dueDate && startDate > dueDate) {
        return res.status(400).json({ message: "วันสิ้นสุดต้องไม่น้อยกว่าวันเริ่ม" });
      }

      let assignee = null;
      if (assigneeId !== undefined && assigneeId !== null && assigneeId !== "") {
        assignee = Number(assigneeId);
        if (!Number.isInteger(assignee) || assignee <= 0) {
          return res.status(400).json({ message: "assigneeId ไม่ถูกต้อง" });
        }
        const [[staffMember]] = await pool.execute(
          `SELECT DISTINCT u.id
           FROM project_members pm
           JOIN users u ON u.id = pm.user_id
           JOIN company_memberships cm ON cm.user_id = u.id AND cm.status = 'active'
           JOIN membership_roles mr ON mr.membership_id = cm.id
           JOIN roles r ON r.id = mr.role_id
           JOIN projects p ON p.id = pm.project_id AND p.company_id = cm.company_id
           WHERE pm.project_id = ? AND pm.user_id = ? AND cm.company_id = ?
             AND ${STAFF_MEMBERSHIP_SQL}`,
          [task.project_id, assignee, req.user.companyId],
        );
        if (!staffMember) {
          return res.status(400).json({ message: "ผู้รับผิดชอบต้องเป็นเจ้าหน้าที่ในโครงการ" });
        }
      }
      if (Number(assignee || 0) !== Number(task.assignee_id || 0) && !manage) {
        return res.status(403).json({ message: "เฉพาะผู้ดูแลโครงการที่เปลี่ยนผู้รับผิดชอบได้" });
      }

      detailUpdateValues = [
        title.trim(),
        description?.trim() || null,
        priority,
        difficulty,
        assignee,
        startDate || null,
        dueDate || null,
        taskId,
      ];
    }

    const status = req.body.status;
    if (status !== undefined) {
      if (!["todo", "doing", "review", "done"].includes(status)) {
        return res.status(400).json({ message: "สถานะไม่ถูกต้อง" });
      }
      if (task.issue_id && task.issue_status === "closed" && status !== "done") {
        return res.status(409).json({ message: "Ticket ที่เชื่อมกับงานนี้ปิดแล้วและย้ายไม่ได้" });
      }
    }

    const labels = {
      todo: "สิ่งที่ต้องทำ",
      doing: "กำลังทำ",
      review: "ตรวจสอบ",
      done: "เสร็จแล้ว",
    };
    let notifyLinkedIssue = false;
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      if (detailUpdateValues) {
        await connection.execute(
          `UPDATE tasks
           SET title = ?, description = ?, priority = ?, difficulty = ?,
               assignee_id = ?, start_date = ?, due_date = ?
           WHERE id = ?`,
          detailUpdateValues,
        );
      }
      if (status !== undefined) {
        await connection.execute(
          "UPDATE tasks SET status = ?, position = ? WHERE id = ?",
          [status, Number(req.body.position || 0), taskId],
        );
      }
      if (task.issue_id && status !== undefined) {
        const [[{ linked_count: linkedCount }]] = await connection.execute(
          "SELECT COUNT(*) linked_count FROM tasks WHERE issue_id = ?",
          [task.issue_id],
        );
        if (Number(linkedCount) === 1) {
          const next = issueStateForTaskStatus(status);
          await connection.execute(
            `UPDATE issues
             SET status = ?,
                 board_status = ?,
                 started_at = IF(? IN ('doing', 'review'), COALESCE(started_at, CURRENT_TIMESTAMP), started_at),
                 completed_at = IF(? = 'done', CURRENT_TIMESTAMP, completed_at)
             WHERE id = ?`,
            [next.status, next.boardStatus, status, status, task.issue_id],
          );
          await addIssueActivity(
            connection,
            task.issue_id,
            req.user.id,
            status === "done" ? "completed" : "board_moved",
            `${req.user.name} ย้ายงานบนกระดานไป "${labels[status]}"`,
          );
          notifyLinkedIssue = true;
        }
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }

    if (notifyLinkedIssue) {
      await notifyIssueRecipients(
        task.issue_id,
        req.user.id,
        status === "done" ? "Ticket เสร็จสิ้นแล้ว" : "Ticket มีการเปลี่ยนสถานะ",
        `${task.ticket_no}: ${labels[status]}`,
      );
    }
    res.json({ message: updatesDetails ? "บันทึกรายละเอียดงานแล้ว" : "ย้ายงานเรียบร้อย" });
  }));
}
