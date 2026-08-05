import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/core/config.js";

test("development config provides local-safe defaults", () => {
  const config = loadConfig({});
  assert.equal(config.port, 4000);
  assert.equal(config.db.database, "lfbsmart_project");
  assert.equal(config.db.connectionLimit, 30);
  assert.equal(config.production, false);
  assert.equal(config.smtp.host, "smtp.gmail.com");
  assert.equal(config.smtp.port, 587);
  assert.equal(config.smtp.configured, false);
});

test("production rejects weak or missing JWT secret", () => {
  assert.throws(
    () => loadConfig({
      NODE_ENV: "production",
      JWT_SECRET: "short",
      SMTP_USER: "noreply@gmail.com",
      SMTP_PASS: "app-password",
      EMAIL_FROM: "ProjectHub <noreply@gmail.com>",
    }),
    /JWT_SECRET/,
  );
});

test("production requires transactional email configuration", () => {
  assert.throws(
    () => loadConfig({
      NODE_ENV: "production",
      JWT_SECRET: "a".repeat(48),
      EMAIL_FROM: "ProjectHub <noreply@gmail.com>",
    }),
    /SMTP_USER and SMTP_PASS/,
  );
});

test("production may omit SMTP when ALLOW_MISSING_SMTP=1", () => {
  const config = loadConfig({
    NODE_ENV: "production",
    JWT_SECRET: "a".repeat(48),
    EMAIL_FROM: "ProjectHub <noreply@lfbsmart.com>",
    DB_PASSWORD: "secret",
    ALLOW_MISSING_SMTP: "1",
    SEED_DEMO_DATA: "0",
  });
  assert.equal(config.production, true);
  assert.equal(config.smtp.configured, false);
});

test("production rejects an empty database password", () => {
  assert.throws(
    () => loadConfig({
      NODE_ENV: "production",
      JWT_SECRET: "a".repeat(48),
      SMTP_USER: "noreply@gmail.com",
      SMTP_PASS: "app-password",
      EMAIL_FROM: "ProjectHub <noreply@gmail.com>",
    }),
    /DB_PASSWORD/,
  );
});

test("numeric configuration rejects invalid pool sizes", () => {
  assert.throws(() => loadConfig({ DB_POOL_LIMIT: "0" }), /DB_POOL_LIMIT/);
  assert.throws(() => loadConfig({ DB_PORT: "invalid" }), /DB_PORT/);
  assert.throws(() => loadConfig({ SMTP_PORT: "65536" }), /SMTP_PORT/);
});

test("configuration rejects ambiguous environments and malformed endpoints", () => {
  assert.throws(() => loadConfig({ NODE_ENV: "prod" }), /NODE_ENV/);
  assert.throws(() => loadConfig({ FRONTEND_URL: "ftp://example.test" }), /FRONTEND_URL/);
  assert.throws(() => loadConfig({ REDIS_URL: "https://example.test" }), /REDIS_URL/);
  assert.throws(() => loadConfig({ AUTH_TOKEN_TTL: "forever" }), /AUTH_TOKEN_TTL/);
  assert.throws(() => loadConfig({ EMAIL_FROM: "not-an-email" }), /EMAIL_FROM/);
});

test("configuration accepts supported Redis and token formats", () => {
  const config = loadConfig({
    REDIS_URL: "rediss://cache.example.test:6380",
    AUTH_TOKEN_TTL: "30m",
  });
  assert.equal(config.redisUrl, "rediss://cache.example.test:6380");
  assert.equal(config.authTokenTtl, "30m");
});

test("production never permits demo credential seeding", () => {
  assert.throws(
    () => loadConfig({
      NODE_ENV: "production",
      JWT_SECRET: "a".repeat(48),
      SMTP_USER: "noreply@gmail.com",
      SMTP_PASS: "app-password",
      EMAIL_FROM: "ProjectHub <noreply@gmail.com>",
      DB_PASSWORD: "strong-database-password",
      SEED_DEMO_DATA: "1",
    }),
    /SEED_DEMO_DATA/,
  );
});
