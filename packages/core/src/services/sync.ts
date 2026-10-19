/** Pulls Meta structure and daily ad insights into Postgres so the dashboard never waits on Meta. */
import { rememberOwned } from "../guards.js";
import type { CoreContext } from "../context.js";
import { Prisma } from "@sandalez/db";
import { addDays, toDbDate, todayIn } from "../util/dates.js";
import { getCurrency } from "./account.js";
import { fetchInsights, type InsightRow } from "./insights.js";
import { AD_FIELDS, ADSET_FIELDS, CAMPAIGN_FIELDS, mirrorAd, mirrorAdSet, mirrorCampaign } from "./mirror.js";
import { setMeta, getMeta } from "./settings.js";

const LIVE_STATUSES = [
  "ACTIVE",
  "PAUSED",
  "ARCHIVED",
  "IN_PROCESS",
  "WITH_ISSUES",
  "CAMPAIGN_PAUSED",
  "ADSET_PAUSED",
  "PENDING_REVIEW",
  "DISAPPROVED",
  "PREAPPROVED",
  "PENDING_BILLING_INFO",
];

export async function syncStructure(ctx: CoreContext) {
  const currency = await getCurrency(ctx);
  const acc = ctx.config.META_AD_ACCOUNT_ID;
  const [campaigns, adsets, ads] = await Promise.all([
    ctx.meta.getAll<any>(`${acc}/campaigns`, { fields: CAMPAIGN_FIELDS, effective_status: LIVE_STATUSES }, 5000),
    ctx.meta.getAll<any>(`${acc}/adsets`, { fields: ADSET_FIELDS, effective_status: LIVE_STATUSES }, 5000),
    ctx.meta.getAll<any>(`${acc}/ads`, { fields: AD_FIELDS, effective_status: LIVE_STATUSES }, 5000),
  ]);
  const campaignIds = new Set(campaigns.map((c) => c.id));
  const adsetIds = new Set<string>();
  for (const c of campaigns) {
    rememberOwned(ctx, c.id, "campaign");
    await mirrorCampaign(ctx, c, currency);
  }
  for (const s of adsets) {
    if (!campaignIds.has(s.campaign_id)) continue;
    rememberOwned(ctx, s.id, "adset");
    await mirrorAdSet(ctx, s, currency);
    adsetIds.add(s.id);
  }
  let adCount = 0;
  for (const a of ads) {
    if (!adsetIds.has(a.adset_id)) continue;
    rememberOwned(ctx, a.id, "ad");
    await mirrorAd(ctx, a);
    adCount++;
  }
  return { campaigns: campaigns.length, adsets: adsetIds.size, ads: adCount };
}

/** Upserts one DailyStat row per ad per day for the last `days` days (including today). */
export async function syncInsights(ctx: CoreContext, opts: { days?: number; breakdownDays?: number } = {}) {
  const days = opts.days ?? 7;
  const breakdownDays = Math.min(opts.breakdownDays ?? 7, days);
  const until = todayIn(ctx.config.DEFAULT_TIMEZONE);
  const since = addDays(until, -(days - 1));
  const rows = await fetchInsights(ctx, { level: "ad", range: { since, until }, timeIncrement: 1 });

  // Breakdowns (age/gender and placement) for the recent days, stored with each day's row.
  const bSince = addDays(until, -(breakdownDays - 1));
  const breakdownMap = new Map<string, { age_gender: unknown[]; placement: unknown[] }>();
  if (breakdownDays > 0) {
    const [ageGender, placement] = await Promise.all([
      fetchInsights(ctx, { level: "ad", range: { since: bSince, until }, timeIncrement: 1, breakdowns: ["age", "gender"] }),
      fetchInsights(ctx, { level: "ad", range: { since: bSince, until }, timeIncrement: 1, breakdowns: ["publisher_platform", "platform_position"] }),
    ]);
    const add = (r: InsightRow, kind: "age_gender" | "placement") => {
      const key = `${r.ad_id}|${r.date_start}`;
      const entry = breakdownMap.get(key) ?? { age_gender: [], placement: [] };
      entry[kind].push({ ...r.breakdown, spend: r.spend, impressions: r.impressions, clicks: r.clicks, conversations: r.conversations });
      breakdownMap.set(key, entry);
    };
    ageGender.forEach((r) => add(r, "age_gender"));
    placement.forEach((r) => add(r, "placement"));
  }

  const known = new Set((await ctx.db.ad.findMany({ select: { id: true } })).map((a) => a.id));
  let upserted = 0;
  let skipped = 0;
  for (const r of rows) {
    if (!r.ad_id || !known.has(r.ad_id)) {
      skipped++;
      continue;
    }
    const data = {
      spend: new Prisma.Decimal(r.spend),
      impressions: r.impressions,
      reach: r.reach,
      clicks: r.clicks,
      conversations: r.conversations,
      frequency: new Prisma.Decimal(r.frequency),
      videoP25: r.video_p25,
      videoP50: r.video_p50,
      videoP75: r.video_p75,
      videoP100: r.video_p100,
      breakdowns: (breakdownMap.get(`${r.ad_id}|${r.date_start}`) as object | undefined) ?? Prisma.JsonNull,
    };
    await ctx.db.dailyStat.upsert({
      where: { adId_date: { adId: r.ad_id, date: toDbDate(r.date_start) } },
      create: { adId: r.ad_id, date: toDbDate(r.date_start), ...data },
      update: data,
    });
    upserted++;
  }
  return { since, until, rows: rows.length, upserted, skipped_unknown_ads: skipped };
}

export async function syncAll(ctx: CoreContext, opts: { days?: number } = {}) {
  const started = new Date();
  try {
    const structure = await syncStructure(ctx);
    const insights = await syncInsights(ctx, { days: opts.days ?? 7 });
    const result = { ok: true, at: started.toISOString(), ms: Date.now() - started.getTime(), structure, insights };
    await setMeta(ctx, "last_sync", result);
    return result;
  } catch (err) {
    const result = { ok: false, at: started.toISOString(), error: (err as Error).message };
    await setMeta(ctx, "last_sync", result);
    throw err;
  }
}

export async function lastSync(ctx: CoreContext) {
  return getMeta<{ ok: boolean; at: string; error?: string }>(ctx, "last_sync");
}
