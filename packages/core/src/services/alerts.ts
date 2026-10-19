import { Prisma } from "@sandalez/db";
import { z } from "zod";
import { audited } from "../audit.js";
import type { CoreContext } from "../context.js";
import { sendEmail } from "../email.js";
import { resolveOwnedObject, UserInputError } from "../guards.js";
import { todayIn } from "../util/dates.js";
import { fetchInsights, levelFor, totalsOf } from "./insights.js";
import { getSettings } from "./settings.js";

export const alertMetric = z.enum(["cost_per_chat", "spend", "frequency", "ctr", "spend_stopped"]);

export const setAlertInput = z.object({
  metric: alertMetric.describe(
    "cost_per_chat (PKR, today), spend (PKR, today), frequency (last 7 days), ctr (% today), spend_stopped (no spend today by noon while campaigns are active)",
  ),
  operator: z.enum(["gt", "lt"]).default("gt"),
  threshold: z.number().min(0).default(0),
  object_id: z.string().regex(/^\d+$/).optional().describe("Campaign/ad set/ad; omit for the whole account."),
  name: z.string().max(200).optional(),
});

const COOLDOWN_MS = 6 * 60 * 60 * 1000;

function describeAlert(a: { metric: string; operator: string; threshold: Prisma.Decimal | number; objectId: string | null; name: string | null }) {
  if (a.name) return a.name;
  const op = a.operator === "gt" ? "above" : "below";
  const scope = a.objectId ? ` for ${a.objectId}` : "";
  if (a.metric === "spend_stopped") return `Spend stopped${scope}`;
  return `${a.metric.replace(/_/g, " ")} ${op} ${Number(a.threshold)}${scope}`;
}

function serialize(a: any) {
  return {
    id: a.id,
    name: describeAlert(a),
    metric: a.metric,
    operator: a.operator,
    threshold: Number(a.threshold),
    object_id: a.objectId,
    active: a.active,
    muted_until: a.mutedUntil?.toISOString() ?? null,
    last_triggered_at: a.lastTriggeredAt?.toISOString() ?? null,
  };
}

export async function setAlert(ctx: CoreContext, raw: z.input<typeof setAlertInput>) {
  const input = setAlertInput.parse(raw);
  if (input.object_id) await resolveOwnedObject(ctx, input.object_id);
  return audited(ctx, "set_alert", { request: input }, async () => {
    const a = await ctx.db.alert.create({
      data: {
        metric: input.metric,
        operator: input.operator,
        threshold: new Prisma.Decimal(input.threshold),
        objectId: input.object_id ?? null,
        name: input.name ?? null,
      },
    });
    return serialize(a);
  });
}

export async function listAlerts(ctx: CoreContext, opts: { withEvents?: number } = {}) {
  const alerts = await ctx.db.alert.findMany({
    orderBy: { createdAt: "desc" },
    include: opts.withEvents ? { events: { orderBy: { at: "desc" }, take: opts.withEvents } } : undefined,
  });
  return alerts.map((a: any) => ({
    ...serialize(a),
    ...(a.events
      ? { events: a.events.map((e: any) => ({ at: e.at.toISOString(), value: Number(e.value), message: e.message })) }
      : {}),
  }));
}

export async function updateAlert(ctx: CoreContext, id: string, patch: { active?: boolean; mute_hours?: number | null }) {
  const before = await ctx.db.alert.findUnique({ where: { id } });
  if (!before) throw new UserInputError(`Alert ${id} not found.`);
  return audited(ctx, "update_alert", { objectId: id, request: patch, before: serialize(before) }, async () => {
    const a = await ctx.db.alert.update({
      where: { id },
      data: {
        ...(patch.active !== undefined ? { active: patch.active } : {}),
        ...(patch.mute_hours !== undefined
          ? { mutedUntil: patch.mute_hours ? new Date(Date.now() + patch.mute_hours * 3_600_000) : null }
          : {}),
      },
    });
    return serialize(a);
  });
}

export async function deleteAlert(ctx: CoreContext, id: string) {
  const before = await ctx.db.alert.findUnique({ where: { id } });
  if (!before) throw new UserInputError(`Alert ${id} not found.`);
  return audited(ctx, "delete_alert", { objectId: id, request: { id }, before: serialize(before) }, async () => {
    await ctx.db.alert.delete({ where: { id } });
    return { deleted: id };
  });
}

