import { hasPermission } from "../core/authz.js";

const STAFF_MEMBERSHIP_SQL = `(
  r.name IN ('group_admin','company_owner','company_admin','project_manager','dev')
  OR EXISTS (
    SELECT 1
    FROM membership_roles capability_mr
    JOIN role_permissions capability_rp ON capability_rp.role_id = capability_mr.role_id
    JOIN permissions capability_p ON capability_p.id = capability_rp.permission_id
    WHERE capability_mr.membership_id = cm.id
      AND capability_p.code IN (
        'projects.create','projects.update','issues.accept',
        'issues.transition','tasks.create','tasks.update'
      )
  )
)`;

export function createProjectRepository(pool) {
  async function getProjectById(projectId, companyId = null) {
    const [[project]] = await pool.execute(
      `SELECT p.*, creator.name creator_name, owner.name owner_name
       FROM projects p
       JOIN users owner ON owner.id = p.owner_id
       JOIN users creator ON creator.id = p.created_by
       WHERE p.id = ? AND (? IS NULL OR p.company_id = ?)`,
      [projectId, companyId, companyId],
    );
    return project || null;
  }

  async function isProjectMember(projectId, userId) {
    const [[row]] = await pool.execute(
      "SELECT 1 AS ok FROM project_members WHERE project_id = ? AND user_id = ? LIMIT 1",
      [projectId, userId],
    );
    return Boolean(row);
  }

  async function isProjectStaffMember(projectId, userId) {
    if (!userId) return false;
    const project = await getProjectById(projectId);
    if (!project) return false;
    if (Number(project.owner_id) === Number(userId)) return true;
    if (Number(project.created_by) === Number(userId)) return true;
    const [[row]] = await pool.execute(
      `SELECT 1 AS ok
       FROM project_members pm
       JOIN projects p ON p.id = pm.project_id
       JOIN company_memberships cm
         ON cm.user_id = pm.user_id AND cm.company_id = p.company_id AND cm.status = 'active'
       JOIN membership_roles mr ON mr.membership_id = cm.id
       JOIN roles r ON r.id = mr.role_id
       WHERE pm.project_id = ? AND pm.user_id = ?
         AND ${STAFF_MEMBERSHIP_SQL}
       LIMIT 1`,
      [projectId, userId],
    );
    return Boolean(row);
  }

  async function canAccessProject(user, projectId) {
    const project = await getProjectById(projectId, user.companyId);
    if (!project) return null;
    if (user.roles.includes("requester") && !hasPermission(user, "projects.read_all")) return false;
    if (hasPermission(user, "projects.read_all")) return true;
    if (Number(project.created_by) === Number(user.id)) return true;
    if (Number(project.owner_id) === Number(user.id)) return true;
    return isProjectMember(projectId, user.id);
  }

  async function canManageProject(user, projectId) {
    const project = await getProjectById(projectId, user.companyId);
    if (!project) return null;
    if (hasPermission(user, "projects.manage_all")) return true;
    return Number(project.created_by) === Number(user.id)
      || Number(project.owner_id) === Number(user.id);
  }

  async function getProjectRecipientIds(projectId) {
    const [rows] = await pool.execute(
      `SELECT owner_id user_id FROM projects WHERE id = ?
       UNION
       SELECT created_by user_id FROM projects WHERE id = ?
       UNION
       SELECT user_id FROM project_members WHERE project_id = ?`,
      [projectId, projectId, projectId],
    );
    return rows.map((row) => Number(row.user_id));
  }

  return {
    canAccessProject,
    canManageProject,
    getProjectById,
    getProjectRecipientIds,
    isProjectMember,
    isProjectStaffMember,
  };
}

export { STAFF_MEMBERSHIP_SQL };
