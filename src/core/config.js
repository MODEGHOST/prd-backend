function positiveInteger(value, fallback, name, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > max) {
    throw new Error(`${name} must be an integer between 1 and ${max}`);
  }
  return parsed;
}

function urlWithProtocols(value, name, protocols) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
  if (!protocols.includes(parsed.protocol)) {
    throw new Error(`${name} uses an unsupported protocol`);
  }
  return value;
}

export function loadConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV || "development";
  if (!["development", "test", "production"].includes(nodeEnv)) {
    throw new Error("NODE_ENV must be development, test, or production");
  }
  const production = nodeEnv === "production";
  const jwtSecret = env.JWT_SECRET || (production ? "" : "development-secret");
  const frontendUrl = urlWithProtocols(
    env.FRONTEND_URL || "http://localhost:5173",
    "FRONTEND_URL",
    ["http:", "https:"],
  );
  const resendApiKey = env.RESEND_API_KEY || "";
  const emailFrom = env.EMAIL_FROM
    || "ลี้ไฟเบอร์บอร์ด IPMS <noreply@example.com>";
  const dbUser = env.DB_USER || "root";
  const dbPassword = env.DB_PASSWORD || "";
  const seedDemoData = env.SEED_DEMO_DATA == null
    ? !production
    : env.SEED_DEMO_DATA === "1";

  if (production && jwtSecret.length < 32) {
    throw new Error("JWT_SECRET must contain at least 32 characters in production");
  }
  if (production && !resendApiKey) {
    throw new Error("RESEND_API_KEY is required in production");
  }
  if (production && /example\.com/i.test(emailFrom)) {
    throw new Error("EMAIL_FROM must use a verified production sender");
  }
  if (!/^(?:[^<>\r\n]+\s*)?<[^<>\s@]+@[^<>\s@]+\.[^<>\s@]+>$|^[^<>\s@]+@[^<>\s@]+\.[^<>\s@]+$/.test(emailFrom)) {
    throw new Error("EMAIL_FROM must contain a valid sender email address");
  }
  if (production && !dbPassword) {
    throw new Error("DB_PASSWORD is required in production");
  }
  if (production && seedDemoData) {
    throw new Error("SEED_DEMO_DATA cannot be enabled in production");
  }

  return Object.freeze({
    nodeEnv,
    production,
    port: positiveInteger(env.PORT, 4000, "PORT", 65535),
    frontendUrl,
    jwtSecret,
    emailFrom,
    resendApiKey,
    redisUrl: env.REDIS_URL
      ? urlWithProtocols(env.REDIS_URL, "REDIS_URL", ["redis:", "rediss:"])
      : "",
    metricsToken: env.METRICS_TOKEN || "",
    trustProxy: env.TRUST_PROXY === "1" ? 1 : false,
    seedDemoData,
    authTokenTtl: (() => {
      const value = env.AUTH_TOKEN_TTL || "8h";
      if (!/^\d+(?:ms|s|m|h|d|w|y)$/.test(value)) {
        throw new Error("AUTH_TOKEN_TTL must be a positive duration such as 8h or 30m");
      }
      return value;
    })(),
    attachments: Object.freeze({
      directory: env.ATTACHMENT_STORAGE_DIR || "./storage/issue-attachments",
      maxFiles: positiveInteger(env.ATTACHMENT_MAX_FILES, 5, "ATTACHMENT_MAX_FILES", 20),
      maxBytes: positiveInteger(
        env.ATTACHMENT_MAX_BYTES,
        10 * 1024 * 1024,
        "ATTACHMENT_MAX_BYTES",
        50 * 1024 * 1024,
      ),
    }),
    db: Object.freeze({
      host: env.DB_HOST || "localhost",
      port: positiveInteger(env.DB_PORT, 3306, "DB_PORT", 65535),
      user: dbUser,
      password: dbPassword,
      database: env.DB_NAME || "prdproject",
      connectionLimit: positiveInteger(env.DB_POOL_LIMIT, 30, "DB_POOL_LIMIT"),
    }),
  });
}

export const config = loadConfig();
