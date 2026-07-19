import { randomUUID } from "node:crypto";

const runtime = {
  startedAt: Date.now(),
  requests: 0,
  activeRequests: 0,
  errorResponses: 0,
  totalDurationMs: 0,
};

function serializeError(error) {
  if (!error) return undefined;
  return {
    name: error.name,
    message: error.message,
    code: error.code,
    stack: process.env.NODE_ENV === "production" ? undefined : error.stack,
  };
}

function write(level, event, fields = {}) {
  const payload = {
    timestamp: new Date().toISOString(),
    level,
    event,
    ...fields,
  };
  const method = level === "error" ? "error" : level === "warn" ? "warn" : "log";
  console[method](JSON.stringify(payload));
}

export const logger = Object.freeze({
  info: (event, fields) => write("info", event, fields),
  warn: (event, fields) => write("warn", event, fields),
  error: (event, error, fields = {}) =>
    write("error", event, { ...fields, error: serializeError(error) }),
});

export function requestContext(req, res, next) {
  const startedAt = performance.now();
  runtime.requests += 1;
  runtime.activeRequests += 1;
  const incomingId = String(req.headers["x-request-id"] || "");
  req.id = /^[A-Za-z0-9._:-]{1,128}$/.test(incomingId)
    ? incomingId
    : randomUUID();
  res.setHeader("x-request-id", req.id);
  res.on("finish", () => {
    const durationMs = performance.now() - startedAt;
    runtime.activeRequests = Math.max(0, runtime.activeRequests - 1);
    runtime.totalDurationMs += durationMs;
    if (res.statusCode >= 500) runtime.errorResponses += 1;
    logger.info("http.request.completed", {
      requestId: req.id,
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      durationMs: Math.round(durationMs * 100) / 100,
      userId: req.user?.id,
      companyId: req.user?.companyId,
    });
  });
  next();
}

export function getRuntimeMetrics() {
  const memory = process.memoryUsage();
  return {
    uptimeSeconds: Math.round((Date.now() - runtime.startedAt) / 1000),
    requestsTotal: runtime.requests,
    activeRequests: runtime.activeRequests,
    errorResponsesTotal: runtime.errorResponses,
    averageDurationMs: runtime.requests
      ? Math.round((runtime.totalDurationMs / runtime.requests) * 100) / 100
      : 0,
    memoryRssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
  };
}
