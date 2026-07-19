import bcrypt from "bcryptjs";
import { createApplication } from "./app.js";
import { config } from "./core/config.js";
import { logger } from "./core/logger.js";
import { startOutboxWorker } from "./core/outbox.js";
import { configureRealtimeScale } from "./core/realtime.js";

const {
  app,
  authRateCleanupTimer,
  drainBackgroundJobs,
  io,
  pool,
  sendEmail,
  server,
  setReady,
} = createApplication();

async function seed() {
  if (!config.seedDemoData) return;
  const [[{ count }]] = await pool.query("SELECT COUNT(*) count FROM users");
  if (Number(count) > 0) return;
  const passwordHash = await bcrypt.hash("Password123!", 10);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(
      `INSERT INTO users
        (name, first_name, last_name, email, password_hash, role, department,
         status, email_verified_at)
       VALUES
        ('ผู้ดูแลระบบ', 'ผู้ดูแลระบบ', '', 'admin@projecthub.local', ?, 'admin', 'IT', 'active', NOW()),
        ('นักพัฒนาระบบ', 'นักพัฒนาระบบ', '', 'developer@projecthub.local', ?, 'member', 'Development', 'active', NOW()),
        ('พนักงานทั่วไป', 'พนักงานทั่วไป', '', 'requester@projecthub.local', ?, 'requester', 'Operations', 'active', NOW())`,
      [passwordHash, passwordHash, passwordHash],
    );
    const [[company]] = await conn.execute(
      "SELECT id FROM companies WHERE slug = 'default-company'",
    );
    const [users] = await conn.query("SELECT id, role FROM users");
    for (const user of users) {
      const [membership] = await conn.execute(
        `INSERT INTO company_memberships
          (company_id, user_id, employee_code, status, approved_at)
         VALUES (?, ?, ?, 'active', NOW())`,
        [company.id, user.id, `SEED-${user.id}`],
      );
      const roleName = user.role === "admin"
        ? "group_admin"
        : user.role === "member" ? "dev" : "requester";
      const [[role]] = await conn.execute("SELECT id FROM roles WHERE name = ?", [roleName]);
      await conn.execute(
        "INSERT INTO membership_roles (membership_id, role_id) VALUES (?, ?)",
        [membership.insertId, role.id],
      );
    }
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

let closeRealtime = async () => {};
let stopOutbox = async () => {};

seed()
  .then(async () => {
    await pool.query("SELECT 1");
    closeRealtime = await configureRealtimeScale(io, config.redisUrl, logger);
    stopOutbox = startOutboxWorker({
      pool,
      logger,
      pollIntervalMs: config.production ? 500 : 200,
      handlers: {
        "notification.emit": async ({ payload }) => {
          io.to(payload.room).emit(payload.event, payload.data);
        },
        "email.send": async ({ payload }) => {
          await sendEmail(payload);
        },
      },
    });
    server.listen(config.port, () => {
      setReady(true);
      logger.info("server.started", {
        port: config.port,
        environment: config.nodeEnv,
        redisEnabled: Boolean(config.redisUrl),
      });
    });
  })
  .catch((error) => {
    logger.error("server.start_failed", error);
    process.exit(1);
  });

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  setReady(false);
  clearInterval(authRateCleanupTimer);
  logger.info("server.shutdown_started", { signal });
  const forceTimer = setTimeout(() => {
    logger.error("server.shutdown_forced", new Error("graceful shutdown timed out"));
    process.exit(1);
  }, 10_000);
  forceTimer.unref();
  io.disconnectSockets(true);
  server.close(async (error) => {
    try {
      await drainBackgroundJobs();
      await stopOutbox();
      await closeRealtime();
      await pool.end();
    } catch (closeError) {
      logger.error("server.resource_close_failed", closeError);
      process.exitCode = 1;
    }
    clearTimeout(forceTimer);
    if (error) {
      logger.error("server.close_failed", error);
      process.exitCode = 1;
    } else {
      logger.info("server.shutdown_completed", { signal });
    }
    process.exit(process.exitCode || 0);
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("uncaughtException", (error) => {
  logger.error("process.uncaught_exception", error);
  shutdown("uncaughtException");
});
process.on("unhandledRejection", (reason) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  logger.error("process.unhandled_rejection", error);
  shutdown("unhandledRejection");
});

export { app, io, pool, server };
