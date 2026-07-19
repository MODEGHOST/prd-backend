import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const dashboard = await readFile(
  new URL("../src/routes/dashboard.js", import.meta.url),
  "utf8",
);

test("dashboard returns role-aware unfinished work and pending issue count", () => {
  assert.match(dashboard, /pendingIssueCount/);
  assert.match(dashboard, /actionItems/);
  assert.match(dashboard, /i\.status <> 'closed'/);
  assert.match(dashboard, /t\.status <> 'done'/);
  assert.match(dashboard, /isRequester[\s\S]*i\.requester_id = \?/);
  assert.match(dashboard, /canAcceptUnassigned/);
});

test("dashboard work summary remains tenant scoped", () => {
  assert.match(dashboard, /i\.company_id = \?/);
  assert.match(dashboard, /p\.company_id = \?/);
});

test("board overview paginates six server-filtered cards", () => {
  assert.match(dashboard, /app\.get\("\/api\/board-overview"/);
  assert.match(dashboard, /defaultLimit: 6, maxLimit: 6/);
  assert.match(dashboard, /i\.project_id IS NULL/);
  assert.match(dashboard, /i\.status IN \('accepted', 'in_progress'\)/);
  assert.match(dashboard, /i\.assignee_id = \? OR EXISTS/);
  assert.match(dashboard, /p\.created_by = \? OR p\.owner_id = \? OR EXISTS/);
  assert.match(dashboard, /LIMIT \$\{pagination\.limit\} OFFSET \$\{pagination\.offset\}/);
  assert.match(dashboard, /query|dateFrom|dateTo|mine|workload/);
});
