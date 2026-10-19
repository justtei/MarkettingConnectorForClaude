import type { z } from "zod";
import { audited } from "../audit.js";
import type { CoreContext } from "../context.js";
import { GuardError, UserInputError } from "../guards.js";
import { logOrdersInput, type costPerOrderInput, type orderPatchInput } from "../schemas.js";
import { eachDay, fromDbDate, resolveRange, toDbDate } from "../util/dates.js";
import { getCurrency } from "./account.js";
import { fetchInsights } from "./insights.js";
import { ensureAdMirrored } from "./mirror.js";

type LogOrders = z.input<typeof logOrdersInput>;

function validateCounts(o: { chats: number; orders: number; refused?: number }) {
  if ((o.refused ?? 0) > o.orders) throw new UserInputError("Refused orders cannot exceed orders.");
}

async function checkAd(ctx: CoreContext, adId: string | undefined | null) {
  if (!adId) return;
  const ok = await ensureAdMirrored(ctx, adId, await getCurrency(ctx));
  if (!ok) throw new GuardError("wrong_account", `Ad ${adId} does not belong to the Sandalez ad account.`);
}

function serialize(o: any) {
  return {
    id: o.id,
    date: fromDbDate(o.date),
    ad_id: o.adId,
    ad_name: o.ad?.name ?? null,
    chats: o.chats,
    orders: o.orders,
    refused: o.refused,
    delivered: o.orders - o.refused,
    revenue: o.revenue,
    note: o.note,
    created_by: o.createdBy ?? null,
  };
}

export async function logOrders(ctx: CoreContext, input: LogOrders) {
  validateCounts(input);
  await checkAd(ctx, input.ad_id);
  return audited(ctx, "log_orders", { objectId: input.ad_id ?? null, request: input }, async () => {
    const row = await ctx.db.orderLog.create({
      data: {
        date: toDbDate(input.date),
        adId: input.ad_id ?? null,
        chats: input.chats,
        orders: input.orders,
        refused: input.refused ?? 0,
        revenue: Math.round(input.revenue),
        note: input.note ?? null,
        createdBy: ctx.actor,
      },
      include: { ad: { select: { name: true } } },
    });
    return serialize(row);
  });
}

export async function updateOrder(ctx: CoreContext, id: string, patch: z.infer<typeof orderPatchInput>) {
  const before = await ctx.db.orderLog.findUnique({ where: { id } });
  if (!before) throw new UserInputError(`Order log row ${id} not found.`);
  const next = {
    chats: patch.chats ?? before.chats,
    orders: patch.orders ?? before.orders,
    refused: patch.refused ?? before.refused,
  };
  validateCounts(next);
  if (patch.ad_id) await checkAd(ctx, patch.ad_id);
  return audited(ctx, "update_order_log", { objectId: id, request: patch, before: serialize(before) }, async () => {
    const row = await ctx.db.orderLog.update({
      where: { id },
      data: {
        ...(patch.date ? { date: toDbDate(patch.date) } : {}),
        ...(patch.ad_id !== undefined ? { adId: patch.ad_id || null } : {}),
        ...next,
        ...(patch.revenue !== undefined ? { revenue: Math.round(patch.revenue) } : {}),
        ...(patch.note !== undefined ? { note: patch.note || null } : {}),
      },
      include: { ad: { select: { name: true } } },
    });
    return serialize(row);
  });
}

export async function deleteOrder(ctx: CoreContext, id: string) {
  const before = await ctx.db.orderLog.findUnique({ where: { id } });
  if (!before) throw new UserInputError(`Order log row ${id} not found.`);
  return audited(ctx, "delete_order_log", { objectId: id, request: { id }, before: serialize(before) }, async () => {
    await ctx.db.orderLog.delete({ where: { id } });
    return { deleted: id };
  });
}

export async function listOrders(ctx: CoreContext, opts: { since?: string; until?: string; ad_id?: string; limit?: number } = {}) {
  const rows = await ctx.db.orderLog.findMany({
    where: {
      ...(opts.since || opts.until
        ? { date: { ...(opts.since ? { gte: toDbDate(opts.since) } : {}), ...(opts.until ? { lte: toDbDate(opts.until) } : {}) } }
        : {}),
      ...(opts.ad_id ? { adId: opts.ad_id } : {}),
    },
    include: { ad: { select: { name: true } } },
    orderBy: [{ date: "desc" }, { createdAt: "desc" }],
    take: Math.min(opts.limit ?? 500, 5000),
  });
  return rows.map(serialize);
}

/** CSV columns: date,ad_id,chats,orders,refused,revenue,note (header row required). */
export async function importOrdersCsv(ctx: CoreContext, csv: string) {
  const lines = csv.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length < 2) throw new UserInputError("The CSV needs a header row and at least one data row.");
  const header = parseCsvLine(lines[0]!).map((h) => h.trim().toLowerCase());
  for (const col of ["date", "chats", "orders", "revenue"]) {
    if (!header.includes(col)) throw new UserInputError(`The CSV is missing the "${col}" column.`);
  }
  const imported: unknown[] = [];
  const errors: { line: number; error: string }[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i]!);
    const rec = Object.fromEntries(header.map((h, j) => [h, (cells[j] ?? "").trim()]));
    const parsed = logOrdersInput.safeParse({
      date: rec.date,
      ad_id: rec.ad_id || undefined,
      chats: Number(rec.chats || 0),
      orders: Number(rec.orders || 0),
      refused: Number(rec.refused || 0),
      revenue: Number(String(rec.revenue || 0).replace(/[, ]|PKR|Rs\.?/gi, "")),
      note: rec.note || undefined,
    });
    if (!parsed.success) {
      errors.push({ line: i + 1, error: parsed.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("; ") });
      continue;
    }
    try {
      imported.push(await logOrders(ctx, parsed.data));
    } catch (err) {
      errors.push({ line: i + 1, error: (err as Error).message });
    }
  }
  return { imported: imported.length, errors };
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