export async function recentAlertEvents(ctx: CoreContext, limit = 50) {
  const events = await ctx.db.alertEvent.findMany({ orderBy: { at: "desc" }, take: limit, include: { alert: true } });
  return events.map((e) => ({
    id: e.id,
    at: e.at.toISOString(),
    alert_id: e.alertId,
    alert: describeAlert(e.alert),
    value: Number(e.value),
    message: e.message,
  }));
}

/** Evaluates every active, unmuted alert against live Meta numbers. Called by the worker. */
export async function evaluateAlerts(ctx: CoreContext, now = new Date()) {
  const alerts = await ctx.db.alert.findMany({ where: { active: true } });
  const fired: { alert_id: string; message: string; value: number }[] = [];
  const cache = new Map<string, Awaited<ReturnType<typeof metricsFor>>>();
  const tz = ctx.config.DEFAULT_TIMEZONE;
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hour12: false }).format(now));

  for (const a of alerts) {
    if (a.mutedUntil && a.mutedUntil > now) continue;
    if (a.lastTriggeredAt && now.getTime() - a.lastTriggeredAt.getTime() < COOLDOWN_MS) continue;
    const key = a.objectId ?? "account";
    let m = cache.get(key);
    if (!m) {
      try {
        m = await metricsFor(ctx, a.objectId);
      } catch (err) {
        ctx.log.warn({ err: String(err), alert: a.id }, "Alert metrics unavailable");
        continue;
      }
      cache.set(key, m);
    }
    const threshold = Number(a.threshold);
    let value: number | null = null;
    let hit = false;
    switch (a.metric) {
      case "spend":
        value = m.today.spend;
        break;
      case "cost_per_chat":
        // No chats yet but spend above the threshold counts as "above".
        value = m.today.cost_per_conversation ?? (m.today.spend > threshold ? m.today.spend : null);
        break;
      case "ctr":
        value = m.today.impressions >= 500 ? m.today.ctr : null;
        break;
      case "frequency":
        value = m.frequency7d;
        break;
      case "spend_stopped":
        value = m.today.spend;
        hit = hour >= 12 && m.activeCampaigns > 0 && m.today.spend === 0;
        break;
    }
    if (a.metric !== "spend_stopped" && value !== null) hit = a.operator === "gt" ? value > threshold : value < threshold;
    if (!hit || value === null) continue;

    const message =
      a.metric === "spend_stopped"
        ? `No spend today (${todayIn(tz)}) although ${m.activeCampaigns} campaign(s) are active. Check payment method, ad approval and budgets.`
        : `${describeAlert(a)} — current value ${value}`;
    await ctx.db.alertEvent.create({ data: { alertId: a.id, value: new Prisma.Decimal(value), message, objectId: a.objectId } });
    await ctx.db.alert.update({ where: { id: a.id }, data: { lastTriggeredAt: now } });
    fired.push({ alert_id: a.id, message, value });
  }

  if (fired.length) {
    const settings = await getSettings(ctx);
    if (settings.alertEmail) {
      const html = `<h2>Sandalez Ads alerts</h2><ul>${fired.map((f) => `<li>${escapeHtml(f.message)}</li>`).join("")}</ul>`;
      await sendEmail(settings.alertEmail, `Sandalez Ads: ${fired.length} alert(s)`, html);
    }
  }
  return { checked: alerts.length, fired };
}

async function metricsFor(ctx: CoreContext, objectId: string | null) {
  const target = objectId ?? undefined;
  const level = await levelFor(ctx, target);
  const [todayRows, weekRows] = await Promise.all([
    fetchInsights(ctx, { objectId: target, level, range: { date_preset: "today" } }),
    fetchInsights(ctx, { objectId: target, level, range: { date_preset: "last_7d" } }),
  ]);
  const activeCampaigns = await ctx.db.campaign.count({ where: { status: "ACTIVE" } });
  return { today: totalsOf(todayRows), frequency7d: weekRows[0]?.frequency ?? 0, activeCampaigns };
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
