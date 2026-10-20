import type { CoreContext } from "../context.js";
import { sendEmail } from "../email.js";
import { addDays, toDbDate, todayIn } from "../util/dates.js";
import { escapeHtml, recentAlertEvents } from "./alerts.js";
import { detectFatigue } from "./analysis.js";
import { fetchInsights, totalsOf } from "./insights.js";
import { getCostPerOrder } from "./orders.js";
import { getSettings } from "./settings.js";

const pct = (a: number | null, b: number | null) =>
  a !== null && b !== null && b !== 0 ? Math.round(((a - b) / b) * 1000) / 10 : null;

/** weekly_report: last 7 full days vs the 7 before. Saved to the DB and optionally emailed. */
export async function weeklyReport(ctx: CoreContext, opts: { send_email?: boolean; email_to?: string } = {}) {
  const until = addDays(todayIn(ctx.config.DEFAULT_TIMEZONE), -1);
  const since = addDays(until, -6);
  const prevUntil = addDays(since, -1);
  const prevSince = addDays(prevUntil, -6);

  const [thisAds, prevTotals, thisOrders, prevOrders, fatigue, alerts, byAd] = await Promise.all([
    fetchInsights(ctx, { level: "ad", range: { since, until } }),
    fetchInsights(ctx, { level: "account", range: { since: prevSince, until: prevUntil } }).then(totalsOf),
    getCostPerOrder(ctx, { since, until, source: "meta" }),
    getCostPerOrder(ctx, { since: prevSince, until: prevUntil, source: "meta" }),
    detectFatigue(ctx, { lookback_days: 14 }).catch(() => null),
    recentAlertEvents(ctx, 20),
    getCostPerOrder(ctx, { since, until, source: "meta", group_by: "ad" }),
  ]);
  // Ads ranked by what really matters once orders are linked to ads: cost per delivered order, then per order.
  const salesAds = byAd.rows
    .filter((r) => r.key !== "unattributed" && r.orders > 0 && r.spend > 0)
    .sort((a, b) => (a.cost_per_delivered_order ?? a.cost_per_order ?? Infinity) - (b.cost_per_delivered_order ?? b.cost_per_order ?? Infinity))
    .slice(0, 3)
    .map((r) => ({
      ad_id: r.key,
      ad_name: r.label,
      spend: r.spend,
      orders: r.orders,
      delivered: r.delivered,
      refused: r.refused,
      cost_per_order: r.cost_per_order,
      cost_per_delivered_order: r.cost_per_delivered_order,
    }));
  const cur = totalsOf(thisAds);
  const ranked = thisAds.filter((a) => a.spend > 0);
  const topAds = [...ranked]
    .filter((a) => a.conversations > 0)
    .sort((a, b) => (a.cost_per_conversation ?? Infinity) - (b.cost_per_conversation ?? Infinity))
    .slice(0, 3)
    .map((a) => ({ ad_id: a.ad_id, ad_name: a.ad_name, spend: a.spend, chats: a.conversations, cost_per_chat: a.cost_per_conversation }));
  const worstAds = [...ranked]
    .sort((a, b) => (b.cost_per_conversation ?? b.spend * 10) - (a.cost_per_conversation ?? a.spend * 10))
    .slice(0, 3)
    .map((a) => ({ ad_id: a.ad_id, ad_name: a.ad_name, spend: a.spend, chats: a.conversations, cost_per_chat: a.cost_per_conversation }));

  const data = {
    period: { since, until },
    previous_period: { since: prevSince, until: prevUntil },
    spend: cur.spend,
    spend_change_pct: pct(cur.spend, prevTotals.spend),
    chats: cur.conversations,
    chats_change_pct: pct(cur.conversations, prevTotals.conversations),
    cost_per_chat: cur.cost_per_conversation,
    cost_per_chat_change_pct: pct(cur.cost_per_conversation, prevTotals.cost_per_conversation),
    ctr: cur.ctr,
    orders: thisOrders.total.orders,
    delivered: thisOrders.total.delivered,
    pending: thisOrders.total.pending,
    refused: thisOrders.total.refused,
    revenue: thisOrders.total.revenue,
    revenue_delivered: thisOrders.total.revenue_delivered,
    cost_per_order: thisOrders.total.cost_per_order,
    cost_per_order_change_pct: pct(thisOrders.total.cost_per_order, prevOrders.total.cost_per_order),
    cost_per_delivered_order: thisOrders.total.cost_per_delivered_order,
    cost_per_delivered_order_change_pct: pct(thisOrders.total.cost_per_delivered_order, prevOrders.total.cost_per_delivered_order),
    refusal_rate_pct: thisOrders.total.refusal_rate_pct,
    roas: thisOrders.total.roas,
    roas_delivered: thisOrders.total.roas_delivered,
    best_selling_ads: salesAds,
    top_ads: topAds,
    worst_ads: worstAds,
    fatigued_ads: fatigue?.ads.filter((a) => a.fatigued).map((a) => ({ ad_id: a.ad_id, ad_name: a.ad_name, reasons: a.reasons })) ?? [],
    alerts_fired: alerts.filter((e) => e.at >= `${since}T00:00:00`).length,
  };

  const html = renderReportHtml(data);
  const settings = await getSettings(ctx);
  const to = opts.email_to ?? settings.alertEmail ?? undefined;
  let email: { sent: boolean; reason?: string } = { sent: false, reason: "Email not requested." };
  if (opts.send_email) {
    email = to ? await sendEmail(to, `Sandalez Ads weekly report ${since} – ${until}`, html) : { sent: false, reason: "No recipient (set the alert email in Settings)." };
  }
  const saved = await ctx.db.report.create({
    data: {
      kind: "weekly",
      periodStart: toDbDate(since),
      periodEnd: toDbDate(until),
      data: data as object,
      html,
      emailedTo: email.sent ? to ?? null : null,
    },
  });
  return { report_id: saved.id, ...data, email };
}

