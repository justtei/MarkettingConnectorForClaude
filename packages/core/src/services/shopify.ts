/**
 * Shopify order sync: pulls orders (Admin GraphQL API) into ShopOrder, works out each order's outcome
 * (pending / delivered / refused / cancelled) and links it to the ad that brought the customer, by matching
 * the order's phone number to a click-to-WhatsApp chat recorded by the WhatsApp webhook.
 */
import { audited } from "../audit.js";
import type { CoreContext } from "../context.js";
import { UserInputError } from "../guards.js";
import { addDays, fromDbDate, toDbDate, todayIn } from "../util/dates.js";
import { getCurrency } from "./account.js";
import { normalizePhone } from "./audiences.js";
import { ensureAdMirrored } from "./mirror.js";

export type OrderStatus = "pending" | "delivered" | "refused" | "cancelled";

const ORDER_QUERY = `query Orders($cursor: String, $query: String) {
  orders(first: 100, after: $cursor, query: $query, sortKey: UPDATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes {
      legacyResourceId
      name
      createdAt
      updatedAt
      cancelledAt
      test
      phone
      tags
      displayFinancialStatus
      displayFulfillmentStatus
      returnStatus
      totalPriceSet { shopMoney { amount currencyCode } }
      shippingAddress { phone }
      billingAddress { phone }
      fulfillments(first: 10) { displayStatus status }
    }
  }
}`;

export function shopifyConfigured(ctx: CoreContext): boolean {
  return Boolean(ctx.config.SHOPIFY_STORE_DOMAIN && ctx.config.SHOPIFY_ADMIN_TOKEN);
}

function requireShopify(ctx: CoreContext) {
  if (!shopifyConfigured(ctx)) {
    throw new UserInputError(
      "Shopify is not connected: set SHOPIFY_STORE_DOMAIN (e.g. sandalez.myshopify.com) and SHOPIFY_ADMIN_TOKEN in .env (docs/orders.md).",
    );
  }
}

export async function shopifyGraphql<T = any>(ctx: CoreContext, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  requireShopify(ctx);
  const base = ctx.config.SHOPIFY_BASE_URL ?? `https://${ctx.config.SHOPIFY_STORE_DOMAIN}`;
  const url = `${base}/admin/api/${ctx.config.SHOPIFY_API_VERSION}/graphql.json`;
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-shopify-access-token": ctx.config.SHOPIFY_ADMIN_TOKEN! },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(60_000),
    });
    const body: any = await res.json().catch(() => ({}));
    const throttled = res.status === 429 || body?.errors?.some?.((e: any) => e?.extensions?.code === "THROTTLED");
    if (throttled && attempt < 5) {
      await new Promise((r) => setTimeout(r, 1000 * attempt));
      continue;
    }
    if (res.status === 401 || res.status === 403) {
      throw new UserInputError(`Shopify refused the access token (HTTP ${res.status}). Check SHOPIFY_ADMIN_TOKEN and that the app has read_orders.`);
    }
    if (!res.ok || body.errors) {
      const msg = Array.isArray(body.errors) ? body.errors.map((e: any) => e.message).join("; ") : JSON.stringify(body.errors ?? body).slice(0, 300);
      throw new Error(`Shopify API error (HTTP ${res.status}): ${msg}`);
    }
    return body.data as T;
  }
}

/** The order's outcome for cost-per-order maths. Refusal = cancelled-after-shipping, returned, failed delivery or a refusal tag. */
export function orderStatus(o: any, refusedTags: string[]): OrderStatus {
  const tags: string[] = (o.tags ?? []).map((t: string) => t.trim().toLowerCase());
  const shipments: string[] = (o.fulfillments ?? []).map((f: any) => String(f.displayStatus ?? f.status ?? "").toUpperCase());
  const shipped = shipments.length > 0;
  if (tags.some((t) => refusedTags.includes(t))) return "refused";
  if (o.returnStatus === "RETURNED" || o.returnStatus === "INSPECTION_COMPLETE") return "refused";
  if (shipments.some((s) => s === "FAILURE" || s === "NOT_DELIVERED")) return "refused";
  if (o.cancelledAt) return shipped ? "refused" : "cancelled";
  if (shipments.some((s) => s === "DELIVERED")) return "delivered";
  // COD: the courier pays out once it is delivered, so "paid + fulfilled" means delivered.
  if (o.displayFinancialStatus === "PAID" && o.displayFulfillmentStatus === "FULFILLED") return "delivered";
  return "pending";
}

