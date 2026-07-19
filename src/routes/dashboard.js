export function registerDashboardRoutes(app, deps) {
  const {
    auth,
    hasPermission,
    isRequesterPersona,
    paginatedJson,
    parsePagination,
    pool,
    wrap,
  } = deps;

  app.get("/api/dashboard", auth, wrap(async (req, res) => {
    const isRequester = isRequesterPersona(req.user);
    const readAllProjects = hasPermission(req.user, "projects.read_all");
    const readAllIssues = hasPermission(req.user, "issues.read_all");
    const canAcceptUnassigned = readAllIssues && hasPermission(req.user, "issues.accept");
    const projectsQuery = pool.execute(
      `SELECT COUNT(*) total, SUM(p.status = 'active') active
       FROM projects p
       WHERE p.company_id = ? AND (
          (? = 1)
          OR p.created_by = ? OR p.owner_id = ? OR EXISTS (
            SELECT 1 FROM project_members pm
            WHERE pm.project_id = p.id AND pm.user_id = ?
          ))`,
      [req.user.companyId, readAllProjects ? 1 : 0, req.user.id, req.user.id, req.user.id],
    );
    const issuesQuery = pool.execute(
      `SELECT COUNT(*) total,
              SUM(i.status IN ('open','accepted','in_progress')) open,
              SUM(i.status = 'open') pending,
              SUM(i.status IN ('accepted','in_progress')) in_progress,
              SUM(i.status = 'closed') completed
       FROM issues i
       WHERE i.company_id = ? AND (
         (? = 1 AND i.requester_id = ?)
         OR
         (? = 0 AND (
           ? = 1 OR i.requester_id = ? OR i.assignee_id = ?
           OR EXISTS (SELECT 1 FROM issue_members im WHERE im.issue_id = i.id AND im.user_id = ?)
         ))
       )`,
      [
        req.user.companyId,
        isRequester ? 1 : 0,
        req.user.id,
        isRequester ? 1 : 0,
        readAllIssues ? 1 : 0,
        req.user.id,
        req.user.id,
        req.user.id,
      ],
    );
    const tasksQuery = pool.execute(
      `SELECT COUNT(*) total, SUM(t.status = 'done') done
       FROM tasks t JOIN projects p ON p.id = t.project_id
       WHERE t.assignee_id = ? AND t.issue_id IS NULL AND p.company_id = ?`,
      [req.user.id, req.user.companyId],
    );
    const [[projects], [issues], [tasks]] = await Promise.all([
      projectsQuery,
      issuesQuery,
      tasksQuery,
    ]);
    const personalIssuesQuery = isRequester
      ? Promise.resolve([[{
        total: Number(issues[0].total || 0),
        done: Number(issues[0].completed || 0),
      }]])
      : pool.execute(
        `SELECT COUNT(*) total, SUM(i.status = 'closed') done
         FROM issues i
         WHERE i.company_id = ? AND (i.assignee_id = ?
            OR EXISTS (
              SELECT 1 FROM issue_members im
              WHERE im.issue_id = i.id AND im.user_id = ?
            ))`,
        [req.user.companyId, req.user.id, req.user.id],
      );
    const recentQuery = pool.execute(
      `SELECT i.id, i.ticket_no, i.title, i.status, i.priority, i.updated_at,
              p.name project_name, u.name requester_name
       FROM issues i LEFT JOIN projects p ON p.id = i.project_id
       JOIN users u ON u.id = i.requester_id
       WHERE i.company_id = ? AND (
         (? = 1 AND i.requester_id = ?)
         OR
         (? = 0 AND (
           ? = 1 OR i.requester_id = ? OR i.assignee_id = ?
           OR EXISTS (SELECT 1 FROM issue_members im WHERE im.issue_id = i.id AND im.user_id = ?)
         ))
       )
       ORDER BY i.updated_at DESC LIMIT 6`,
      [
        req.user.companyId,
        isRequester ? 1 : 0,
        req.user.id,
        isRequester ? 1 : 0,
        readAllIssues ? 1 : 0,
        req.user.id,
        req.user.id,
        req.user.id,
      ],
    );
    const openIssueItemsQuery = pool.execute(
      `SELECT i.id, 'issue' item_type, i.ticket_no, i.title, i.status, i.priority,
              i.updated_at, p.name project_name, u.name requester_name
       FROM issues i
       LEFT JOIN projects p ON p.id = i.project_id AND p.company_id = i.company_id
       JOIN users u ON u.id = i.requester_id
       WHERE i.company_id = ? AND i.status <> 'closed' AND (
         (? = 1 AND i.requester_id = ?)
         OR
         (? = 0 AND (
           i.assignee_id = ?
           OR EXISTS (
             SELECT 1 FROM issue_members im
             WHERE im.issue_id = i.id AND im.user_id = ?
           )
           OR (? = 1 AND i.status = 'open')
         ))
       )
       ORDER BY i.updated_at DESC
       LIMIT 20`,
      [
        req.user.companyId,
        isRequester ? 1 : 0,
        req.user.id,
        isRequester ? 1 : 0,
        req.user.id,
        req.user.id,
        canAcceptUnassigned ? 1 : 0,
      ],
    );
    const openTaskItemsQuery = isRequester
      ? Promise.resolve([[]])
      : pool.execute(
        `SELECT t.id, 'task' item_type, NULL ticket_no, t.title, t.status, t.priority,
                t.updated_at, p.name project_name, NULL requester_name
         FROM tasks t
         JOIN projects p ON p.id = t.project_id
         WHERE t.assignee_id = ? AND t.issue_id IS NULL
           AND t.status <> 'done' AND p.company_id = ?
         ORDER BY t.updated_at DESC
         LIMIT 20`,
        [req.user.id, req.user.companyId],
      );
    const [[personalIssues], [recent], [openIssueItems], [openTaskItems]] = await Promise.all([
      personalIssuesQuery,
      recentQuery,
      openIssueItemsQuery,
      openTaskItemsQuery,
    ]);
    const myWorkTotal = isRequester
      ? Number(personalIssues[0].total || 0)
      : Number(tasks[0].total || 0) + Number(personalIssues[0].total || 0);
    const myWorkDone = isRequester
      ? Number(personalIssues[0].done || 0)
      : Number(tasks[0].done || 0) + Number(personalIssues[0].done || 0);
    const actionItems = [...openIssueItems, ...openTaskItems]
      .sort((left, right) => new Date(right.updated_at) - new Date(left.updated_at))
      .slice(0, 20);
    res.json({
      pendingIssueCount: Number(issues[0].pending || 0),
      actionItems,
      counts: isRequester
        ? {
          issues: Number(issues[0].total || 0),
          pendingIssues: Number(issues[0].pending || 0),
          inProgressIssues: Number(issues[0].in_progress || 0),
          completedIssues: Number(issues[0].completed || 0),
        }
        : {
          projects: Number(projects[0].total || 0),
          activeProjects: Number(projects[0].active || 0),
          issues: Number(issues[0].total || 0),
          openIssues: Number(issues[0].open || 0),
          completedIssues: Number(issues[0].completed || 0),
          myTasks: Number(tasks[0].total || 0),
          completedTasks: Number(tasks[0].done || 0),
          myWorkTotal,
          myWorkDone,
          completionPercent: myWorkTotal ? Math.round((myWorkDone / myWorkTotal) * 100) : 0,
        },
      recentIssues: isRequester
        ? recent.map((issue) => ({
          id: issue.id,
          ticket_no: issue.ticket_no,
          title: issue.title,
          status: issue.status,
          updated_at: issue.updated_at,
        }))
        : recent,
    });
  }));

  app.get("/api/board-overview", auth, wrap(async (req, res) => {
    const requestedType = ["all", "project", "ticket"].includes(req.query.type)
      ? req.query.type
      : "all";
    const canViewProjects = hasPermission(req.user, "projects.read_all")
      || hasPermission(req.user, "projects.create")
      || hasPermission(req.user, "projects.update")
      || hasPermission(req.user, "tasks.update");
    const canViewTickets = hasPermission(req.user, "issues.transition");
    const pagination = parsePagination(req, { defaultLimit: 6, maxLimit: 6 });
    const query = String(req.query.query || "").trim().slice(0, 120);
    const status = String(req.query.status || "").trim();
    const validStatuses = new Set([
      "pending",
      "active",
      "on_hold",
      "completed",
      "rejected",
      "accepted",
      "in_progress",
    ]);
    const datePattern = /^\d{4}-\d{2}-\d{2}$/;
    const dateFrom = datePattern.test(String(req.query.dateFrom || "")) ? req.query.dateFrom : null;
    const dateTo = datePattern.test(String(req.query.dateTo || "")) ? req.query.dateTo : null;
    const includeProjects = canViewProjects && requestedType !== "ticket";
    const includeTickets = canViewTickets && requestedType !== "project";

    const projectWhere = [
      "p.company_id = ?",
      `(p.created_by = ? OR p.owner_id = ? OR EXISTS (
        SELECT 1 FROM project_members viewer_project_member
        WHERE viewer_project_member.project_id = p.id
          AND viewer_project_member.user_id = ?
      ))`,
    ];
    const projectValues = [
      req.user.companyId,
      req.user.id,
      req.user.id,
      req.user.id,
    ];
    if (query) {
      projectWhere.push("(p.name LIKE ? OR p.code LIKE ?)");
      projectValues.push(`%${query}%`, `%${query}%`);
    }
    if (status && validStatuses.has(status)) {
      projectWhere.push("p.status = ?");
      projectValues.push(status);
    }
    if (dateFrom) {
      projectWhere.push("DATE(COALESCE(p.end_date, p.start_date, p.created_at)) >= ?");
      projectValues.push(dateFrom);
    }
    if (dateTo) {
      projectWhere.push("DATE(COALESCE(p.end_date, p.start_date, p.created_at)) <= ?");
      projectValues.push(dateTo);
    }

    const ticketWhere = [
      "i.company_id = ?",
      "i.project_id IS NULL",
      "i.status IN ('accepted', 'in_progress')",
      `(i.assignee_id = ? OR EXISTS (
        SELECT 1 FROM issue_members viewer_issue_member
        WHERE viewer_issue_member.issue_id = i.id
          AND viewer_issue_member.user_id = ?
      ))`,
    ];
    const ticketValues = [
      req.user.companyId,
      req.user.id,
      req.user.id,
    ];
    if (query) {
      ticketWhere.push("(i.title LIKE ? OR i.ticket_no LIKE ?)");
      ticketValues.push(`%${query}%`, `%${query}%`);
    }
    if (status && validStatuses.has(status)) {
      ticketWhere.push("i.status = ?");
      ticketValues.push(status);
    }
    if (dateFrom) {
      ticketWhere.push("DATE(COALESCE(i.estimated_completion_at, i.updated_at, i.created_at)) >= ?");
      ticketValues.push(dateFrom);
    }
    if (dateTo) {
      ticketWhere.push("DATE(COALESCE(i.estimated_completion_at, i.updated_at, i.created_at)) <= ?");
      ticketValues.push(dateTo);
    }

    const countParts = [];
    const countValues = [];
    const dataParts = [];
    const dataValues = [];
    if (includeProjects) {
      const where = projectWhere.join(" AND ");
      countParts.push(`SELECT p.id FROM projects p WHERE ${where}`);
      countValues.push(...projectValues);
      dataParts.push(
        `SELECT 'project' kind, p.id, p.code, NULL ticket_no, p.name title,
                p.status, NULL priority, NULL board_status, NULL description, NULL due_date,
                NULL project_name, owner.name assignee_name,
                p.owner_id, p.created_by, NULL assignee_id,
                EXISTS (
                  SELECT 1 FROM project_members participant
                  WHERE participant.project_id = p.id AND participant.user_id = ?
                ) issue_participant,
                COALESCE(p.end_date, p.start_date, DATE(p.created_at)) item_date,
                p.created_at updated_at,
                (
                  SELECT COUNT(*) FROM tasks project_task
                  WHERE project_task.project_id = p.id AND project_task.issue_id IS NULL
                ) + (
                  SELECT COUNT(*) FROM issues project_issue
                  WHERE project_issue.project_id = p.id
                ) work_total,
                (
                  SELECT COUNT(*) FROM tasks project_task
                  WHERE project_task.project_id = p.id
                    AND project_task.issue_id IS NULL AND project_task.status = 'done'
                ) + (
                  SELECT COUNT(*) FROM issues project_issue
                  WHERE project_issue.project_id = p.id AND project_issue.status = 'closed'
                ) work_done,
                (
                  SELECT COUNT(*) FROM tasks project_task
                  WHERE project_task.project_id = p.id
                    AND project_task.issue_id IS NULL AND project_task.status <> 'done'
                ) + (
                  SELECT COUNT(*) FROM issues project_issue
                  WHERE project_issue.project_id = p.id AND project_issue.status <> 'closed'
                ) remaining
         FROM projects p
         JOIN users owner ON owner.id = p.owner_id
         WHERE ${where}`,
      );
      dataValues.push(req.user.id, ...projectValues);
    }
    if (includeTickets) {
      const where = ticketWhere.join(" AND ");
      countParts.push(`SELECT i.id FROM issues i WHERE ${where}`);
      countValues.push(...ticketValues);
      dataParts.push(
        `SELECT 'ticket' kind, i.id, NULL code, i.ticket_no, i.title,
                i.status, i.priority, i.board_status, LEFT(i.description, 280) description,
                DATE(i.estimated_completion_at) due_date,
                NULL project_name, assignee.name assignee_name,
                NULL owner_id, NULL created_by, i.assignee_id,
                (
                  i.assignee_id = ? OR EXISTS (
                    SELECT 1 FROM issue_members participant
                    WHERE participant.issue_id = i.id AND participant.user_id = ?
                  )
                ) issue_participant,
                COALESCE(DATE(i.estimated_completion_at), DATE(i.updated_at), DATE(i.created_at)) item_date,
                i.updated_at, 1 work_total, 0 work_done, 1 remaining
         FROM issues i
         LEFT JOIN users assignee ON assignee.id = i.assignee_id
         WHERE ${where}`,
      );
      dataValues.push(req.user.id, req.user.id, ...ticketValues);
    }

    if (!dataParts.length) {
      return paginatedJson(res, [], 0, pagination);
    }
    const [[{ total }]] = await pool.execute(
      `SELECT COUNT(*) total FROM (${countParts.join(" UNION ALL ")}) overview_count`,
      countValues,
    );
    const orderBy = req.query.sort === "due"
      ? "item_date IS NULL, item_date ASC, updated_at DESC"
      : req.query.sort === "workload"
        ? "remaining DESC, updated_at DESC"
        : "updated_at DESC";
    const [rows] = await pool.execute(
      `SELECT * FROM (${dataParts.join(" UNION ALL ")}) overview
       ORDER BY ${orderBy}
       LIMIT ${pagination.limit} OFFSET ${pagination.offset}`,
      dataValues,
    );
    paginatedJson(
      res,
      rows.map((row) => ({
        ...row,
        issue_participant: Boolean(row.issue_participant),
        work_total: Number(row.work_total || 0),
        work_done: Number(row.work_done || 0),
        remaining: Number(row.remaining || 0),
      })),
      Number(total || 0),
      pagination,
    );
  }));
}
