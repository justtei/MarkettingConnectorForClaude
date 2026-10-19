import type { z } from "zod";
import type { CoreContext } from "../context.js";
import { resolveOwnedObject } from "../guards.js";
import type { insightsInput } from "../schemas.js";
import { metaRangeParams, resolveRange } from "../util/dates.js";
import { getCurrency } from "./account.js";

export const CONVERSATION_ACTION = "onsite_conversion.messaging_conversation_started_7d";
const LINK_CLICK_ACTION = "link_click";

export const INSIGHT_FIELDS = [
  "date_start",
  "date_stop",
  "spend",
  "impressions",
  "reach",
  "frequency",
  "clicks",
  "inline_link_clicks",
  "ctr",
  "cpm",
  "cpc",
  "actions",
  "cost_per_action_type",
  "video_p25_watched_actions",
  "video_p50_watched_actions",
  "video_p75_watched_actions",
  "video_p100_watched_actions",
  "video_play_actions",
];

const LEVEL_FIELDS: Record<string, string[]> = {
  account: ["account_id", "account_name"],
  campaign: ["campaign_id", "campaign_name"],
  adset: ["campaign_id", "campaign_name", "adset_id", "adset_name"],
  ad: ["campaign_id", "campaign_name", "adset_id", "adset_name", "ad_id", "ad_name"],
};

const LEVEL_RANK: Record<string, number> = { account: 0, campaign: 1, adset: 2, ad: 3 };

export interface InsightRow {
  date_start: string;
  date_stop: string;
  campaign_id?: string;
  campaign_name?: string;
  adset_id?: string;
  adset_name?: string;
  ad_id?: string;
  ad_name?: string;
  breakdown?: Record<string, string>;
  spend: number;
  impressions: number;
  reach: number;
  frequency: number;
  clicks: number;
  link_clicks: number;
  ctr: number;
  cpm: number;
  conversations: number;
  cost_per_conversation: number | null;
  video_plays: number | null;
  video_p25: number | null;
  video_p50: number | null;
  video_p75: number | null;
  video_p100: number | null;
}

