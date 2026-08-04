import mysql from "mysql2/promise";
import dotenv from "dotenv";

dotenv.config();

async function migrate() {
  const dbName = process.env.DB_NAME || "lfbsmart_project";
  console.log(`Migrating project status ENUM on database ${dbName}...`);

  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || "localhost",
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "",
    database: dbName,
  });

  try {
    await conn.execute(
      "ALTER TABLE projects MODIFY COLUMN status ENUM('pending','active','on_hold','completed','rejected','cancelled','inactive') DEFAULT 'pending'"
    );
    console.log("✅ ALTER TABLE projects MODIFY COLUMN status succeeded.");

    // Update any projects with empty status or id = 1 to inactive
    const [res] = await conn.execute("UPDATE projects SET status = 'inactive' WHERE id = 1 OR status = ''");
    console.log(`✅ Updated ${res.affectedRows} projects with inactive status.`);

    const [rows] = await conn.execute("SELECT id, name, code, status FROM projects");
    console.log("Current Projects:", JSON.stringify(rows, null, 2));
  } catch (err) {
    console.error("❌ Migration error:", err);
  } finally {
    await conn.end();
  }
}

migrate();
