import dotenv from "dotenv";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Always the backend package root (folder with package.json), not process.cwd(). */
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Load an env file. When override=true, keep an already-assigned PORT
 * (Passenger/CloudLinux injects it before boot).
 */
function applyEnvFile(path, { override = false } = {}) {
  const existingPort = process.env.PORT;
  dotenv.config({ path, override });
  if (override && existingPort) {
    process.env.PORT = existingPort;
  }
}

/**
 * Local: backend/.env (preferred when present).
 * Server: backend/.env.production when .env is absent.
 * Force production file locally only with USE_PRODUCTION_ENV=1.
 *
 * On the server, .env.production is applied with override so values like
 * NODE_ENV=development in the file win over the panel's Application mode.
 * Passenger's PORT is preserved.
 */
export function loadEnv(rootDir = packageRoot) {
  const localPath = resolve(rootDir, ".env");
  const productionPath = resolve(rootDir, ".env.production");
  const forceProduction = process.env.USE_PRODUCTION_ENV === "1";

  if (forceProduction && existsSync(productionPath)) {
    applyEnvFile(productionPath, { override: true });
    return;
  }

  if (existsSync(localPath)) {
    applyEnvFile(localPath, { override: false });
    return;
  }

  if (existsSync(productionPath)) {
    applyEnvFile(productionPath, { override: true });
  }
}

loadEnv();
