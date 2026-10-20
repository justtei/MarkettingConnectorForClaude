import cron from "node-cron";
import { createCore, logger } from "@sandalez/core";
import { alertsJob, shopSyncJob, syncJob, tokenCheckJob, weeklyReportJob } from "./jobs/index.js";

const core = createCore();
const ctx = core.context("worker", "worker");
const tz = core.config.DEFAULT_TIMEZONE;
const days = Number(process.env.SYNC_DAYS ?? 7);

const schedules: [string, string, () => Promise<unknown>][] = [
  ["sync", process.env.SYNC_CRON ?? "0 */3 * * *", () => syncJob(ctx, days)],
  ["alerts", process.env.ALERTS_CRON ?? "15 */3 * * *", () => alertsJob(ctx)],
  ["weekly_report", process.env.WEEKLY_REPORT_CRON ?? "0 9 * * 1", () => weeklyReportJob(ctx)],
  ["token_check", process.env.TOKEN_CHECK_CRON ?? "0 8 * * *", () => tokenCheckJob(ctx)],
  ["shop_sync", process.env.SHOP_SYNC_CRON ?? "*/30 * * * *", () => shopSyncJob(ctx)],
];

for (const [name, expr, fn] of schedules) {
  if (!cron.validate(expr)) throw new Error(`Invalid cron expression for ${name}: "${expr}"`);
  cron.schedule(expr, () => void fn(), { timezone: tz, name, noOverlap: true });
  logger.info({ job: name, cron: expr, tz }, "Scheduled");
}

/** Startup sync with retries (Meta or the network may not be reachable yet right after boot). */
async function startupSync(attempt = 1): Promise<void> {
  const r = await syncJob(ctx, days);
  logger.info({ ok: r.ok, ms: r.ms, error: r.error, attempt }, "Startup sync done");
  if (!r.ok && attempt < 5) setTimeout(() => void startupSync(attempt + 1), 30_000 * attempt).unref();
}
if (process.env.RUN_SYNC_ON_START !== "false") void startupSync();
void tokenCheckJob(ctx);
void shopSyncJob(ctx);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    logger.info({ sig }, "Worker shutting down");
    void cron.shutdown?.();
    void core.db.$disconnect().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
