/**
 * Keep only users id=1,2 (พีรพล, พิเชฐ) in app DB + Center identity table.
 * Cleans dependent rows that would block DELETE.
 */
import mysql from "mysql2/promise";
import { config as loadEnv } from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.join(__dirname, "../.env") });

const KEEP_IDS = [1, 2];
const dbName = process.env.DB_NAME || "lfbsmart_project";
const sharedDb = process.env.SHARED_DB_NAME || "shared_auth";
const centerTable = process.env.CENTER_USER_TABLE || "Center_user_lfb";
const centerFq = `\`${sharedDb}\`.\`${centerTable}\``;

const conn = await mysql.createConnection({
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: dbName,
  multipleStatements: true,
});

function placeholders(n) {
  return Array(n).fill("?").join(", ");
}

async function tableExists(schema, name) {
  const [rows] = await conn.query(
    `SELECT 1 AS ok
     FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
     LIMIT 1`,
    [schema, name],
  );
  return rows.length > 0;
}

async function deleteWhereUserNotKept(schema, table, column) {
  if (!(await tableExists(schema, table))) {
    console.log(`skip.missing ${schema}.${table}`);
    return 0;
  }
  const [result] = await conn.query(
    `DELETE FROM \`${schema}\`.\`${table}\`
     WHERE \`${column}\` NOT IN (${placeholders(KEEP_IDS.length)})`,
    KEEP_IDS,
  );
  console.log(`delete ${schema}.${table}.${column} affected=${result.affectedRows}`);
  return result.affectedRows;
}

const [beforeUsers] = await conn.query(
  `SELECT id, name, username FROM \`${dbName}\`.users ORDER BY id`,
);
const [beforeCenter] = await conn.query(
  `SELECT id, first_name, last_name, username FROM ${centerFq} ORDER BY id`,
);
console.log("before.users=", beforeUsers);
console.log("before.center=", beforeCenter);

await conn.beginTransaction();
try {
  await conn.query("SET FOREIGN_KEY_CHECKS = 0");

  // Membership / role links first
  if (await tableExists(dbName, "membership_roles")) {
    const [result] = await conn.query(
      `DELETE FROM membership_roles
       WHERE membership_id IN (
         SELECT id FROM (
           SELECT id FROM company_memberships
           WHERE user_id NOT IN (${placeholders(KEEP_IDS.length)})
         ) t
       )`,
      KEEP_IDS,
    );
    console.log(`delete ${dbName}.membership_roles affected=${result.affectedRows}`);
  }

  await deleteWhereUserNotKept(dbName, "company_memberships", "user_id");
  await deleteWhereUserNotKept(dbName, "notifications", "user_id");
  await deleteWhereUserNotKept(dbName, "password_reset_tokens", "user_id");
  await deleteWhereUserNotKept(dbName, "email_verification_tokens", "user_id");
  await deleteWhereUserNotKept(dbName, "project_members", "user_id");
  await deleteWhereUserNotKept(dbName, "issue_members", "user_id");

  // Null out optional user refs so leftover operational rows don't block deletes
  const nullableRefs = [
    ["tasks", "assignee_id"],
    ["tasks", "created_by"],
    ["issues", "requester_id"],
    ["issues", "assignee_id"],
    ["issues", "rejected_by"],
    ["issue_activities", "actor_id"],
    ["comments", "user_id"],
    ["issue_attachments", "uploaded_by"],
    ["project_messages", "user_id"],
    ["project_message_attachments", "uploader_id"],
    ["invitations", "invited_by"],
    ["projects", "owner_id"],
    ["projects", "created_by"],
    ["projects", "approved_by"],
    ["audit_logs", "actor_id"],
  ];
  for (const [table, column] of nullableRefs) {
    if (!(await tableExists(dbName, table))) continue;
    const [cols] = await conn.query(
      `SELECT 1 AS ok FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`,
      [dbName, table, column],
    );
    if (!cols.length) continue;
    const [result] = await conn.query(
      `UPDATE \`${dbName}\`.\`${table}\`
       SET \`${column}\` = NULL
       WHERE \`${column}\` NOT IN (${placeholders(KEEP_IDS.length)})`,
      KEEP_IDS,
    );
    if (result.affectedRows) {
      console.log(`null ${dbName}.${table}.${column} affected=${result.affectedRows}`);
    }
  }

  // Re-point projects that still require owner/created_by to user 1 if needed
  if (await tableExists(dbName, "projects")) {
    await conn.query(
      `UPDATE \`${dbName}\`.projects SET owner_id = 1 WHERE owner_id IS NULL`,
    );
    await conn.query(
      `UPDATE \`${dbName}\`.projects SET created_by = 1 WHERE created_by IS NULL`,
    );
  }

  const [usersDelete] = await conn.query(
    `DELETE FROM \`${dbName}\`.users WHERE id NOT IN (${placeholders(KEEP_IDS.length)})`,
    KEEP_IDS,
  );
  console.log(`delete ${dbName}.users affected=${usersDelete.affectedRows}`);

  const [centerDelete] = await conn.query(
    `DELETE FROM ${centerFq} WHERE id NOT IN (${placeholders(KEEP_IDS.length)})`,
    KEEP_IDS,
  );
  console.log(`delete ${centerFq} affected=${centerDelete.affectedRows}`);

  await conn.query("SET FOREIGN_KEY_CHECKS = 1");
  await conn.commit();
} catch (error) {
  await conn.rollback();
  await conn.query("SET FOREIGN_KEY_CHECKS = 1").catch(() => {});
  throw error;
}

const [afterUsers] = await conn.query(
  `SELECT id, name, username FROM \`${dbName}\`.users ORDER BY id`,
);
const [afterCenter] = await conn.query(
  `SELECT id, first_name, last_name, username FROM ${centerFq} ORDER BY id`,
);
console.log("after.users=", afterUsers);
console.log("after.center=", afterCenter);

await conn.end();