function orderPhone(o: any): string | null {
  for (const p of [o.phone, o.shippingAddress?.phone, o.billingAddress?.phone]) {
    if (p && String(p).replace(/\D/g, "").length >= 10) return normalizePhone(String(p));
  }
  return null;
}

/** Finds the latest click-to-WhatsApp chat from this phone in the attribution window before the order. */
async function chatForOrder(ctx: CoreContext, phone: string | null, orderDate: string) {
  if (!phone) return null;
  const since = addDays(orderDate, -ctx.config.ORDER_ATTRIBUTION_DAYS);
  return ctx.db.whatsappChat.findFirst({
    where: { waId: phone, adId: { not: null }, date: { gte: toDbDate(since), lte: toDbDate(orderDate) } },
    orderBy: { at: "desc" },
  });
}

/** Pulls orders updated since the last sync (or the last `days` days) and refreshes their status and ad link. */
export async function syncShopOrders(ctx: CoreContext, opts: { days?: number; full?: boolean } = {}) {
  requireShopify(ctx);
  const started = Date.now();
  const tz = ctx.config.DEFAULT_TIMEZONE;
  const refusedTags = ctx.config.SHOPIFY_REFUSED_TAGS.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
  const last = opts.full ? null : await ctx.db.setting.findUnique({ where: { key: "shop_sync_cursor" } });
  const sinceIso =
    (last?.value as { updated_at?: string } | null)?.updated_at ??
    new Date(Date.now() - (opts.days ?? 60) * 86_400_000).toISOString();
  const currency = await getCurrency(ctx).catch(() => "PKR");

  let cursor: string | null = null;
  let maxUpdated = sinceIso;
  const counts = { fetched: 0, saved: 0, linked: 0, skipped_test: 0 };
  do {
    // After a previous sync only strictly newer changes are read; the first sync starts at the window start.
    const filter = last ? `updated_at:>'${sinceIso}'` : `updated_at:>='${sinceIso}'`;
    const data: any = await shopifyGraphql(ctx, ORDER_QUERY, { cursor, query: filter });
    const page = data.orders;
    for (const o of page.nodes) {
      counts.fetched++;
      if (o.updatedAt > maxUpdated) maxUpdated = o.updatedAt;
      if (o.test) {
        counts.skipped_test++;
        continue;
      }
      const date = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(o.createdAt));
      const phone = orderPhone(o);
      const existing = await ctx.db.shopOrder.findUnique({ where: { id: String(o.legacyResourceId) } });
      let adId = existing?.adId ?? null;
      let attribution = existing?.attribution ?? null;
      let chatAt = existing?.chatAt ?? null;
      if (attribution !== "manual") {
        const chat = await chatForOrder(ctx, phone, date);
        if (chat?.adId && (await ensureAdMirrored(ctx, chat.adId, currency).catch(() => false))) {
          adId = chat.adId;
          attribution = "whatsapp_chat";
          chatAt = chat.at;
        }
      }
      const data = {
        name: o.name,
        createdAt: new Date(o.createdAt),
        date: toDbDate(date),
        updatedAt: new Date(o.updatedAt),
        phone,
        total: Math.round(Number(o.totalPriceSet?.shopMoney?.amount ?? 0)),
        currency: o.totalPriceSet?.shopMoney?.currencyCode ?? "PKR",
        status: orderStatus(o, refusedTags),
        financial: o.displayFinancialStatus ?? null,
        fulfillment: o.displayFulfillmentStatus ?? null,
        tags: o.tags ?? [],
        adId,
        attribution,
        chatAt,
      };
      await ctx.db.shopOrder.upsert({ where: { id: String(o.legacyResourceId) }, create: { id: String(o.legacyResourceId), ...data }, update: data });
      counts.saved++;
      if (adId) counts.linked++;
    }
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);

  // Chats that arrived after an order was first synced: link still-unlinked recent orders again.
  const recent = await ctx.db.shopOrder.findMany({
    where: { adId: null, attribution: null, date: { gte: toDbDate(addDays(todayIn(tz), -ctx.config.ORDER_ATTRIBUTION_DAYS)) } },
  });
  for (const o of recent) {
    const chat = await chatForOrder(ctx, o.phone, fromDbDate(o.date));
    if (chat?.adId) {
      await ctx.db.shopOrder.update({ where: { id: o.id }, data: { adId: chat.adId, attribution: "whatsapp_chat", chatAt: chat.at } });
      counts.linked++;
    }
  }
  await ctx.db.setting.upsert({
    where: { key: "shop_sync_cursor" },
    create: { key: "shop_sync_cursor", value: { updated_at: maxUpdated, at: new Date().toISOString() } },
    update: { value: { updated_at: maxUpdated, at: new Date().toISOString() } },
  });
  return { ok: true, since: sinceIso, ms: Date.now() - started, ...counts };
}

