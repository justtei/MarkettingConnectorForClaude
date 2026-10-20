/** Read models for the dashboard. They read the Postgres mirror (synced from Meta), never Meta directly. */
import type { CoreContext } from "../context.js";
import { UserInputError } from "../guards.js";
import { addDays, eachDay, fromDbDate, toDbDate, todayIn } from "../util/dates.js";
import { lastSync } from "./sync.js";

const r2 = (x: number) => Math.round(x * 100) / 100;

interface Agg {
  spend: number;
  impressions: number;
  clicks: number;
  conversations: number;
  reach: number;
}
const emptyAgg = (): Agg => ({ spend: 0, impressions: 0, clicks: 0, conversations: 0, reach: 0 });

function kpis(a: Agg, o: { orders: number; refused: number; revenue: number; chats: number }) {
  const delivered = o.orders - o.refused;
  return {
    spend: r2(a.spend),
    impressions: a.impressions,
    clicks: a.clicks,
    conversations: a.conversations,
    ctr: a.impressions ? r2((a.clicks / a.impressions) * 100) : 0,
    cost_per_chat: a.conversations ? r2(a.spend / a.conversations) : null,
    orders: o.orders,
    refused: o.refused,
    delivered,
    revenue: o.revenue,
    chats_logged: o.chats,
    cost_per_order: o.orders ? r2(a.spend / o.orders) : null,
    refusal_rate_pct: o.orders ? r2((o.refused / o.orders) * 100) : null,
    roas: a.spend ? r2(o.revenue / a.spend) : null,
  };
}

async function periodKpis(ctx: CoreContext, since: string, until: string) {
  const range = { gte: toDbDate(since), lte: toDbDate(until) };
  const [stats, orders, waChats] = await Promise.all([
    ctx.db.dailyStat.aggregate({ where: { date: range }, _sum: { spend: true, impressions: true, clicks: true, conversations: true, reach: true } }),
    ctx.db.orderLog.aggregate({ where: { date: range }, _sum: { orders: true, refused: true, revenue: true, chats: true } }),
    ctx.db.whatsappChat.count({ where: { date: range } }),
  ]);
  const a: Agg = {
    spend: Number(stats._sum.spend ?? 0),
    impressions: stats._sum.impressions ?? 0,
    clicks: stats._sum.clicks ?? 0,
    conversations: stats._sum.conversations ?? 0,
    reach: stats._sum.reach ?? 0,
  };
  return {
    since,
    until,
    ...kpis(a, {
      orders: orders._sum.orders ?? 0,
      refused: orders._sum.refused ?? 0,
      revenue: orders._sum.revenue ?? 0,
      chats: orders._sum.chats ?? 0,
    }),
    whatsapp_chats: waChats,
  };
}

export async function overview(ctx: CoreContext, days = 30) {
  if (!Number.isInteger(days) || days < 1 || days > 365) throw new UserInputError("days must be 1-365.");
  const today = todayIn(ctx.config.DEFAULT_TIMEZONE);
  const since = addDays(today, -(days - 1));
  const [t, d7, d30, period, stats, orders, chats, sync, activeCampaigns] = await Promise.all([
    periodKpis(ctx, today, today),
    periodKpis(ctx, addDays(today, -6), today),
    periodKpis(ctx, addDays(today, -29), today),
    periodKpis(ctx, since, today),
    ctx.db.dailyStat.groupBy({
      by: ["date"],
      where: { date: { gte: toDbDate(since), lte: toDbDate(today) } },
      _sum: { spend: true, conversations: true, impressions: true, clicks: true },
    }),
    ctx.db.orderLog.groupBy({
      by: ["date"],
      where: { date: { gte: toDbDate(since), lte: toDbDate(today) } },
      _sum: { orders: true, refused: true, revenue: true },
    }),
    ctx.db.whatsappChat.groupBy({ by: ["date"], where: { date: { gte: toDbDate(since), lte: toDbDate(today) } }, _count: { _all: true } }),
    lastSync(ctx),
    ctx.db.campaign.count({ where: { status: "ACTIVE" } }),
  ]);
  const s = new Map(stats.map((x) => [fromDbDate(x.date), x._sum]));
  const o = new Map(orders.map((x) => [fromDbDate(x.date), x._sum]));
  const c = new Map(chats.map((x) => [fromDbDate(x.date), x._count._all]));
  const series = eachDay(since, today).map((date) => {
    const spend = Number(s.get(date)?.spend ?? 0);
    const conv = s.get(date)?.conversations ?? 0;
    const ord = o.get(date)?.orders ?? 0;
    return {
      date,
      spend: r2(spend),
      conversations: conv,
      orders: ord,
      refused: o.get(date)?.refused ?? 0,
      revenue: o.get(date)?.revenue ?? 0,
      whatsapp_chats: c.get(date) ?? 0,
      cost_per_chat: conv ? r2(spend / conv) : null,
      cost_per_order: ord ? r2(spend / ord) : null,
    };
  });
  return { today: t, last_7d: d7, last_30d: d30, period, series, last_sync: sync, active_campaigns: activeCampaigns };
}

