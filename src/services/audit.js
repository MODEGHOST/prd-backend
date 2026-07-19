export function createAuditService(pool) {
  return async function audit(
    req,
    action,
    entityType = null,
    entityId = null,
    metadata = null,
    executor = pool,
  ) {
    await executor.execute(
      `INSERT INTO audit_logs
        (company_id, actor_user_id, action, entity_type, entity_id, metadata_json, ip_address)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        req.user?.companyId || null,
        req.user?.id || null,
        action,
        entityType,
        entityId == null ? null : String(entityId),
        metadata == null ? null : JSON.stringify(metadata),
        req.ip || null,
      ],
    );
  };
}
