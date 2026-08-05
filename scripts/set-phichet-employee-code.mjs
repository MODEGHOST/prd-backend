import mysql from "mysql2/promise";
import { config as loadEnv } from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.join(__dirname, "../.env") });

const NEW_CODE = "24570241";
const USER_ID = 2;
const shared = process.env.SHARED_DB_NAME || "shared_auth";
const center = process.env.CENTER_USER_TABLE || "Center_user_lfb";
const centerFq = `\`${shared}\`.\`${center}\``;

const conn = await mysql.createConnection({
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "lfbsmart_project",
});

const [[dup]] = await conn.query(
  `SELECT id, first_name, username FROM ${centerFq} WHERE username = ? AND id <> ?`,
  [NEW_CODE, USER_ID],
);
if (dup) {
  console.error("CODE_IN_USE", dup);
  process.exit(1);
}

await conn.beginTransaction();
try {
  await conn.query(`UPDATE ${centerFq} SET username = ? WHERE id = ?`, [NEW_CODE, USER_ID]);
  await conn.query("UPDATE users SET username = ? WHERE id = ?", [NEW_CODE, USER_ID]);
  await conn.query(
    "UPDATE company_memberships SET employee_code = ? WHERE user_id = ?",
    [NEW_CODE, USER_ID],
  );
  await conn.commit();
} catch (error) {
  await conn.rollback();
  throw error;
}

const [[user]] = await conn.query(
  "SELECT id, name, username FROM users WHERE id = ?",
  [USER_ID],
);
const [[centerRow]] = await conn.query(
  `SELECT id, first_name, last_name, username FROM ${centerFq} WHERE id = ?`,
  [USER_ID],
);
const [memberships] = await conn.query(
  "SELECT company_id, employee_code, status FROM company_memberships WHERE user_id = ?",
  [USER_ID],
);

console.log({ user, center: centerRow, memberships });
await conn.end();
