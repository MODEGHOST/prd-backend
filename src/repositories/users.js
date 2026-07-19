export function createUserRepository(pool) {
  async function usersExist(userIds, companyId) {
    const ids = [...new Set(userIds.map(Number).filter((id) => Number.isInteger(id) && id > 0))];
    if (!ids.length) return true;
    const placeholders = ids.map(() => "?").join(",");
    const [rows] = await pool.execute(
      `SELECT DISTINCT u.id
       FROM users u
       JOIN company_memberships cm ON cm.user_id = u.id
       WHERE u.id IN (${placeholders}) AND cm.company_id = ? AND cm.status = 'active'`,
      [...ids, companyId],
    );
    return rows.length === ids.length;
  }

  return { usersExist };
}