async function statsByAd(ctx: CoreContext, since: string, until: string) {
  const rows = await ctx.db.dailyStat.groupBy({
    by: ["adId"],
    where: { date: { gte: toDbDate(since), lte: toDbDate(until) } },
    _sum: { spend: true, impressions: true, clicks: true, conversations: true, reach: true },
  });
  return new Map(
    rows.map((r) => [
      r.adId,
      {
        spend: Number(r._sum.spend ?? 0),
        impressions: r._sum.impressions ?? 0,
        clicks: r._sum.clicks ?? 0,
        conversations: r._sum.conversations ?? 0,
        reach: r._sum.reach ?? 0,
      } as Agg,
    ]),
  );
}

function sum(into: Agg, a: Agg | undefined) {
  if (!a) return;
  into.spend += a.spend;
  into.impressions += a.impressions;
  into.clicks += a.clicks;
  into.conversations += a.conversations;
}

function statOut(a: Agg) {
  return {
    spend: r2(a.spend),
    impressions: a.impressions,
    clicks: a.clicks,
    conversations: a.conversations,
    ctr: a.impressions ? r2((a.clicks / a.impressions) * 100) : 0,
    cost_per_chat: a.conversations ? r2(a.spend / a.conversations) : null,
  };
}

/** Campaign > ad set > ad tree from the mirror with stats for the last `days` days. */
export async function campaignTreeFromDb(ctx: CoreContext, days = 7, includeArchived = false) {
  const today = todayIn(ctx.config.DEFAULT_TIMEZONE);
  const since = addDays(today, -(days - 1));
  const [campaigns, byAd] = await Promise.all([
    ctx.db.campaign.findMany({
      where: { status: { notIn: includeArchived ? ["DELETED"] : ["ARCHIVED", "DELETED"] } },
      include: {
        adSets: {
          where: { status: { notIn: includeArchived ? ["DELETED"] : ["ARCHIVED", "DELETED"] } },
          include: {
            ads: {
              where: { status: { notIn: includeArchived ? ["DELETED"] : ["ARCHIVED", "DELETED"] } },
              include: { creative: { select: { id: true, type: true, thumbnailUrl: true, headline: true } } },
              orderBy: { name: "asc" },
            },
          },
          orderBy: { name: "asc" },
        },
      },
      orderBy: [{ status: "asc" }, { updatedAt: "desc" }],
    }),
    statsByAd(ctx, since, today),
  ]);
  return {
    range: { since, until: today },
    campaigns: campaigns.map((c) => {
      const cAgg = emptyAgg();
      const adsets = c.adSets.map((s) => {
        const sAgg = emptyAgg();
        const ads = s.ads.map((a) => {
          const aAgg = byAd.get(a.id) ?? emptyAgg();
          sum(sAgg, aAgg);
          return {
            id: a.id,
            name: a.name,
            status: a.status,
            effective_status: a.effectiveStatus,
            creative: a.creative,
            stats: statOut(aAgg),
          };
        });
        sum(cAgg, sAgg);
        return {
          id: s.id,
          name: s.name,
          status: s.status,
          effective_status: s.effectiveStatus,
          daily_budget: s.dailyBudget,
          destination: s.destination,
          optimization: s.optimization,
          stats: statOut(sAgg),
          ads,
        };
      });
      return {
        id: c.id,
        name: c.name,
        objective: c.objective,
        status: c.status,
        effective_status: c.effectiveStatus,
        daily_budget: c.dailyBudget,
        created_via: c.createdVia,
        stats: statOut(cAgg),
        adsets,
      };
    }),
  };
}