function serialize(o: any) {
  return {
    id: o.id,
    name: o.name,
    date: fromDbDate(o.date),
    status: o.status,
    total: o.total,
    phone_last4: o.phone ? o.phone.slice(-4) : null,
    ad_id: o.adId,
    ad_name: o.ad?.name ?? null,
    attribution: o.attribution,
    financial: o.financial,
    fulfillment: o.fulfillment,
    tags: o.tags,
  };
}

export async function listShopOrders(
  ctx: CoreContext,
  opts: { since?: string; until?: string; status?: OrderStatus; ad_id?: string; unlinked?: boolean; limit?: number } = {},
) {
  const rows = await ctx.db.shopOrder.findMany({
    where: {
      ...(opts.since || opts.until
        ? { date: { ...(opts.since ? { gte: toDbDate(opts.since) } : {}), ...(opts.until ? { lte: toDbDate(opts.until) } : {}) } }
        : {}),
      ...(opts.status ? { status: opts.status } : {}),
      ...(opts.ad_id ? { adId: opts.ad_id } : {}),
      ...(opts.unlinked ? { adId: null } : {}),
    },
    include: { ad: { select: { name: true } } },
    orderBy: { createdAt: "desc" },
    take: Math.min(opts.limit ?? 100, 1000),
  });
  const last = await ctx.db.setting.findUnique({ where: { key: "shop_sync_cursor" } });
  return { last_sync: (last?.value as any)?.at ?? null, count: rows.length, orders: rows.map(serialize) };
}

/** Links an order to an ad by hand (e.g. the customer said which ad), or clears the link (ad_id null). */
export async function linkShopOrder(ctx: CoreContext, input: { order: string; ad_id: string | null }) {
  const key = input.order.trim();
  const order = await ctx.db.shopOrder.findFirst({ where: { OR: [{ id: key }, { name: key.startsWith("#") ? key : `#${key}` }] } });
  if (!order) throw new UserInputError(`Order ${input.order} not found. Run sync_shop_orders first.`);
  if (input.ad_id && !(await ensureAdMirrored(ctx, input.ad_id, await getCurrency(ctx)))) {
    throw new UserInputError(`Ad ${input.ad_id} is not an ad of the Sandalez account.`);
  }
  return audited(ctx, "link_shop_order", { objectId: order.id, request: input, before: { ad_id: order.adId, attribution: order.attribution } }, async () => {
    const row = await ctx.db.shopOrder.update({
      where: { id: order.id },
      data: { adId: input.ad_id, attribution: input.ad_id ? "manual" : null, chatAt: null },
      include: { ad: { select: { name: true } } },
    });
    return serialize(row);
  });
}
