export function projectRoom(companyId, projectId) {
  return `company:${companyId}:project:${projectId}`;
}

export function issueRoom(companyId, issueId) {
  return `company:${companyId}:issue:${issueId}`;
}

export function userRoom(companyId, userId) {
  return `company:${companyId}:user:${userId}`;
}

export async function fetchTaskBoardRow(pool, { taskId, companyId, viewerUserId }) {
  const [[row]] = await pool.execute(
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
     JOIN projects p ON p.id = t.project_id AND p.company_id = ?
     LEFT JOIN users u ON u.id = t.assignee_id
     LEFT JOIN issues i ON i.id = t.issue_id
     LEFT JOIN issue_members im ON im.issue_id = t.issue_id AND im.user_id = ?
     LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = ?
     WHERE t.id = ?`,
    [
      viewerUserId,
      viewerUserId,
      viewerUserId,
      companyId,
      viewerUserId,
      viewerUserId,
      taskId,
    ],
  );
  return row || null;
}

export async function fetchWeeklyPlanRow(pool, planId) {
  const [[row]] = await pool.execute(
    `SELECT wp.*, a.name assignee_name, c.name created_by_name
     FROM weekly_plans wp
     LEFT JOIN users a ON a.id = wp.assignee_id
     JOIN users c ON c.id = wp.created_by
     WHERE wp.id = ?`,
    [planId],
  );
  return row || null;
}

export async function fetchIssueListRow(pool, { issueId, companyId, viewerUserId }) {
  const [[row]] = await pool.execute(
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
     WHERE i.id = ? AND i.company_id = ?`,
    [
      viewerUserId,
      viewerUserId,
      viewerUserId,
      viewerUserId,
      viewerUserId,
      issueId,
      companyId,
    ],
  );
  return row || null;
}

function uniquePositiveIds(ids) {
  return [...new Set(
    (ids || [])
      .map(Number)
      .filter((id) => Number.isInteger(id) && id > 0),
  )];
}

/** Emit the same patch to several rooms without duplicating work for missing io. */
function emitToRooms(io, rooms, event, payload) {
  if (!io || !payload) return;
  for (const room of [...new Set((rooms || []).filter(Boolean))]) {
    io.to(room).emit(event, payload);
  }
}

export function emitTaskChanged(io, {
  companyId,
  projectId,
  actorId,
  op,
  task,
  linkedIssue = null,
  boardGate = null,
}) {
  if (!io || !task || !projectId) return;
  const payload = {
    op,
    actorId: actorId != null ? Number(actorId) : null,
    projectId: Number(projectId),
    task,
    linkedIssue,
    boardGate,
  };
  emitToRooms(io, [projectRoom(companyId, projectId)], "task:changed", payload);
}

export async function emitIssueChanged(io, {
  companyId,
  actorId,
  op,
  issue,
  linkedTask = null,
  recipientIds = [],
}) {
  if (!io || !issue?.id) return;
  const payload = {
    op,
    actorId: actorId != null ? Number(actorId) : null,
    issue,
    linkedTask,
  };
  const rooms = [
    issueRoom(companyId, issue.id),
  ];
  if (issue.project_id) {
    rooms.push(projectRoom(companyId, issue.project_id));
  }
  for (const userId of uniquePositiveIds([...(recipientIds || []), actorId])) {
    rooms.push(userRoom(companyId, userId));
  }
  emitToRooms(io, rooms, "issue:changed", payload);
}

export function emitWeeklyPlanChanged(io, {
  companyId,
  projectId,
  actorId,
  op,
  plan,
}) {
  if (!io || !plan || !projectId) return;
  const payload = {
    op,
    actorId: actorId != null ? Number(actorId) : null,
    projectId: Number(projectId),
    plan,
  };
  emitToRooms(io, [projectRoom(companyId, projectId)], "weeklyPlan:changed", payload);
}