function n(v: unknown): number {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

function actionValue(list: any[] | undefined, type: string): number | null {
  if (!Array.isArray(list)) return null;
  const hit = list.find((a) => a.action_type === type);
  return hit ? n(hit.value) : null;
}

function videoMetric(list: any[] | undefined): number | null {
  if (!Array.isArray(list) || list.length === 0) return null;
  return list.reduce((s, a) => s + n(a.value), 0);
}

const round2 = (x: number) => Math.round(x * 100) / 100;

/** Normalizes one Meta insights row. Insights `spend` is already in major units (PKR). */
export function parseInsightRow(r: any, breakdowns: string[] = []): InsightRow {
  const spend = n(r.spend);
  const conversations = actionValue(r.actions, CONVERSATION_ACTION) ?? 0;
  const cpa = actionValue(r.cost_per_action_type, CONVERSATION_ACTION);
  const row: InsightRow = {
    date_start: r.date_start,
    date_stop: r.date_stop,
    spend: round2(spend),
    impressions: n(r.impressions),
    reach: n(r.reach),
    frequency: round2(n(r.frequency)),
    clicks: n(r.clicks),
    link_clicks: n(r.inline_link_clicks ?? actionValue(r.actions, LINK_CLICK_ACTION)),
    ctr: round2(n(r.ctr)),
    cpm: round2(n(r.cpm)),
    conversations,
    cost_per_conversation: cpa !== null ? round2(cpa) : conversations > 0 ? round2(spend / conversations) : null,
    video_plays: videoMetric(r.video_play_actions),
    video_p25: videoMetric(r.video_p25_watched_actions),
    video_p50: videoMetric(r.video_p50_watched_actions),
    video_p75: videoMetric(r.video_p75_watched_actions),
    video_p100: videoMetric(r.video_p100_watched_actions),
  };
  for (const k of ["campaign_id", "campaign_name", "adset_id", "adset_name", "ad_id", "ad_name"] as const) {
    if (r[k] !== undefined) (row as any)[k] = r[k];
  }
  if (breakdowns.length) row.breakdown = Object.fromEntries(breakdowns.map((b) => [b, String(r[b] ?? "unknown")]));
  return row;
}

export function totalsOf(rows: InsightRow[]) {
  const t = rows.reduce(
    (a, r) => {
      a.spend += r.spend;
      a.impressions += r.impressions;
      a.clicks += r.clicks;
      a.link_clicks += r.link_clicks;
      a.conversations += r.conversations;
      return a;
    },
    { spend: 0, impressions: 0, clicks: 0, link_clicks: 0, conversations: 0 },
  );
  return {
    spend: round2(t.spend),
    impressions: t.impressions,
    clicks: t.clicks,
    link_clicks: t.link_clicks,
    conversations: t.conversations,
    ctr: t.impressions ? round2((t.clicks / t.impressions) * 100) : 0,
    cpm: t.impressions ? round2((t.spend / t.impressions) * 1000) : 0,
    cost_per_conversation: t.conversations ? round2(t.spend / t.conversations) : null,
  };
}

/** The insights level matching an object's own type ("account" when no object is given). */
export async function levelFor(ctx: CoreContext, objectId?: string): Promise<"account" | "campaign" | "adset" | "ad"> {
  if (!objectId) return "account";
  const t = await resolveOwnedObject(ctx, objectId);
  return t === "campaign" || t === "adset" || t === "ad" ? t : "account";
}

/** Raw insights fetch (any object, any level), returning normalized rows. */
export async function fetchInsights(
  ctx: CoreContext,
  opts: {
    objectId?: string;
    level: "account" | "campaign" | "adset" | "ad";
    range: { date_preset?: string; since?: string; until?: string };
    breakdowns?: string[];
    timeIncrement?: number | "all_days" | "monthly";
    limit?: number;
    filtering?: unknown[];
    extraFields?: string[];
  },
): Promise<InsightRow[]> {
  const target = opts.objectId ?? ctx.config.META_AD_ACCOUNT_ID;
  const fields = [...LEVEL_FIELDS[opts.level]!, ...INSIGHT_FIELDS, ...(opts.extraFields ?? [])];
  const rows = await ctx.meta.getAll<any>(`${target}/insights`, {
    level: opts.level,
    fields: fields.join(","),
    ...metaRangeParams(opts.range),
    ...(opts.breakdowns?.length ? { breakdowns: opts.breakdowns.join(",") } : {}),
    ...(opts.timeIncrement !== undefined ? { time_increment: opts.timeIncrement } : {}),
    ...(opts.filtering ? { filtering: opts.filtering } : {}),
    action_report_time: "impression",
  }, opts.limit ?? 5000);
  return rows.map((r) => parseInsightRow(r, opts.breakdowns ?? []));
}

export async function getInsights(ctx: CoreContext, input: z.input<typeof insightsInput>) {
  let level = input.level ?? "campaign";
  if (input.object_id) {
    const type = await resolveOwnedObject(ctx, input.object_id);
    const rank = LEVEL_RANK[type];
    // Can't report above the object's own level (e.g. campaign level for an ad).
    if (rank !== undefined && LEVEL_RANK[level]! < rank) level = type as typeof level;
  }
  const currency = await getCurrency(ctx);
  const rows = await fetchInsights(ctx, {
    objectId: input.object_id,
    level,
    range: input,
    breakdowns: input.breakdowns,
    timeIncrement: input.time_increment,
    limit: input.limit ?? 100,
  });
  const range = resolveRange(input, ctx.config.DEFAULT_TIMEZONE);
  return {
    object_id: input.object_id ?? ctx.config.META_AD_ACCOUNT_ID,
    level,
    date_preset: input.since || input.until ? null : input.date_preset ?? "last_7d",
    range,
    currency,
    breakdowns: input.breakdowns ?? [],
    rows,
    totals: totalsOf(rows),
    notes: rows.length === 0 ? ["No delivery in this period."] : [],
  };
}
