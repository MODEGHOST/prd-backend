/**
 * One-shot: set login identity (Center/users.username + memberships.employee_code)
 * to 8-digit employee codes. id=1 fixed to 24690054; others random unique.
 */
import mysql from "mysql2/promise";
import { config as loadEnv } from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.join(__dirname, "../.env") });

const FIXED = new Map([[1, "24690054"]]);

function randomCode(used) {
  for (let i = 0; i < 1000; i += 1) {
    const code = String(Math.floor(10000000 + Math.random() * 90000000));
    if (!used.has(code)) return code;
  }
  throw new Error("Could not generate unique employee code");
}

async function main() {
  const pool = await mysql.createPool({
    host: process.env.DB_HOST || "localhost",
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_NAME || "lfbsmart_project",
    multipleStatements: true,
  });
  const center = `\`${process.env.SHARED_DB_NAME || "shared_auth"}\`.\`${process.env.CENTER_USER_TABLE || "Center_user_lfb"}\``;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [users] = await conn.execute("SELECT id, username, email FROM users ORDER BY id FOR UPDATE");
    const used = new Set([...FIXED.values()]);
    const assignments = [];

    for (const user of users) {
      const id = Number(user.id);
      const code = FIXED.has(id) ? FIXED.get(id) : randomCode(used);
      used.add(code);
      assignments.push({ id, email: user.email, oldUsername: user.username, code });
    }

    for (const row of assignments) {
      await conn.execute(`UPDATE ${center} SET username = ? WHERE id = ?`, [row.code, row.id]);
      await conn.execute("UPDATE users SET username = ? WHERE id = ?", [row.code, row.id]);
      await conn.execute(
        "UPDATE company_memberships SET employee_code = ? WHERE user_id = ?",
        [row.code, row.id],
      );
    }

    await conn.commit();
    console.log(JSON.stringify(assignments, null, 2));
    console.log(`Updated ${assignments.length} users.`);
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
