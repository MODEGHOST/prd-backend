import { spawnSync } from "node:child_process";

const result = spawnSync(process.execPath, ["--test"], {
  env: {
    ...process.env,
    RUN_INTEGRATION: "1",
  },
  stdio: "inherit",
});

process.exit(result.status ?? 1);
