export function createAuthRateLimit() {
  const authRateBuckets = new Map();
  const authRateCleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of authRateBuckets) {
      if (bucket.resetAt <= now) authRateBuckets.delete(key);
    }
  }, 15 * 60 * 1000);
  authRateCleanupTimer.unref();

  function authRateLimit({ limit = 10, windowMs = 15 * 60 * 1000 } = {}) {
    return (req, res, next) => {
      const key = `${req.ip}:${req.path}`;
      const now = Date.now();
      const current = authRateBuckets.get(key);
      if (!current || current.resetAt <= now) {
        authRateBuckets.set(key, { count: 1, resetAt: now + windowMs });
        return next();
      }
      if (current.count >= limit) {
        res.set("Retry-After", String(Math.ceil((current.resetAt - now) / 1000)));
        return res.status(429).json({ message: "ส่งคำขอมากเกินไป กรุณาลองใหม่ภายหลัง" });
      }
      current.count += 1;
      next();
    };
  }

  return { authRateCleanupTimer, authRateLimit };
}
