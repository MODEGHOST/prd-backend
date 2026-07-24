import mysql from "mysql2/promise";
import { readFileSync } from "fs";

const connection = await mysql.createConnection({
  host: "localhost",
  user: "root",
  password: "",
  database: "lfbsmart_project",
  multipleStatements: true,
});

const sql = readFileSync(new URL("./migration_project_no_approval.sql", import.meta.url), "utf8")
  .replace(/USE lfbsmart_project;\s*/i, "");

const [result] = await connection.query(sql);
console.log(`activated=${result.affectedRows ?? result?.[0]?.affectedRows ?? "ok"}`);
await connection.end();
