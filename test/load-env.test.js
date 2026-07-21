import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnv } from "../src/core/load-env.js";

function withCleanEnv(keys, run) {
  const previous = {};
  for (const key of keys) {
    previous[key] = process.env[key];
    delete process.env[key];
  }
  try {
    return run();
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

test("local .env wins when both env files exist", () => {
  const dir = mkdtempSync(join(tmpdir(), "projecthub-env-"));
  writeFileSync(join(dir, ".env"), "NODE_ENV=development\nPORT=4000\nFRONTEND_URL=http://localhost:5173\n");
  writeFileSync(
    join(dir, ".env.production"),
    "NODE_ENV=production\nPORT=4001\nFRONTEND_URL=https://project.lfbsmart.com\n",
  );

  withCleanEnv(["NODE_ENV", "PORT", "FRONTEND_URL", "USE_PRODUCTION_ENV"], () => {
    loadEnv(dir);
    assert.equal(process.env.NODE_ENV, "development");
    assert.equal(process.env.PORT, "4000");
    assert.equal(process.env.FRONTEND_URL, "http://localhost:5173");
  });

  rmSync(dir, { recursive: true, force: true });
});

test("server uses .env.production when .env is absent", () => {
  const dir = mkdtempSync(join(tmpdir(), "projecthub-env-"));
  writeFileSync(
    join(dir, ".env.production"),
    "NODE_ENV=production\nPORT=4001\nFRONTEND_URL=https://project.lfbsmart.com\n",
  );

  withCleanEnv(["NODE_ENV", "PORT", "FRONTEND_URL", "USE_PRODUCTION_ENV"], () => {
    loadEnv(dir);
    assert.equal(process.env.NODE_ENV, "production");
    assert.equal(process.env.PORT, "4001");
    assert.equal(process.env.FRONTEND_URL, "https://project.lfbsmart.com");
  });

  rmSync(dir, { recursive: true, force: true });
});
