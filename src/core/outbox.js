import { randomUUID } from "node:crypto";

export async function enqueueOutbox(executor, event) {
  const payload = JSON.stringify(event.payload ?? {});
  const [result] = await executor.execute(
    `INSERT INTO outbox_events
      (company_id, event_type, aggregate_type, aggregate_id, dedupe_key, payload_json)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`,
    [
      event.companyId,
      event.eventType,
      event.aggregateType || null,
      event.aggregateId == null ? null : String(event.aggregateId),
      event.dedupeKey || null,
      payload,
    ],
  );
  return Number(result.insertId);
}

export function startOutboxWorker({
  pool,
  handlers,
  logger,
  pollIntervalMs = 750,
  batchSize = 25,
  recoveryIntervalMs = 60_000,
  cleanupIntervalMs = 6 * 60 * 60 * 1000,
}) {
  const workerId = randomUUID();
  let timer;
  let maintenanceTimer;
  let stopping = false;
  let inFlight = null;
  let maintenanceRun = null;
  let lastCleanupAt = Date.now();

  async function markFailed(event, error) {
    const retrySeconds = Math.min(300, 2 ** Math.min(Number(event.attempts), 8));
    const availableAt = new Date(Date.now() + retrySeconds * 1000);
    await pool.execute(
      `UPDATE outbox_events
       SET status = IF(attempts >= 10, 'failed', 'pending'),
           available_at = ?, locked_by = NULL, locked_at = NULL,
           last_error = ?
       WHERE id = ? AND locked_by = ?`,
      [availableAt, String(error?.message || error).slice(0, 1000), event.id, workerId],
    );
  }

  async function processBatch() {
    try {
      await pool.execute(
        `UPDATE outbox_events
         SET status = 'processing', locked_by = ?, locked_at = NOW(),
             attempts = attempts + 1
         WHERE status = 'pending' AND available_at <= NOW()
         ORDER BY id
         LIMIT ${Number(batchSize)}`,
        [workerId],
      );
      const [events] = await pool.execute(
        `SELECT id, company_id, event_type, payload_json, attempts
         FROM outbox_events
         WHERE status = 'processing' AND locked_by = ?
         ORDER BY id`,
        [workerId],
      );
      for (const event of events) {
        try {
          const handler = handlers[event.event_type];
          if (!handler) throw new Error(`No outbox handler for ${event.event_type}`);
          await handler({
            ...event,
            payload: JSON.parse(event.payload_json),
          });
          await pool.execute(
            `UPDATE outbox_events
             SET status = 'done', processed_at = NOW(), locked_by = NULL,
                 locked_at = NULL, last_error = NULL,
                 payload_json = IF(event_type = 'email.send', '{}', payload_json)
             WHERE id = ? AND locked_by = ?`,
            [event.id, workerId],
          );
        } catch (error) {
          logger.error("outbox.event_failed", error, {
            eventId: event.id,
            eventType: event.event_type,
            attempts: event.attempts,
          });
          await markFailed(event, error);
        }
      }
    } catch (error) {
      logger.error("outbox.batch_failed", error, { workerId });
    }
  }

  async function recoverStaleEvents() {
    await pool.execute(
      `UPDATE outbox_events
       SET status = 'pending', locked_by = NULL, locked_at = NULL
       WHERE status = 'processing' AND locked_at < DATE_SUB(NOW(), INTERVAL 5 MINUTE)`,
    );
  }

  function triggerBatch() {
    if (stopping || inFlight) return inFlight || Promise.resolve();
    inFlight = processBatch().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  function triggerMaintenance() {
    if (stopping || maintenanceRun) return maintenanceRun || Promise.resolve();
    maintenanceRun = (async () => {
      await recoverStaleEvents();
      if (Date.now() - lastCleanupAt >= cleanupIntervalMs) {
        await pool.execute(
          `DELETE FROM outbox_events
           WHERE status = 'done' AND processed_at < DATE_SUB(NOW(), INTERVAL 30 DAY)
           LIMIT 1000`,
        );
        lastCleanupAt = Date.now();
      }
    })()
      .catch((error) => logger.error("outbox.maintenance_failed", error))
      .finally(() => {
        maintenanceRun = null;
      });
    return maintenanceRun;
  }

  const startupRun = recoverStaleEvents()
    .catch((error) => logger.error("outbox.recovery_failed", error))
    .then(triggerBatch);
  timer = setInterval(() => {
    triggerBatch();
  }, pollIntervalMs);
  timer.unref();
  maintenanceTimer = setInterval(triggerMaintenance, recoveryIntervalMs);
  maintenanceTimer.unref();
  logger.info("outbox.worker_started", { workerId, pollIntervalMs, batchSize });

  return async () => {
    stopping = true;
    clearInterval(timer);
    clearInterval(maintenanceTimer);
    await startupRun;
    await Promise.all([inFlight, maintenanceRun].filter(Boolean));
    logger.info("outbox.worker_stopped", { workerId });
  };
}
