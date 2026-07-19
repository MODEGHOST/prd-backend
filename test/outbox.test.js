import test from "node:test";
import assert from "node:assert/strict";
import { enqueueOutbox, startOutboxWorker } from "../src/core/outbox.js";

test("outbox stores tenant context, dedupe key, and serialized payload", async () => {
  let captured;
  const executor = {
    execute: async (sql, values) => {
      captured = { sql, values };
      return [{ insertId: 42 }];
    },
  };

  const id = await enqueueOutbox(executor, {
    companyId: 7,
    eventType: "notification.emit",
    aggregateType: "notification",
    aggregateId: 99,
    dedupeKey: "notification.emit:99",
    payload: { room: "company:7:user:3", event: "notification" },
  });

  assert.equal(id, 42);
  assert.match(captured.sql, /INSERT INTO outbox_events/);
  assert.deepEqual(captured.values.slice(0, 5), [
    7,
    "notification.emit",
    "notification",
    "99",
    "notification.emit:99",
  ]);
  assert.deepEqual(JSON.parse(captured.values[5]), {
    room: "company:7:user:3",
    event: "notification",
  });
});

test("outbox worker dispatches a claimed event and marks it done", async () => {
  let served = false;
  let completed;
  const done = new Promise((resolve) => {
    completed = resolve;
  });
  const pool = {
    execute: async (sql) => {
      if (sql.includes("SELECT id, company_id")) {
        if (served) return [[]];
        served = true;
        return [[{
          id: 1,
          company_id: 7,
          event_type: "notification.emit",
          payload_json: JSON.stringify({ room: "company:7:user:3" }),
          attempts: 1,
        }]];
      }
      if (sql.includes("SET status = 'done'")) {
        completed();
      }
      return [{ affectedRows: 1 }];
    },
  };
  const logger = {
    info: () => {},
    error: (event, error) => assert.fail(`${event}: ${error?.message}`),
  };
  const stop = startOutboxWorker({
    pool,
    logger,
    pollIntervalMs: 10,
    handlers: {
      "notification.emit": async ({ payload }) => {
        assert.equal(payload.room, "company:7:user:3");
      },
    },
  });

  await Promise.race([
    done,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("worker did not dispatch event")), 500)),
  ]);
  await stop();
});

test("outbox shutdown waits for the actual in-flight handler", async () => {
  let served = false;
  let releaseHandler;
  let handlerStarted;
  const started = new Promise((resolve) => {
    handlerStarted = resolve;
  });
  const gate = new Promise((resolve) => {
    releaseHandler = resolve;
  });
  const pool = {
    execute: async (sql) => {
      if (sql.includes("SELECT id, company_id")) {
        if (served) return [[]];
        served = true;
        return [[{
          id: 2,
          company_id: 7,
          event_type: "slow.event",
          payload_json: "{}",
          attempts: 1,
        }]];
      }
      return [{ affectedRows: 1 }];
    },
  };
  const logger = { info: () => {}, error: () => {} };
  const stop = startOutboxWorker({
    pool,
    logger,
    pollIntervalMs: 5,
    handlers: {
      "slow.event": async () => {
        handlerStarted();
        await gate;
      },
    },
  });

  await started;
  let stopped = false;
  const stopping = stop().then(() => {
    stopped = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(stopped, false);
  releaseHandler();
  await stopping;
  assert.equal(stopped, true);
});

test("outbox periodically recovers stale processing events", async () => {
  let recoveries = 0;
  let recoveredAgain;
  const repeated = new Promise((resolve) => {
    recoveredAgain = resolve;
  });
  const pool = {
    execute: async (sql) => {
      if (sql.includes("locked_at <")) {
        recoveries += 1;
        if (recoveries >= 2) recoveredAgain();
      }
      if (sql.includes("SELECT id, company_id")) return [[]];
      return [{ affectedRows: 0 }];
    },
  };
  const logger = { info: () => {}, error: () => {} };
  const stop = startOutboxWorker({
    pool,
    logger,
    pollIntervalMs: 50,
    recoveryIntervalMs: 10,
    handlers: {},
  });

  await Promise.race([
    repeated,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("stale recovery did not repeat")), 500)),
  ]);
  await stop();
  assert.ok(recoveries >= 2);
});
