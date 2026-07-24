import mysql from "mysql2/promise";
import { readFileSync } from "fs";
import {
  briefToDbColumns,
  parseDescription,
  parsePrd,
} from "../src/services/project-brief.js";

const connection = await mysql.createConnection({
  host: "localhost",
  user: "root",
  password: "",
  database: "lfbsmart_project",
  multipleStatements: true,
});

const sql = readFileSync(new URL("./migration_project_brief_fields.sql", import.meta.url), "utf8")
  .replace(/USE lfbsmart_project;\s*/i, "");

await connection.query(sql);

const [rows] = await connection.query(
  `SELECT id, description, prd, objective, problem, expected_outcome,
          extra_details, main_requirements, business_rules
   FROM projects`,
);

let updated = 0;
for (const row of rows) {
  const hasStructured = Boolean(
    row.objective
    || row.problem
    || row.expected_outcome
    || row.extra_details
    || row.main_requirements
    || row.business_rules,
  );
  if (hasStructured) continue;

  const descriptionParts = parseDescription(row.description);
  const prdParts = parsePrd(row.prd);
  const brief = {
    objective: descriptionParts.objective || null,
    problem: descriptionParts.problem || null,
    expectedOutcome: descriptionParts.expectedOutcome || null,
    extraDetails: descriptionParts.extraDetails || null,
    mainRequirements: prdParts.mainRequirements || null,
    businessRules: prdParts.businessRules || null,
  };
  if (!Object.values(brief).some(Boolean)) continue;

  const columns = briefToDbColumns(brief);
  await connection.execute(
    `UPDATE projects
     SET objective = ?, problem = ?, expected_outcome = ?, extra_details = ?,
         main_requirements = ?, business_rules = ?,
         description = COALESCE(?, description),
         prd = COALESCE(?, prd)
     WHERE id = ?`,
    [
      columns.objective,
      columns.problem,
      columns.expected_outcome,
      columns.extra_details,
      columns.main_requirements,
      columns.business_rules,
      columns.description,
      columns.prd,
      row.id,
    ],
  );
  updated += 1;
}

const [cols] = await connection.query(
  `SHOW COLUMNS FROM projects
   WHERE Field IN (
     'objective','problem','expected_outcome',
     'extra_details','main_requirements','business_rules'
   )`,
);
console.log(`columns=${cols.map((col) => col.Field).join(",")}`);
console.log(`backfilled=${updated}`);
await connection.end();
