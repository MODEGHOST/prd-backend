import { hasPermission } from "../core/authz.js";

export function createIssueRepository(pool) {
  async function getIssueById(issueId, companyId = null) {
    const [[issue]] = await pool.execute(
      `SELECT i.*, p.code project_code, p.name project_name,
              p.end_date project_end_date, p.start_date project_start_date,
              requester.name requester_name, assignee.name assignee_name
       FROM issues i
       LEFT JOIN projects p ON p.id = i.project_id
       JOIN users requester ON requester.id = i.requester_id
       LEFT JOIN users assignee ON assignee.id = i.assignee_id
       WHERE i.id = ? AND (? IS NULL OR i.company_id = ?)`,
      [issueId, companyId, companyId],
    );
    return issue || null;
  }

  async function isIssueParticipant(issueId, userId, executor = pool) {
    const [[row]] = await executor.execute(
      `SELECT 1 ok FROM issues i
       LEFT JOIN projects p
         ON p.id = i.project_id AND p.company_id = i.company_id
       WHERE i.id = ? AND (
         i.assignee_id = ?
         OR EXISTS (
           SELECT 1 FROM issue_members im
           WHERE im.issue_id = i.id AND im.user_id = ?
         )
         OR p.owner_id = ?
         OR p.created_by = ?
         OR EXISTS (
           SELECT 1 FROM project_members pm
           WHERE pm.project_id = p.id AND pm.user_id = ?
         )
       )`,
      [issueId, userId, userId, userId, userId, userId],
    );
    return Boolean(row);
  }

  async function canViewIssue(user, issue) {
    if (Number(issue.company_id) !== Number(user.companyId)) return false;
    if (hasPermission(user, "issues.read_all")) return true;
    if (user.roles.includes("requester")) {
      return Number(issue.requester_id) === Number(user.id);
    }
    if (Number(issue.requester_id) === Number(user.id)
        || Number(issue.assignee_id) === Number(user.id)) return true;
    return isIssueParticipant(issue.id, user.id);
  }

  async function getIssueRecipientIds(issueId) {
    const [rows] = await pool.execute(
      `SELECT requester_id user_id FROM issues WHERE id = ?
       UNION
       SELECT assignee_id user_id FROM issues WHERE id = ? AND assignee_id IS NOT NULL
       UNION
       SELECT user_id FROM issue_members WHERE issue_id = ?`,
      [issueId, issueId, issueId],
    );
    return rows.map((row) => Number(row.user_id));
  }

  return { canViewIssue, getIssueById, getIssueRecipientIds, isIssueParticipant };
}
