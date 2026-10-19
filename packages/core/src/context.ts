import type { PrismaClient } from "@sandalez/db";
import { getDb } from "@sandalez/db";
import { loadConfig, type Config } from "./config.js";
import { logger, type Logger } from "./logger.js";
import { MetaClient, type MetaClientOptions } from "./meta/client.js";

export type Via = "mcp" | "dashboard" | "worker" | "webhook";

/** Everything a service needs: config, the Meta client, the database and who is acting. */
export interface CoreContext {
  config: Config;
  meta: MetaClient;
  db: PrismaClient;
  /** claude-mcp | user email | worker */
  actor: string;
  via: Via;
  log: Logger;
}

export interface Core {
  config: Config;
  meta: MetaClient;
  db: PrismaClient;
  context(actor: string, via: Via): CoreContext;
}

export function createCore(
  opts: { config?: Config; db?: PrismaClient; meta?: Partial<MetaClientOptions> } = {},
): Core {
  const config = opts.config ?? loadConfig();
  const meta = MetaClient.fromConfig(config, opts.meta);
  const db = opts.db ?? getDb();
  return {
    config,
    meta,
    db,
    context(actor, via) {
      return { config, meta, db, actor, via, log: logger.child({ actor, via }) };
    },
  };
}

/** The ad account ID without the `act_` prefix. */
export function accountNumericId(config: Config): string {
  return config.META_AD_ACCOUNT_ID.replace(/^act_/, "");
}