/** One ad: creative, daily stats, orders, and (live, best effort) a Meta ad preview. */
export async function adDetail(ctx: CoreContext, adId: string, days = 30, withPreview = true) {
  const ad = await ctx.db.ad.findUnique({
    where: { id: adId },
    include: { creative: true, adSet: { include: { campaign: true } } },
  });
  if (!ad) throw new UserInputError(`Ad ${adId} is not in the database yet. Run a sync first.`);
  const today = todayIn(ctx.config.DEFAULT_TIMEZONE);
  const since = addDays(today, -(days - 1));
  const [stats, orders, chats] = await Promise.all([
    ctx.db.dailyStat.findMany({ where: { adId, date: { gte: toDbDate(since) } }, orderBy: { date: "asc" } }),
    ctx.db.orderLog.findMany({ where: { adId, date: { gte: toDbDate(since) } }, orderBy: { date: "desc" } }),
    ctx.db.whatsappChat.count({ where: { adId, date: { gte: toDbDate(since) } } }),
  ]);
  const agg = emptyAgg();
  let videoPlaysP25 = 0;
  let videoP50 = 0;
  let videoP75 = 0;
  let videoP100 = 0;
  let hasVideo = false;
  let freqWeighted = 0;
  for (const s of stats) {
    agg.spend += Number(s.spend);
    agg.impressions += s.impressions;
    agg.clicks += s.clicks;
    agg.conversations += s.conversations;
    freqWeighted += Number(s.frequency) * s.impressions;
    if (s.videoP25 !== null) {
      hasVideo = true;
      videoPlaysP25 += s.videoP25 ?? 0;
      videoP50 += s.videoP50 ?? 0;
      videoP75 += s.videoP75 ?? 0;
      videoP100 += s.videoP100 ?? 0;
    }
  }
  let preview: string | null = null;
  if (withPreview && ad.creativeId) {
    try {
      const res = await ctx.meta.get<{ data: { body: string }[] }>(`${ad.creativeId}/previews`, { ad_format: "MOBILE_FEED_STANDARD" });
      preview = res.data?.[0]?.body ?? null;
    } catch (err) {
      ctx.log.info({ err: String(err) }, "Ad preview unavailable");
    }
  }
  const totalOrders = orders.reduce((a, o) => ({ orders: a.orders + o.orders, refused: a.refused + o.refused, revenue: a.revenue + o.revenue, chats: a.chats + o.chats }), { orders: 0, refused: 0, revenue: 0, chats: 0 });
  return {
    id: ad.id,
    name: ad.name,
    status: ad.status,
    effective_status: ad.effectiveStatus,
    adset: { id: ad.adSet.id, name: ad.adSet.name, daily_budget: ad.adSet.dailyBudget, status: ad.adSet.status },
    campaign: { id: ad.adSet.campaign.id, name: ad.adSet.campaign.name, status: ad.adSet.campaign.status },
    creative: ad.creative,
    preview_html: preview,
    range: { since, until: today },
    totals: {
      ...statOut(agg),
      avg_frequency: agg.impressions ? r2(freqWeighted / agg.impressions) : null,
      ...kpis(agg, totalOrders),
      whatsapp_chats: chats,
    },
    video: hasVideo
      ? {
          p25: videoPlaysP25,
          p50: videoP50,
          p75: videoP75,
          p100: videoP100,
          completion_pct: videoPlaysP25 ? r2((videoP100 / videoPlaysP25) * 100) : null,
        }
      : null,
    daily: stats.map((s) => ({
      date: fromDbDate(s.date),
      spend: Number(s.spend),
      impressions: s.impressions,
      clicks: s.clicks,
      ctr: s.impressions ? r2((s.clicks / s.impressions) * 100) : 0,
      conversations: s.conversations,
      frequency: Number(s.frequency),
      cost_per_chat: s.conversations ? r2(Number(s.spend) / s.conversations) : null,
    })),
    orders: orders.map((o) => ({ id: o.id, date: fromDbDate(o.date), chats: o.chats, orders: o.orders, refused: o.refused, revenue: o.revenue, note: o.note })),
  };
}

/** Performance per creative (aggregated over all ads using it). */
export async function creativePerformance(ctx: CoreContext, days = 30) {
  const today = todayIn(ctx.config.DEFAULT_TIMEZONE);
  const since = addDays(today, -(days - 1));
  const [creatives, byAd] = await Promise.all([
    ctx.db.creative.findMany({ include: { ads: { select: { id: true, name: true, status: true } } }, orderBy: { createdAt: "desc" } }),
    statsByAd(ctx, since, today),
  ]);
  return {
    range: { since, until: today },
    creatives: creatives.map((c) => {
      const agg = emptyAgg();
      for (const a of c.ads) sum(agg, byAd.get(a.id));
      return {
        id: c.id,
        name: c.name,
        type: c.type,
        media_ref: c.mediaRef,
        thumbnail_url: c.thumbnailUrl,
        headline: c.headline,
        primary_text: c.primaryText,
        ads: c.ads,
        stats: statOut(agg),
      };
    }),
  };
}

export async function activityLog(
  ctx: CoreContext,
  opts: { limit?: number; before?: string; object_id?: string; actor?: string; action?: string } = {},
) {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const rows = await ctx.db.auditLog.findMany({
    where: {
      ...(opts.object_id ? { objectId: opts.object_id } : {}),
      ...(opts.actor ? { actor: opts.actor } : {}),
      ...(opts.action ? { action: opts.action } : {}),
      ...(opts.before ? { at: { lt: new Date(opts.before) } } : {}),
    },
    orderBy: { at: "desc" },
    take: limit,
  });
  return {
    items: rows.map((r) => ({
      id: r.id,
      at: r.at.toISOString(),
      actor: r.actor,
      action: r.action,
      object_id: r.objectId,
      ok: r.ok,
      request: r.request,
      response: r.response,
      before: r.before,
    })),
    next_before: rows.length === limit ? rows[rows.length - 1]!.at.toISOString() : null,
  };
}
