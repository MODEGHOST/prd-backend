import mysql from "mysql2/promise";

const KEEP_TABLES = new Set([
  "users",
  "companies",
  "company_memberships",
  "roles",
  "permissions",
  "role_permissions",
  "membership_roles",
  "schema_migrations",
]);

const connection = await mysql.createConnection({
  host: "localhost",
  user: "root",
  password: "",
  database: "lfbsmart_project",
  multipleStatements: true,
});

const [tables] = await connection.query(
  `SELECT TABLE_NAME AS name
   FROM information_schema.TABLES
   WHERE TABLE_SCHEMA = 'lfbsmart_project'
     AND TABLE_TYPE = 'BASE TABLE'
   ORDER BY TABLE_NAME`,
);

const allNames = tables.map((row) => row.name);
const clearNames = allNames.filter((name) => !KEEP_TABLES.has(name));

console.log("keep=", [...KEEP_TABLES].filter((name) => allNames.includes(name)).join(","));
console.log("clear=", clearNames.join(",") || "(none)");

await connection.query("SET FOREIGN_KEY_CHECKS = 0");

for (const name of clearNames) {
  await connection.query(`TRUNCATE TABLE \`${name}\``);
  console.log(`truncated=${name}`);
}

await connection.query("SET FOREIGN_KEY_CHECKS = 1");

const summaryTables = [
  "users",
  "companies",
  "roles",
  "permissions",
  "company_memberships",
  "projects",
  "issues",
  "tasks",
  "notifications",
];
for (const name of summaryTables) {
  if (!allNames.includes(name)) continue;
  const [[row]] = await connection.query(`SELECT COUNT(*) AS total FROM \`${name}\``);
  console.log(`count.${name}=${row.total}`);
}

await connection.end();
