export function createNotificationService({
  pool,
  logger,
  enqueueOutbox,
  getIssueRecipientIds,
  getProjectRecipientIds,
}) {
  async function persistNotification(userId, title, message, metadata = {}) {
    if (!userId) return;
    const {
      type = "general",
      targetUrl = null,
      entityType = null,
      entityId = null,
      actorName = null,
      actorId = null,
      companyId: requestedCompanyId = null,
    } = metadata;
    if (actorId != null && Number(userId) === Number(actorId)) return;
    let companyId = Number(requestedCompanyId || 0);
    if (!companyId && entityType === "project" && entityId) {
      const [[project]] = await pool.execute("SELECT company_id FROM projects WHERE id = ?", [entityId]);
      companyId = Number(project?.company_id || 0);
    }
    if (!companyId && entityType === "issue" && entityId) {
      const [[issue]] = await pool.execute("SELECT company_id FROM issues WHERE id = ?", [entityId]);
      companyId = Number(issue?.company_id || 0);
    }
    if (!companyId) return;
    const [[recipient]] = await pool.execute(
      `SELECT cm.id, GROUP_CONCAT(DISTINCT r.name) role_names
       FROM company_memberships cm
       LEFT JOIN membership_roles mr ON mr.membership_id = cm.id
       LEFT JOIN roles r ON r.id = mr.role_id
       WHERE cm.company_id = ? AND cm.user_id = ? AND cm.status = 'active'
       GROUP BY cm.id`,
      [companyId, userId],
    );
    if (!recipient) return;
    const recipientRoles = String(recipient.role_names || "").split(",").filter(Boolean);
    if (entityType === "project"
        && recipientRoles.length
        && recipientRoles.every((role) => role === "requester")) return;
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [result] = await connection.execute(
        `INSERT INTO notifications
          (company_id, user_id, title, message, type, target_url, entity_type, entity_id, actor_name)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [companyId, userId, title, message, type, targetUrl, entityType, entityId, actorName],
      );
      const payload = {
        id: result.insertId,
        title,
        message,
        type,
        target_url: targetUrl,
        entity_type: entityType,
        entity_id: entityId,
        actor_name: actorName,
        actor_id: actorId,
        company_id: companyId,
        created_at: new Date().toISOString(),
      };
      await enqueueOutbox(connection, {
        companyId,
        eventType: "notification.emit",
        aggregateType: "notification",
        aggregateId: result.insertId,
        dedupeKey: `notification.emit:${result.insertId}`,
        payload: {
          room: `company:${companyId}:user:${userId}`,
          event: "notification",
          data: payload,
        },
      });
      await connection.commit();
      return payload;
    } catch (error) {
      await connection.rollback();
      logger.error("notification.persist_failed", error, {
        companyId,
        userId,
        entityType,
        entityId,
      });
      return null;
    } finally {
      connection.release();
    }
  }

  async function notify(userId, title, message, metadata = {}) {
    try {
      return await persistNotification(userId, title, message, metadata);
    } catch (error) {
      logger.error("notification.enqueue_failed", error, {
        userId,
        entityType: metadata.entityType,
        entityId: metadata.entityId,
      });
      return null;
    }
  }

  const backgroundJobs = new Set();

  function trackBackgroundJob(promise) {
    const job = Promise.resolve(promise);
    backgroundJobs.add(job);
    job.finally(() => backgroundJobs.delete(job));
    return job;
  }

  async function drainBackgroundJobs() {
    while (backgroundJobs.size) {
      await Promise.allSettled([...backgroundJobs]);
    }
  }

  function notifyLater(userIds, title, message, metadata = {}) {
    const uniqueIds = [...new Set(
      (userIds || [])
        .map(Number)
        .filter((id) => Number.isInteger(id) && id > 0),
    )];
    if (!uniqueIds.length) return Promise.resolve();
    return trackBackgroundJob(Promise.all(
      uniqueIds.map((userId) => notify(userId, title, message, metadata)),
    ).catch((error) => logger.error("notification.batch_failed", error)));
  }

  async function notifyIssueRecipients(issueId, actorId, title, message, metadata = {}) {
    const recipientIds = await getIssueRecipientIds(issueId);
    const targets = recipientIds.filter((userId) => userId !== Number(actorId));
    await Promise.all(
      targets.map((userId) => notify(userId, title, message, {
        targetUrl: `/issues?issue=${issueId}`,
        entityType: "issue",
        entityId: Number(issueId),
        actorId: actorId != null ? Number(actorId) : null,
        ...metadata,
      })),
    );
  }

  async function notifyProjectRecipients(projectId, actorId, title, message, metadata = {}) {
    const recipientIds = await getProjectRecipientIds(projectId);
    const targets = recipientIds.filter((userId) => userId !== Number(actorId));
    await Promise.all(
      targets.map((userId) => notify(userId, title, message, {
        targetUrl: `/projects/${projectId}`,
        entityType: "project",
        entityId: Number(projectId),
        actorId: actorId != null ? Number(actorId) : null,
        ...metadata,
      })),
    );
  }

  function notifyIssueRecipientsLater(issueId, actorId, title, message, metadata = {}) {
    getIssueRecipientIds(issueId)
      .then((recipientIds) => {
        notifyLater(
          recipientIds.filter((userId) => userId !== Number(actorId)),
          title,
          message,
          {
            targetUrl: `/issues?issue=${issueId}`,
            entityType: "issue",
            entityId: Number(issueId),
            actorId: actorId != null ? Number(actorId) : null,
            ...metadata,
          },
        );
      })
      .catch((err) => console.error("issue recipients lookup failed", err));
  }

  function notifyProjectRecipientsLater(projectId, actorId, title, message, metadata = {}) {
    getProjectRecipientIds(projectId)
      .then((recipientIds) => {
        notifyLater(
          recipientIds.filter((userId) => userId !== Number(actorId)),
          title,
          message,
          {
            targetUrl: `/projects/${projectId}`,
            entityType: "project",
            entityId: Number(projectId),
            actorId: actorId != null ? Number(actorId) : null,
            ...metadata,
          },
        );
      })
      .catch((err) => console.error("project recipients lookup failed", err));
  }

  return {
    drainBackgroundJobs,
    notify,
    notifyIssueRecipients,
    notifyIssueRecipientsLater,
    notifyLater,
    notifyProjectRecipients,
    notifyProjectRecipientsLater,
  };
}
