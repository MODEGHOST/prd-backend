import { createClient } from "redis";

export function createAuthRateLimit({ redisUrl = "", logger } = {}) {
  const authRateBuckets = new Map();
  let redis = null;
  let redisConnect = null;

  const authRateCleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of authRateBuckets) {
      if (bucket.resetAt <= now) authRateBuckets.delete(key);
    }
  }, 15 * 60 * 1000);
  authRateCleanupTimer.unref();

  async function getRedis() {
    if (!redisUrl) return null;
    if (redis?.isOpen) return redis;
    if (redisConnect) return redisConnect;
    redisConnect = (async () => {
      const client = createClient({ url: redisUrl });
      client.on("error", (error) => {
        logger?.error?.("auth.rate_limit.redis_error", error);
      });
      await client.connect();
      redis = client;
      logger?.info?.("auth.rate_limit.redis_ready", { mode: "redis" });
      return client;
    })().catch((error) => {
      redisConnect = null;
      logger?.error?.("auth.rate_limit.redis_connect_failed", error);
      return null;
    });
    return redisConnect;
  }

  function memoryLimit(key, limit, windowMs) {
    const now = Date.now();
    const current = authRateBuckets.get(key);
    if (!current || current.resetAt <= now) {
      authRateBuckets.set(key, { count: 1, resetAt: now + windowMs });
      return { allowed: true, retryAfterSec: 0 };
    }
    if (current.count >= limit) {
      return {
        allowed: false,
        retryAfterSec: Math.ceil((current.resetAt - now) / 1000),
      };
    }
    current.count += 1;
    return { allowed: true, retryAfterSec: 0 };
  }

  async function redisLimit(client, key, limit, windowMs) {
    const redisKey = `auth-rate:${key}`;
    const count = await client.incr(redisKey);
    if (count === 1) {
      await client.pExpire(redisKey, windowMs);
    }
    if (count > limit) {
      const ttlMs = await client.pTTL(redisKey);
      return {
        allowed: false,
        retryAfterSec: Math.max(1, Math.ceil((ttlMs > 0 ? ttlMs : windowMs) / 1000)),
      };
    }
    return { allowed: true, retryAfterSec: 0 };
  }

  function authRateLimit({ limit = 10, windowMs = 15 * 60 * 1000 } = {}) {
    return async (req, res, next) => {
      const account = String(req.body?.email || "").trim().toLowerCase();
      const key = account
        ? `${req.ip}:${req.path}:${account}`
        : `${req.ip}:${req.path}`;
      try {
        const client = await getRedis();
        const result = client
          ? await redisLimit(client, key, limit, windowMs)
          : memoryLimit(key, limit, windowMs);
        if (!result.allowed) {
          res.set("Retry-After", String(result.retryAfterSec));
          return res.status(429).json({
            message: "ส่งคำขอมากเกินไป กรุณาลองใหม่ภายหลัง",
          });
        }
        return next();
      } catch (error) {
        logger?.error?.("auth.rate_limit.failed", error);
        const fallback = memoryLimit(key, limit, windowMs);
        if (!fallback.allowed) {
          res.set("Retry-After", String(fallback.retryAfterSec));
          return res.status(429).json({
            message: "ส่งคำขอมากเกินไป กรุณาลองใหม่ภายหลัง",
          });
        }
        return next();
      }
    };
  }

  async function closeAuthRateLimit() {
    clearInterval(authRateCleanupTimer);
    if (redis?.isOpen) {
      await redis.quit().catch(() => {});
    }
  }

  return { authRateCleanupTimer, authRateLimit, closeAuthRateLimit };
}
