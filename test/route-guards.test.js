import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";

const serverSource = await readFile(
  new URL("../src/server.js", import.meta.url),
  "utf8",
);
const appSource = await readFile(
  new URL("../src/app.js", import.meta.url),
  "utf8",
);
const routesDirectory = new URL("../src/routes/", import.meta.url);
const routeSources = await Promise.all(
  (await readdir(routesDirectory))
    .filter((name) => name.endsWith(".js"))
    .map((name) => readFile(new URL(name, routesDirectory), "utf8")),
);
const allRouteSources = [serverSource, appSource, ...routeSources].join("\n");

const guardedRoutes = [
  ['app.post("/api/projects"', 'requirePermission("projects.create")'],
  ['app.patch("/api/projects/:id"', 'requirePermission("projects.update")'],
  ['app.put("/api/projects/:id/members"', 'requirePermission("projects.members.manage")'],
  ['app.patch("/api/projects/:id/status"', 'requirePermission("projects.status.update")'],
  ['app.post("/api/projects/:id/weekly-plans"', 'requirePermission("projects.plan.manage")'],
  ['app.patch("/api/projects/:id/weekly-plans/:planId"', 'requirePermission("projects.plan.manage")'],
  ['app.post("/api/projects/:id/messages"', 'requirePermission("projects.chat")'],
  ['app.post("/api/issues"', 'requirePermission("issues.create")'],
  ['app.post("/api/issues/:id/accept"', 'requirePermission("issues.accept")'],
  ['app.post("/api/issues/:id/assign"', 'requirePermission("issues.assign")'],
  ['app.post("/api/issues/:id/convert-to-project"', 'requirePermission("projects.create")'],
  ['app.put("/api/issues/:id/members"', 'requirePermission("issues.members.manage")'],
  ['app.patch("/api/issues/:id"', 'requirePermission("issues.update")'],
  ['app.post("/api/issues/:id/cancel"', 'requirePermission("issues.update")'],
  ['app.post("/api/issues/:id/reject"', 'requirePermission("issues.accept")'],
  ['app.post("/api/issues/:id/board-status"', 'requirePermission("issues.transition")'],
  ['app.post("/api/issues/:id/workflow"', 'requirePermission("issues.transition")'],
  ['app.post("/api/issues/:id/comments"', 'requirePermission("issues.comment")'],
  ['app.post("/api/tasks"', 'requirePermission("tasks.create")'],
  ['app.patch("/api/tasks/:id"', 'requirePermission("tasks.update")'],
];

test("sensitive mutation routes declare permission middleware", () => {
  for (const [route, permission] of guardedRoutes) {
    const routeIndex = allRouteSources.indexOf(route);
    assert.notEqual(routeIndex, -1, `missing route ${route}`);
    const routeDeclaration = allRouteSources.slice(routeIndex, routeIndex + 220);
    assert.match(routeDeclaration, new RegExp(
      permission.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    ));
  }
});

test("legacy allow middleware is no longer used by routes", () => {
  assert.doesNotMatch(allRouteSources, /\ballow\("admin"/);
  assert.doesNotMatch(allRouteSources, /\ballow\("member"/);
});

test("tenant-owned list routes include active company predicates", () => {
  assert.match(allRouteSources, /WHERE p\.company_id = \?/);
  assert.match(allRouteSources, /i\.company_id = \?/);
  assert.match(allRouteSources, /notifications[\s\S]*company_id = \?/);
});
