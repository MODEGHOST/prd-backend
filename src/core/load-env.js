import dotenv from "dotenv";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Local: backend/.env (preferred when present).
 * Server: backend/.env.production when .env is absent.
 * Force production file locally only with USE_PRODUCTION_ENV=1.
 */
export function loadEnv(cwd = process.cwd()) {
  const localPath = resolve(cwd, ".env");
  const productionPath = resolve(cwd, ".env.production");
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
