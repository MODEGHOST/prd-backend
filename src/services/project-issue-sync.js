import { STAFF_MEMBERSHIP_SQL } from "../repositories/projects.js";

export function createProjectIssueSyncService() {
  async function addIssueActivity(conn, issueId, actorId, eventType, description) {
    await conn.execute(
      `INSERT INTO issue_activities (issue_id, actor_id, event_type, description)
       VALUES (?, ?, ?, ?)`,
      [issueId, actorId || null, eventType, description],
    );
  }

  async function ensureProjectMember(conn, projectId, userId, responsibility = null) {
    await conn.execute(
      `INSERT INTO project_members (project_id, user_id, responsibility)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE
         responsibility = COALESCE(VALUES(responsibility), responsibility)`,
      [projectId, userId, responsibility],
    );
  }

  async function ensureIssueMember(conn, issueId, userId, addedBy) {
    await conn.execute(
      `INSERT INTO issue_members (issue_id, user_id, added_by)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE added_by = VALUES(added_by)`,
      [issueId, userId, addedBy],
    );
  }

  async function syncIssueMembersFromProject(conn, issue, actorId) {
    if (!issue?.project_id) return [];
    const [rows] = await conn.execute(
      `SELECT DISTINCT pm.user_id, u.name
       FROM project_members pm
       JOIN projects p ON p.id = pm.project_id
       JOIN users u ON u.id = pm.user_id
       JOIN company_memberships cm
         ON cm.user_id = u.id AND cm.company_id = p.company_id AND cm.status = 'active'
       JOIN membership_roles mr ON mr.membership_id = cm.id
       JOIN roles r ON r.id = mr.role_id
       WHERE pm.project_id = ?
         AND ${STAFF_MEMBERSHIP_SQL}
         AND pm.user_id <> COALESCE(?, 0)
       ORDER BY u.name`,
      [issue.project_id, issue.assignee_id || 0],
    );
    for (const row of rows) {
      await ensureIssueMember(conn, issue.id, row.user_id, actorId || issue.assignee_id || row.user_id);
    }
    return rows;
  }

  function taskStatusForIssue(issue) {
    if (issue.status === "closed") return "done";
    if (issue.board_status === "review") return "review";
    if (issue.status === "in_progress") return "doing";
    return "todo";
  }

  function issueStateForTaskStatus(taskStatus) {
    if (taskStatus === "done") return { status: "closed", boardStatus: "done" };
    if (taskStatus === "doing") return { status: "in_progress", boardStatus: "doing" };
    if (taskStatus === "review") return { status: "in_progress", boardStatus: "review" };
    return { status: "accepted", boardStatus: "todo" };
  }

  async function ensureLinkedIssueTask(conn, issue, assigneeId = issue.assignee_id) {
    if (!issue.project_id || !assigneeId) return null;
    await ensureProjectMember(conn, issue.project_id, assigneeId, "ดูแล Ticket");
    let startDate = issue.project_start_date || null;
    let dueDate = issue.estimated_completion_at
      ? String(issue.estimated_completion_at).slice(0, 10)
      : (issue.project_end_date || null);
    if (!startDate || !dueDate) {
      const [[project]] = await conn.execute(
        "SELECT start_date, end_date FROM projects WHERE id = ?",
        [issue.project_id],
      );
      startDate = startDate || project?.start_date || null;
      dueDate = dueDate || project?.end_date || null;
    }
    const [linkedTasks] = await conn.execute(
      "SELECT id, start_date, due_date FROM tasks WHERE issue_id = ? ORDER BY id LIMIT 2",
      [issue.id],
    );
    if (linkedTasks.length) {
      if (linkedTasks.length === 1) {
        await conn.execute(
          `UPDATE tasks
           SET assignee_id = ?,
               start_date = COALESCE(start_date, ?),
               due_date = COALESCE(due_date, ?)
           WHERE id = ?`,
          [assigneeId, startDate, dueDate, linkedTasks[0].id],
        );
      }
      return linkedTasks[0].id;
    }
    const [result] = await conn.execute(
      `INSERT INTO tasks
        (company_id, project_id, issue_id, title, description, status, priority,
         assignee_id, start_date, due_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        issue.company_id,
        issue.project_id,
        issue.id,
        `${issue.ticket_no} · ${issue.title}`,
        issue.description || null,
        taskStatusForIssue(issue),
        issue.priority || "medium",
        assigneeId,
        startDate,
        dueDate,
      ],
    );
    return result.insertId;
  }

  async function syncSingleLinkedTask(conn, issue) {
    const [linkedTasks] = await conn.execute(
      "SELECT id FROM tasks WHERE issue_id = ? ORDER BY id LIMIT 2",
      [issue.id],
    );
    if (linkedTasks.length !== 1) return;
    let dueDate = issue.estimated_completion_at
      ? String(issue.estimated_completion_at).slice(0, 10)
      : (issue.project_end_date || null);
    if (!dueDate && issue.project_id) {
      const [[project]] = await conn.execute(
        "SELECT end_date FROM projects WHERE id = ?",
        [issue.project_id],
      );
      dueDate = project?.end_date || null;
    }
    await conn.execute(
      `UPDATE tasks
       SET status = ?, assignee_id = ?, due_date = COALESCE(?, due_date)
       WHERE id = ?`,
      [taskStatusForIssue(issue), issue.assignee_id || null, dueDate, linkedTasks[0].id],
    );
  }

  return {
    addIssueActivity,
    ensureIssueMember,
    ensureLinkedIssueTask,
    ensureProjectMember,
    issueStateForTaskStatus,
    syncIssueMembersFromProject,
    syncSingleLinkedTask,
    taskStatusForIssue,
  };
}
