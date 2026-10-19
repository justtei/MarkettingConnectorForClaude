import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb } from "@sandalez/db";
import { alertsService, settingsService } from "@sandalez/core";
import { alertsJob, runJob, syncJob, tokenCheckJob, weeklyReportJob } from "../src/jobs/index.js";
import { startHarness, type Harness } from "../../../test/harness.js";

let h: Harness;
const db = getDb();

beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h?.close();
});

describe("worker jobs", () => {
  it("syncJob mirrors structure + daily stats and records last_sync", async () => {
    const ctx = h.core.context("worker", "worker");
    const r = await syncJob(ctx, 14);
    expect(r.ok, r.error).toBe(true);
    expect(await db.campaign.count()).toBe(1);
    expect(await db.ad.count()).toBe(3);
    expect(await db.dailyStat.count()).toBe(3 * 14);
    const stat = await db.dailyStat.findFirst({ where: { breakdowns: { not: undefined } }, orderBy: { date: "desc" } });
    expect((stat?.breakdowns as any)?.placement?.length).toBe(5);
    expect((await settingsService.getMeta<any>(ctx, "last_sync"))?.ok).toBe(true);
  });

  it("a second sync is idempotent (upserts, no duplicates)", async () => {
    const ctx = h.core.context("worker", "worker");
    await syncJob(ctx, 14);
    expect(await db.dailyStat.count()).toBe(3 * 14);
  });

  it("sync picks up status changes made in Ads Manager", async () => {
    const ad = [...h.mock.objects.values()].find((o) => o._type === "ad" && o.name === "A3-Kolhapuri")!;
    ad.status = "PAUSED";
    await syncJob(h.core.context("worker", "worker"), 1);
    expect((await db.ad.findUnique({ where: { id: ad.id } }))?.status).toBe("PAUSED");
  });

  it("a job holding the lock blocks a concurrent run", async () => {
    const ctx = h.core.context("worker", "worker");
    let release!: () => void;
    const slow = runJob(ctx, "sync", () => new Promise<void>((r) => (release = r)));
    await new Promise((r) => setTimeout(r, 50));
    // Simulate a second worker process with its own connection pool.
    const { PrismaClient } = await import("@sandalez/db");
    const other = new PrismaClient();
    const second = await runJob({ ...ctx, db: other }, "sync", async () => "ran");
    expect(second.skipped).toBe("locked");
    release();
    expect((await slow).ok).toBe(true);
    // Released: the next run goes ahead, many times in a row (no leaked lock across pooled connections).
    for (let i = 0; i < 5; i++) expect((await runJob({ ...ctx, db: other }, "sync", async () => "ran")).result).toBe("ran");
    await other.$disconnect();
  });

  it("an expired lease (crashed worker) does not block forever", async () => {
    const ctx = h.core.context("worker", "worker");
    await db.setting.create({ data: { key: "lock:alerts", value: { owner: "dead", until: new Date(Date.now() - 1000).toISOString() } } });
    const r = await runJob(ctx, "alerts", async () => "ran");
    expect(r.result).toBe("ran");
    expect(await db.setting.findUnique({ where: { key: "lock:alerts" } })).toBeNull();
  });

  it("a failing sync is reported, not thrown, and last_sync records the error", async () => {
    const ctx = h.core.context("worker", "worker");
    h.mock.failNext(/campaigns$/, { status: 400, times: 5, error: { message: "Invalid OAuth access token", code: 190 } });
    const r = await syncJob(ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/token/);
    expect((await settingsService.getMeta<any>(ctx, "last_sync"))?.ok).toBe(false);
    h.mock.failures = [];
  });

  it("alertsJob evaluates rules", async () => {
    const ctx = h.core.context("worker", "worker");
    await alertsService.setAlert(ctx, { metric: "frequency", operator: "gt", threshold: 0.5 });
    const r = await alertsJob(ctx);
    expect(r.ok).toBe(true);
    expect((r.result as any).fired.length).toBe(1);
  });

  it("weeklyReportJob saves a report (no email without SMTP)", async () => {
    const r = await weeklyReportJob(h.core.context("worker", "worker"));
    expect(r.ok, r.error).toBe(true);
    expect(await db.report.count()).toBe(1);
  });

  it("tokenCheckJob stores token health", async () => {
    const ctx = h.core.context("worker", "worker");
    const r = await tokenCheckJob(ctx);
    expect(r.ok).toBe(true);
    expect((await settingsService.getMeta<any>(ctx, "token_health"))?.healthy).toBe(true);
  });
});
