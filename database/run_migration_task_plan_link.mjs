import mysql from "mysql2/promise";
import dotenv from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, "../.env") });

const connection = await mysql.createConnection({
  host: process.env.DB_HOST || "localhost",
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "lfbsmart_project",
  port: Number(process.env.DB_PORT || 3306),
});

try {
  const [columns] = await connection.query(
    "SHOW COLUMNS FROM tasks LIKE 'plan_id'"
  );
  if (columns.length === 0) {
    await connection.query(
      "ALTER TABLE tasks ADD COLUMN plan_id INT UNSIGNED NULL AFTER issue_id"
    );
    console.log("Added plan_id column to tasks table");
  } else {
    console.log("plan_id column already exists in tasks table");
  }

  const [indexes] = await connection.query(
    "SHOW INDEX FROM tasks WHERE Key_name = 'idx_tasks_plan'"
  );
  if (indexes.length === 0) {
    await connection.query("CREATE INDEX idx_tasks_plan ON tasks(plan_id)");
    console.log("Created index idx_tasks_plan");
  }

  // Check foreign key constraint
  const [fks] = await connection.query(
    `SELECT CONSTRAINT_NAME FROM information_schema.KEY_COLUMN_USAGE 
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tasks' AND CONSTRAINT_NAME = 'fk_tasks_plan'`
  );
  if (fks.length === 0) {
    try {
      await connection.query(
        "ALTER TABLE tasks ADD CONSTRAINT fk_tasks_plan FOREIGN KEY (plan_id) REFERENCES weekly_plans(id) ON DELETE SET NULL"
      );
      console.log("Added foreign key fk_tasks_plan");
    } catch (err) {
      console.warn("Could not add fk_tasks_plan constraint:", err.message);
    }
  }

  console.log("Migration migration_task_plan_link completed successfully!");
} catch (error) {
  console.error("Migration error:", error);
} finally {
  await connection.end();
}
