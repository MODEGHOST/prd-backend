import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const routes = await readFile(
  new URL("../src/routes/issues.js", import.meta.url),
  "utf8",
);
const migration = await readFile(
  new URL("../database/migration_p5_issue_request_control.sql", import.meta.url),
  "utf8",
);

test("requester edit and cancel lock the issue before checking ownership and state", () => {
  const updateRoute = routes.slice(
    routes.indexOf('app.patch("/api/issues/:id"'),
    routes.indexOf('app.post("/api/issues/:id/cancel"'),
  );
  const cancelRoute = routes.slice(
    routes.indexOf('app.post("/api/issues/:id/cancel"'),
    routes.indexOf('app.post("/api/issues/:id/reject"'),
  );

  for (const source of [updateRoute, cancelRoute]) {
    assert.match(source, /FOR UPDATE/);
    assert.match(source, /requester_id/);
    assert.match(source, /status !== "open"/);
    assert.match(source, /assignee_id/);
  }
});

test("reject requires an allowed staff role, reason, and unaccepted issue", () => {
  const rejectRoute = routes.slice(
    routes.indexOf('app.post("/api/issues/:id/reject"'),
    routes.indexOf('app.post("/api/issues/:id/board-status"'),
  );

  assert.match(rejectRoute, /canRejectIssues/);
  assert.match(rejectRoute, /กรุณาระบุเหตุผล/);
  assert.match(rejectRoute, /FOR UPDATE/);
  assert.match(rejectRoute, /status !== "open"/);
  assert.match(rejectRoute, /rejection_reason/);
  assert.match(rejectRoute, /rejected_by/);
});

test("migration adds terminal states and requester update permission", () => {
  assert.match(migration, /'cancelled'/);
  assert.match(migration, /'rejected'/);
  assert.match(migration, /rejection_reason TEXT/);
  assert.match(migration, /p\.code = 'issues\.update'/);
  assert.match(migration, /r\.name = 'requester'/);
});
