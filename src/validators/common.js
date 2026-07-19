/** Validated page/limit for list endpoints (avoids unbounded payloads). */
export function parsePagination(req, { defaultLimit = 50, maxLimit = 200 } = {}) {
  const page = Math.max(1, Number.parseInt(String(req.query.page || "1"), 10) || 1);
  let limit = Number.parseInt(String(req.query.limit ?? ""), 10);
  if (!Number.isInteger(limit) || limit <= 0) limit = defaultLimit;
  limit = Math.min(limit, maxLimit);
  const offset = (page - 1) * limit;
  return { page, limit, offset };
}

export function paginatedJson(res, items, total, { page, limit }) {
  res.json({
    items,
    total: Number(total) || 0,
    page,
    limit,
    hasMore: page * limit < Number(total),
  });
}

export function toDateOnly(value) {
  if (!value) return null;
  if (value instanceof Date) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
  return String(value).slice(0, 10);
}

export function normalizeCurrency(value) {
  if (value === undefined || value === null || value === "") return "THB";
  const currency = String(value).trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) return null;
  return currency;
}

export function normalizeBudget(value) {
  if (value === undefined || value === null || value === "") return 0;
  const budget = Number(value);
  if (!Number.isFinite(budget) || budget < 0) return null;
  return Math.round(budget * 100) / 100;
}

export function uniquePositiveIds(ids = []) {
  return [...new Set((Array.isArray(ids) ? ids : [])
    .map(Number)
    .filter((id) => Number.isInteger(id) && id > 0))];
}