export async function listReports(ctx: CoreContext, limit = 20) {
  const rows = await ctx.db.report.findMany({ orderBy: { createdAt: "desc" }, take: limit });
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    period_start: r.periodStart.toISOString().slice(0, 10),
    period_end: r.periodEnd.toISOString().slice(0, 10),
    emailed_to: r.emailedTo,
    created_at: r.createdAt.toISOString(),
    data: r.data,
  }));
}

function money(v: number | null | undefined) {
  return v === null || v === undefined ? "—" : `PKR ${Math.round(v).toLocaleString("en-PK")}`;
}
function change(v: number | null) {
  return v === null ? "" : ` <span style="color:#555">(${v > 0 ? "+" : ""}${v}%)</span>`;
}

function renderReportHtml(d: any): string {
  const row = (label: string, value: string) =>
    `<tr><td style="padding:6px 12px;color:#555">${label}</td><td style="padding:6px 12px;font-weight:600">${value}</td></tr>`;
  const adList = (ads: any[]) =>
    ads.length
      ? `<ul>${ads.map((a) => `<li>${escapeHtml(a.ad_name ?? a.ad_id)} — ${money(a.spend)}, ${a.chats} chats, ${money(a.cost_per_chat)}/chat</li>`).join("")}</ul>`
      : "<p>None</p>";
  return `<!doctype html><html><body style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:640px;margin:auto;color:#111">
<h2>Sandalez Ads — weekly report</h2>
<p>${d.period.since} to ${d.period.until} (vs ${d.previous_period.since} to ${d.previous_period.until})</p>
<table style="border-collapse:collapse">
${row("Spend", money(d.spend) + change(d.spend_change_pct))}
${row("Chats", `${d.chats}${change(d.chats_change_pct)}`)}
${row("Cost per chat", money(d.cost_per_chat) + change(d.cost_per_chat_change_pct))}
${row("CTR", `${d.ctr}%`)}
${row("Orders", `${d.orders} (${d.delivered} delivered, ${d.pending} on the way, ${d.refused} refused)`)}
${row("Cost per order", money(d.cost_per_order) + change(d.cost_per_order_change_pct))}
${row("Cost per delivered order", money(d.cost_per_delivered_order) + change(d.cost_per_delivered_order_change_pct))}
${row("Refusal rate", d.refusal_rate_pct === null ? "—" : `${d.refusal_rate_pct}%`)}
${row("Revenue (delivered)", `${money(d.revenue)} (${money(d.revenue_delivered)})`)}
${row("ROAS (delivered)", `${d.roas === null ? "—" : `${d.roas}x`} (${d.roas_delivered === null ? "—" : `${d.roas_delivered}x`})`)}
</table>
<h3>Best-selling ads (lowest cost per delivered order)</h3>${
    d.best_selling_ads.length
      ? `<ul>${d.best_selling_ads.map((a: any) => `<li>${escapeHtml(a.ad_name ?? a.ad_id)} — ${money(a.spend)}, ${a.orders} orders (${a.delivered} delivered, ${a.refused} refused), ${money(a.cost_per_delivered_order ?? a.cost_per_order)}/order</li>`).join("")}</ul>`
      : "<p>No orders linked to ads yet.</p>"
  }
<h3>Best ads (lowest cost per chat)</h3>${adList(d.top_ads)}
<h3>Most expensive ads</h3>${adList(d.worst_ads)}
<h3>Fatigued ads</h3>${d.fatigued_ads.length ? `<ul>${d.fatigued_ads.map((a: any) => `<li>${escapeHtml(a.ad_name ?? a.ad_id)}: ${escapeHtml(a.reasons.join(", "))}</li>`).join("")}</ul>` : "<p>None</p>"}
<p style="color:#777">Alerts fired this week: ${d.alerts_fired}</p>
</body></html>`;
}
