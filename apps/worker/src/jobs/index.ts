/** Worker jobs. Each is a plain async function so it can be run by cron, by hand, or in tests. */
import {
  accountService,
  alertsService,
  emailConfigured,
  reportsService,
  sendEmail,
  settingsService,
  shopifyService,
  syncService,
  type CoreContext,
} from "@sandalez/core";

export interface JobResult {
  job: string;
  ok: boolean;
  skipped?: string;
  ms: number;
  result?: unknown;
  error?: string;
}

const LEASE_MS = 30 * 60 * 1000;

/**
 * A lease lock in the Setting table, so two worker processes never run the same job at once.
 * (Session advisory locks are unsafe with Prisma's connection pool: lock and unlock may run on
 * different connections.) The lease expires after 30 minutes in case a worker dies mid-job.
 */
async function withLock<T>(ctx: CoreContext, job: string, fn: () => Promise<T>): Promise<{ locked: false } | { locked: true; value: T }> {
  const key = `lock:${job}`;
  const owner = `${process.pid}-${Math.random().toString(36).slice(2)}`;
  const value = JSON.stringify({ owner, until: new Date(Date.now() + LEASE_MS).toISOString() });
  const got = await ctx.db.$queryRaw<{ key: string }[]>`
    INSERT INTO "Setting" ("key", "value", "updatedAt") VALUES (${key}, ${value}::jsonb, now())
    ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value", "updatedAt" = now()
    WHERE ("Setting"."value"->>'until')::timestamptz < now()
    RETURNING "key"`;
  if (got.length === 0) return { locked: false };
  try {
    return { locked: true, value: await fn() };
  } finally {
    await ctx.db.$executeRaw`DELETE FROM "Setting" WHERE "key" = ${key} AND "value"->>'owner' = ${owner}`;
  }
}

export async function runJob(ctx: CoreContext, job: string, fn: () => Promise<unknown>): Promise<JobResult> {
  const started = Date.now();
  try {
    const out = await withLock(ctx, job, fn);
    if (!out.locked) {
      ctx.log.info({ job }, "Job already running elsewhere; skipped");
      return { job, ok: true, skipped: "locked", ms: Date.now() - started };
    }
    ctx.log.info({ job, ms: Date.now() - started }, "Job finished");
    return { job, ok: true, ms: Date.now() - started, result: out.value };
  } catch (err) {
    ctx.log.error({ job, err }, "Job failed");
    return { job, ok: false, ms: Date.now() - started, error: (err as Error).message };
  }
}

/** Every 3 hours: pull structure + daily insights, then evaluate alerts on fresh numbers. */
export async function syncJob(ctx: CoreContext, days = 7) {
  return runJob(ctx, "sync", async () => {
    const sync = await syncService.syncAll(ctx, { days });
    const alerts = await alertsService.evaluateAlerts(ctx);
    return { sync, alerts };
  });
}

/** Every 30 minutes when Shopify is connected: new and changed orders, their outcome and their ad. */
export async function shopSyncJob(ctx: CoreContext) {
  if (!shopifyService.shopifyConfigured(ctx)) return { job: "shop_sync", ok: true, skipped: "Shopify not configured", ms: 0 } as JobResult;
  return runJob(ctx, "shop_sync", () => shopifyService.syncShopOrders(ctx));
}

export async function alertsJob(ctx: CoreContext) {
  return runJob(ctx, "alerts", () => alertsService.evaluateAlerts(ctx));
}

/** Monday morning: weekly report, emailed when SMTP and a recipient are set. */
export async function weeklyReportJob(ctx: CoreContext) {
  return runJob(ctx, "weekly_report", async () => {
    const settings = await settingsService.getSettings(ctx);
    if (shopifyService.shopifyConfigured(ctx)) {
      await shopifyService.syncShopOrders(ctx).catch((err) => ctx.log.warn({ err: String(err) }, "Shopify sync before the report failed"));
    }
    return reportsService.weeklyReport(ctx, { send_email: emailConfigured() && Boolean(settings.alertEmail) });
  });
}

/** Daily: warn (log + email + stored status) when the Meta token is invalid, expiring or missing permissions. */
export async function tokenCheckJob(ctx: CoreContext) {
  return runJob(ctx, "token_check", async () => {
    const t = await accountService.checkToken(ctx);
    await settingsService.setMeta(ctx, "token_health", { at: new Date().toISOString(), healthy: t.healthy, warnings: t.warnings, expires_at: t.expires_at });
    if (!t.healthy) {
      ctx.log.warn({ warnings: t.warnings }, "Meta token needs attention");
      const settings = await settingsService.getSettings(ctx);
      if (settings.alertEmail) {
        await sendEmail(
          settings.alertEmail,
          "Sandalez Ads: Meta token needs attention",
          `<p>${t.warnings.map(alertsService.escapeHtml).join("<br>")}</p><p>Generate a new system user token in Business Settings and update META_ACCESS_TOKEN.</p>`,
        );
      }
    }
    return { healthy: t.healthy, warnings: t.warnings };
  });
}
