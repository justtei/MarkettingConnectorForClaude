/** Phase 2 optimization reports: fatigue, placements, wasted spend. All read-only. */
import type { CoreContext } from "../context.js";
import { addDays, resolveRange, todayIn, type RangeInput } from "../util/dates.js";
import { fetchInsights, levelFor, totalsOf, type InsightRow } from "./insights.js";

const r2 = (x: number) => Math.round(x * 100) / 100;

/**
 * detect_fatigue: per ad, compares the last `recent_days` CTR and cost per chat with the
 * days before, and flags high frequency over the whole window.
 */
export async function detectFatigue(
  ctx: CoreContext,
  input: { lookback_days?: number; recent_days?: number; frequency_threshold?: number; ctr_drop_pct?: number; min_impressions?: number } = {},
) {
  const lookback = input.lookback_days ?? 14;
  const recent = input.recent_days ?? 3;
  const freqMax = input.frequency_threshold ?? 3;
  const dropPct = input.ctr_drop_pct ?? 30;
  const minImpr = input.min_impressions ?? 1000;
  const until = addDays(todayIn(ctx.config.DEFAULT_TIMEZONE), -1);
  const since = addDays(until, -(lookback - 1));
  const recentSince = addDays(until, -(recent - 1));

  const [daily, overall] = await Promise.all([
    fetchInsights(ctx, { level: "ad", range: { since, until }, timeIncrement: 1 }),
    fetchInsights(ctx, { level: "ad", range: { since, until } }),
  ]);

  const byAd = new Map<string, InsightRow[]>();
  for (const r of daily) {
    if (!r.ad_id) continue;
    byAd.set(r.ad_id, [...(byAd.get(r.ad_id) ?? []), r]);
  }

  const ads = overall
    .filter((o) => o.ad_id && o.impressions >= minImpr)
    .map((o) => {
      const rows = byAd.get(o.ad_id!) ?? [];
      const rec = totalsOf(rows.filter((r) => r.date_start >= recentSince));
      const base = totalsOf(rows.filter((r) => r.date_start < recentSince));
      const ctrChange = base.ctr > 0 ? r2(((rec.ctr - base.ctr) / base.ctr) * 100) : null;
      const cpcChange =
        base.cost_per_conversation && rec.cost_per_conversation
          ? r2(((rec.cost_per_conversation - base.cost_per_conversation) / base.cost_per_conversation) * 100)
          : null;
      const reasons: string[] = [];
      if (o.frequency >= freqMax) reasons.push(`frequency ${o.frequency} ≥ ${freqMax}`);
      if (ctrChange !== null && ctrChange <= -dropPct && base.impressions >= 500 && rec.impressions >= 300) {
        reasons.push(`CTR down ${Math.abs(ctrChange)}% (${base.ctr}% → ${rec.ctr}%)`);
      }
      if (cpcChange !== null && cpcChange >= 40) reasons.push(`cost per chat up ${cpcChange}%`);
      const severity = reasons.length >= 2 ? "high" : reasons.length === 1 ? "medium" : "none";
      return {
        ad_id: o.ad_id!,
        ad_name: o.ad_name ?? null,
        campaign_name: o.campaign_name ?? null,
        spend: o.spend,
        frequency: o.frequency,
        ctr_baseline: base.ctr,
        ctr_recent: rec.ctr,
        ctr_change_pct: ctrChange,
        cost_per_chat_baseline: base.cost_per_conversation,
        cost_per_chat_recent: rec.cost_per_conversation,
        cost_per_chat_change_pct: cpcChange,
        fatigued: severity !== "none",
        severity,
        reasons,
        recommendation:
          severity === "high"
            ? "Swap in a fresh creative (new video/hook) or pause this ad."
            : severity === "medium"
              ? "Watch closely; prepare a new creative for this ad set."
              : null,
      };
    })
    .sort((a, b) => Number(b.fatigued) - Number(a.fatigued) || b.spend - a.spend);

  return {
    window: { since, until, recent_since: recentSince },
    thresholds: { frequency: freqMax, ctr_drop_pct: dropPct, min_impressions: minImpr },
    fatigued_count: ads.filter((a) => a.fatigued).length,
    ads,
  };
}

