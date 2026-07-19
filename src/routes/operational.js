export function registerOperationalRoutes(app, deps) {
  const { config, getReady, getRuntimeMetrics, logger, pool } = deps;

  app.get(["/api/live", "/api/health/live"], (_req, res) => {
    res.json({ status: "ok" });
  });

  const readinessHandler = async (_req, res) => {
    if (!getReady()) return res.status(503).json({ status: "starting" });
    try {
      await pool.query("SELECT 1");
      return res.json({ status: "ok" });
    } catch (error) {
      logger.error("health.readiness_failed", error);
      return res.status(503).json({ status: "unavailable" });
    }
  };
  app.get(["/api/health", "/api/health/ready"], readinessHandler);

  app.get("/api/metrics", (req, res) => {
    if (!config.metricsToken) return res.status(404).json({ message: "ไม่พบ Endpoint" });
    if (req.headers.authorization !== `Bearer ${config.metricsToken}`) {
      return res.status(401).json({ message: "ไม่มีสิทธิ์ดู Metrics" });
    }
    res.json(getRuntimeMetrics());
  });
}
