export function registerNotificationRoutes(app, deps) {
  const {
    auth,
    isRequesterPersona,
    parsePagination,
    pool,
    wrap,
  } = deps;

  app.get("/api/notifications", auth, wrap(async (req, res) => {
    const pagination = parsePagination(req, { defaultLimit: 50, maxLimit: 200 });
    const requesterFilter = isRequesterPersona(req.user)
      ? "AND (entity_type IS NULL OR entity_type <> 'project')"
      : "";
    const [[summary]] = await pool.execute(
      `SELECT COUNT(*) total, COALESCE(SUM(is_read = FALSE), 0) unread_total
       FROM notifications
       WHERE user_id = ? AND company_id = ? ${requesterFilter}`,
      [req.user.id, req.user.companyId],
    );
    const [rows] = await pool.execute(
      `SELECT id, user_id, title, message, type, target_url, entity_type, entity_id,
              actor_name, is_read, created_at
       FROM notifications
       WHERE user_id = ? AND company_id = ? ${requesterFilter}
       ORDER BY created_at DESC, id DESC
       LIMIT ${pagination.limit} OFFSET ${pagination.offset}`,
      [req.user.id, req.user.companyId],
    );
    res.json({
      items: rows,
      total: Number(summary.total || 0),
      unreadTotal: Number(summary.unread_total || 0),
      page: pagination.page,
      limit: pagination.limit,
      hasMore: pagination.page * pagination.limit < Number(summary.total || 0),
    });
  }));

  app.patch("/api/notifications/:id/read", auth, wrap(async (req, res) => {
    await pool.execute(
      `UPDATE notifications SET is_read = TRUE
       WHERE id = ? AND user_id = ? AND company_id = ?`,
      [req.params.id, req.user.id, req.user.companyId],
    );
    res.json({ message: "อ่านการแจ้งเตือนแล้ว" });
  }));

  app.patch("/api/notifications/read", auth, wrap(async (req, res) => {
    await pool.execute(
      "UPDATE notifications SET is_read = TRUE WHERE user_id = ? AND company_id = ?",
      [req.user.id, req.user.companyId],
    );
    res.json({ message: "อ่านการแจ้งเตือนทั้งหมดแล้ว" });
  }));
}
