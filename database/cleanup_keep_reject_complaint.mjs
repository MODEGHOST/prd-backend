/**
 * Clear local transactional data but KEEP one project and its related rows.
 * Target: ระบบ Reject Complaint (PRJ-662764)
 *
 * NEVER touch: users, companies, permissions, roles, role_permissions,
 *              company_memberships, membership_roles, schema_migrations
 *
 * Keeps also: the keep-project + members/plans/tasks/messages/attachments,
 *             issues linked to that project (+ issue chat/attachments/members/activities)
 *
 * Removes: other projects, orphan project rows, other issues,
 *          notifications/invites/tokens/outbox/audit
 */
import mysql from "mysql2/promise";

const KEEP_PROJECT_CODE = "PRJ-662764";

const connection = await mysql.createConnection({
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "lfbsmart_project",
  multipleStatements: true,
});

const [[keep]] = await connection.query(
  `SELECT id, code, name FROM projects WHERE code = ? LIMIT 1`,
  [KEEP_PROJECT_CODE],
);

if (!keep) {
  console.error(`Keep project not found: ${KEEP_PROJECT_CODE}`);
  await connection.end();
  process.exit(1);
}

console.log(`keep.project=${keep.id} ${keep.code} ${keep.name}`);

const [beforeProjects] = await connection.query(
  `SELECT id, code, name FROM projects ORDER BY id`,
);
console.log("before.projects=", beforeProjects);

await connection.query("SET FOREIGN_KEY_CHECKS = 0");

// Issues not belonging to the keep project (and orphans)
await connection.query(
  `DELETE FROM issue_attachments
   WHERE issue_id IN (
     SELECT id FROM (
       SELECT id FROM issues WHERE project_id IS NULL OR project_id <> ?
     ) t
   )`,
  [keep.id],
);
await connection.query(
  `DELETE FROM comments
   WHERE issue_id IN (
     SELECT id FROM (
       SELECT id FROM issues WHERE project_id IS NULL OR project_id <> ?
     ) t
   )`,
  [keep.id],
);
await connection.query(
  `DELETE FROM issue_activities
   WHERE issue_id IN (
     SELECT id FROM (
       SELECT id FROM issues WHERE project_id IS NULL OR project_id <> ?
     ) t
   )`,
  [keep.id],
);
await connection.query(
  `DELETE FROM issue_members
   WHERE issue_id IN (
     SELECT id FROM (
       SELECT id FROM issues WHERE project_id IS NULL OR project_id <> ?
     ) t
   )`,
  [keep.id],
);
await connection.query(
  `DELETE FROM issues WHERE project_id IS NULL OR project_id <> ?`,
  [keep.id],
);

// Other projects
await connection.query(`DELETE FROM projects WHERE id <> ?`, [keep.id]);

// Orphans (in case FK checks were off and CASCADE did not run)
await connection.query(`DELETE FROM tasks WHERE project_id <> ?`, [keep.id]);
await connection.query(`DELETE FROM weekly_plans WHERE project_id <> ?`, [keep.id]);
await connection.query(`DELETE FROM project_members WHERE project_id <> ?`, [keep.id]);
await connection.query(`DELETE FROM project_message_attachments WHERE project_id <> ?`, [keep.id]).catch(() => {});
await connection.query(`DELETE FROM project_messages WHERE project_id <> ?`, [keep.id]).catch(() => {});

// Ephemeral / operational clutter (does not touch keep-project / users / companies / permissions)
const ephemeral = [
  "notifications",
  "invitations",
  "outbox_events",
  "audit_logs",
  "email_verification_tokens",
  "password_reset_tokens",
];
const [tables] = await connection.query(
  `SELECT TABLE_NAME AS name
   FROM information_schema.TABLES
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'`,
);
const existing = new Set(tables.map((row) => row.name));
for (const name of ephemeral) {
  if (!existing.has(name)) continue;
  await connection.query(`TRUNCATE TABLE \`${name}\``);
  console.log(`truncate=${name}`);
}

await connection.query("SET FOREIGN_KEY_CHECKS = 1");

const [afterProjects] = await connection.query(
  `SELECT id, code, name, status FROM projects ORDER BY id`,
);
const [[taskCount]] = await connection.query(
  `SELECT COUNT(*) AS n FROM tasks WHERE project_id = ?`,
  [keep.id],
);
const [[planCount]] = await connection.query(
  `SELECT COUNT(*) AS n FROM weekly_plans WHERE project_id = ?`,
  [keep.id],
);
const [[memberCount]] = await connection.query(
  `SELECT COUNT(*) AS n FROM project_members WHERE project_id = ?`,
  [keep.id],
);
const [[issueCount]] = await connection.query(
  `SELECT COUNT(*) AS n FROM issues WHERE project_id = ?`,
  [keep.id],
);
const [[allIssues]] = await connection.query(`SELECT COUNT(*) AS n FROM issues`);
const [[allTasks]] = await connection.query(`SELECT COUNT(*) AS n FROM tasks`);
const [[allProjects]] = await connection.query(`SELECT COUNT(*) AS n FROM projects`);

console.log("after.projects=", afterProjects);
console.log("kept.tasks=", taskCount.n);
console.log("kept.plans=", planCount.n);
console.log("kept.members=", memberCount.n);
console.log("kept.issues=", issueCount.n);
console.log(`totals projects=${allProjects.n} issues=${allIssues.n} tasks=${allTasks.n}`);

await connection.end();
console.log("done");
