import dotenv from "dotenv";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Always the backend package root (folder with package.json), not process.cwd(). */
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Local: backend/.env (preferred when present).
 * Server: backend/.env.production when .env is absent.
 * Force production file locally only with USE_PRODUCTION_ENV=1.
 *
 * Paths are resolved from the package root so Passenger/DirectAdmin
 * still find env files even when the process cwd is not the app folder.
 */
export function loadEnv(rootDir = packageRoot) {
  const localPath = resolve(rootDir, ".env");
  const productionPath = resolve(rootDir, ".env.production");
  const forceProduction = process.env.USE_PRODUCTION_ENV === "1";

  if (forceProduction && existsSync(productionPath)) {
    dotenv.config({ path: productionPath, override: true });
    return;
  }

  if (existsSync(localPath)) {
    dotenv.config({ path: localPath });
    return;
  }

  if (existsSync(productionPath)) {
    dotenv.config({ path: productionPath });
  }
}

loadEnv();
