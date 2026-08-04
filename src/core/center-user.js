import { config } from "./config.js";

/** Fully-qualified central identity table, e.g. `shared_auth`.`Center_user_lfb` */
export function centerUserTableSql(cfg = config) {
  return `\`${cfg.sharedDbName}\`.\`${cfg.centerUserTable}\``;
}