/** placement_report: spend and results by platform and position. */
export async function placementReport(ctx: CoreContext, input: RangeInput & { object_id?: string } = {}) {
  const rows = await fetchInsights(ctx, {
    objectId: input.object_id,
    level: await levelFor(ctx, input.object_id),
    range: input,
    breakdowns: ["publisher_platform", "platform_position"],
  });
  const total = totalsOf(rows);
  const avgCpc = total.cost_per_conversation;
  const placements = rows
    .map((r) => {
      const share = total.spend ? r2((r.spend / total.spend) * 100) : 0;
      const flag =
        avgCpc && share >= 10 && (r.conversations === 0 || (r.cost_per_conversation ?? 0) > avgCpc * 1.5)
          ? "expensive"
          : avgCpc && r.cost_per_conversation !== null && r.cost_per_conversation < avgCpc * 0.75
            ? "efficient"
            : null;
      return {
        platform: r.breakdown?.publisher_platform ?? "unknown",
        position: r.breakdown?.platform_position ?? "unknown",
        spend: r.spend,
        spend_share_pct: share,
        impressions: r.impressions,
        ctr: r.ctr,
        conversations: r.conversations,
        cost_per_conversation: r.cost_per_conversation,
        flag,
      };
    })
    .sort((a, b) => b.spend - a.spend);
  return {
    range: resolveRange(input, ctx.config.DEFAULT_TIMEZONE),
    total,
    placements,
    summary: placements
      .filter((p) => p.flag === "expensive")
      .map((p) => `${p.platform}/${p.position}: ${p.spend_share_pct}% of spend at ${p.cost_per_conversation ?? "no"} cost per chat`),
  };
}

/** wasted_spend_report: ads spending without chats, and ads far above the average cost per chat. */
export async function wastedSpendReport(ctx: CoreContext, input: RangeInput & { min_spend?: number; cost_multiple?: number } = {}) {
  const minSpend = input.min_spend ?? 500;
  const multiple = input.cost_multiple ?? 2;
  const rows = await fetchInsights(ctx, { level: "ad", range: input });
  const total = totalsOf(rows);
  const avg = total.cost_per_conversation;
  const items = rows
    .filter((r) => r.spend >= minSpend)
    .map((r) => {
      let reason: string | null = null;
      let wasted = 0;
      if (r.conversations === 0) {
        reason = `PKR ${r.spend} spent with 0 chats`;
        wasted = r.spend;
      } else if (avg && r.cost_per_conversation && r.cost_per_conversation > avg * multiple) {
        reason = `cost per chat PKR ${r.cost_per_conversation} vs average PKR ${avg}`;
        wasted = r2(r.spend - r.conversations * avg);
      }
      return { ad_id: r.ad_id, ad_name: r.ad_name, campaign_name: r.campaign_name, spend: r.spend, conversations: r.conversations, cost_per_conversation: r.cost_per_conversation, reason, wasted_spend: wasted };
    })
    .filter((i) => i.reason)
    .sort((a, b) => b.wasted_spend - a.wasted_spend);
  const wasted = r2(items.reduce((s, i) => s + i.wasted_spend, 0));
  return {
    range: resolveRange(input, ctx.config.DEFAULT_TIMEZONE),
    total_spend: total.spend,
    average_cost_per_chat: avg,
    wasted_spend: wasted,
    wasted_pct: total.spend ? r2((wasted / total.spend) * 100) : 0,
    items,
    recommendation: items.length
      ? "Pause the ads with 0 chats, and test new creatives for the expensive ones."
      : "No obvious waste in this period.",
  };
}