interface Bucket {
  key: string;
  label: string;
  spend: number;
  conversations: number;
  chats: number;
  orders: number;
  refused: number;
  revenue: number;
}

function finish(b: Bucket) {
  const delivered = b.orders - b.refused;
  const r = (x: number) => Math.round(x * 100) / 100;
  return {
    key: b.key,
    label: b.label,
    spend: r(b.spend),
    conversations: b.conversations,
    chats_logged: b.chats,
    orders: b.orders,
    refused: b.refused,
    delivered,
    revenue: b.revenue,
    cost_per_chat: b.conversations ? r(b.spend / b.conversations) : null,
    cost_per_order: b.orders ? r(b.spend / b.orders) : null,
    cost_per_delivered_order: delivered > 0 ? r(b.spend / delivered) : null,
    refusal_rate_pct: b.orders ? r((b.refused / b.orders) * 100) : null,
    chat_to_order_pct: b.chats ? r((b.orders / b.chats) * 100) : null,
    roas: b.spend ? r(b.revenue / b.spend) : null,
  };
}

/** Joins ad spend (Meta live or synced DB) with the order log. */
export async function getCostPerOrder(ctx: CoreContext, input: z.input<typeof costPerOrderInput>) {
  const range = resolveRange(input, ctx.config.DEFAULT_TIMEZONE);
  const groupBy = input.group_by ?? "total";
  const source = input.source ?? "meta";
  const buckets = new Map<string, Bucket>();
  const bucket = (key: string, label: string) => {
    let b = buckets.get(key);
    if (!b) {
      b = { key, label, spend: 0, conversations: 0, chats: 0, orders: 0, refused: 0, revenue: 0 };
      buckets.set(key, b);
    }
    return b;
  };
  const keyFor = (date: string, adId: string | null) =>
    groupBy === "total" ? "total" : groupBy === "day" ? date : adId ?? "unattributed";

  if (groupBy === "day") for (const d of eachDay(range.since, range.until)) bucket(d, d);

  let spendSource = source;
  if (source === "meta") {
    try {
      const rows = await fetchInsights(ctx, {
        level: groupBy === "ad" ? "ad" : "account",
        range,
        timeIncrement: groupBy === "day" ? 1 : "all_days",
      });
      for (const r of rows) {
        const key = keyFor(r.date_start, r.ad_id ?? null);
        const b = bucket(key, groupBy === "ad" ? r.ad_name ?? key : key);
        b.spend += r.spend;
        b.conversations += r.conversations;
      }
    } catch (err) {
      ctx.log.warn({ err: String(err) }, "Meta spend unavailable; falling back to synced DB stats");
      spendSource = "db";
    }
  }
  if (spendSource === "db") {
    const stats = await ctx.db.dailyStat.findMany({
      where: { date: { gte: toDbDate(range.since), lte: toDbDate(range.until) } },
      include: { ad: { select: { name: true } } },
    });
    for (const s of stats) {
      const key = keyFor(fromDbDate(s.date), s.adId);
      const b = bucket(key, groupBy === "ad" ? s.ad.name : key);
      b.spend += Number(s.spend);
      b.conversations += s.conversations;
    }
  }

  const orders = await ctx.db.orderLog.findMany({
    where: { date: { gte: toDbDate(range.since), lte: toDbDate(range.until) } },
    include: { ad: { select: { name: true } } },
  });
  for (const o of orders) {
    const key = keyFor(fromDbDate(o.date), o.adId);
    const b = bucket(key, groupBy === "ad" ? o.ad?.name ?? (o.adId ? key : "Not linked to an ad") : key);
    b.chats += o.chats;
    b.orders += o.orders;
    b.refused += o.refused;
    b.revenue += o.revenue;
  }
  if (groupBy === "total") bucket("total", "total");

  const rows = [...buckets.values()].map(finish).sort((a, b) => (groupBy === "day" ? a.key.localeCompare(b.key) : b.spend - a.spend));
  const total = finish(
    [...buckets.values()].reduce(
      (a, b) => ({
        ...a,
        spend: a.spend + b.spend,
        conversations: a.conversations + b.conversations,
        chats: a.chats + b.chats,
        orders: a.orders + b.orders,
        refused: a.refused + b.refused,
        revenue: a.revenue + b.revenue,
      }),
      { key: "total", label: "total", spend: 0, conversations: 0, chats: 0, orders: 0, refused: 0, revenue: 0 } as Bucket,
    ),
  );
  return {
    range,
    group_by: groupBy,
    spend_source: spendSource,
    currency: await getCurrency(ctx),
    total,
    rows: groupBy === "total" ? [] : rows,
    notes: orders.length === 0 ? ["No orders logged in this period. Use log_orders to record them."] : [],
  };
}
