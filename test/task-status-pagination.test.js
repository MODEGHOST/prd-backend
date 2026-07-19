import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const tasks = await readFile(new URL("../src/routes/tasks.js", import.meta.url), "utf8");

test("task lists support validated status pagination", () => {
  assert.match(tasks, /req\.query\.status/);
  assert.match(tasks, /\["todo", "doing", "review", "done"\]/);
  assert.match(tasks, /filter \+= " AND t\.status = \?"/);
  assert.match(tasks, /LIMIT \$\{pagination\.limit\} OFFSET \$\{pagination\.offset\}/);
});
