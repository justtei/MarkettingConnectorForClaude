/**
 * Optional integrations:
 * - WhatsApp Cloud API webhook: counts chats per ad from click-to-WhatsApp referrals.
 * - Shopify orders/create webhook: sends Purchase events to the Conversions API.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { CoreContext } from "../context.js";
import { fromDbDate, toDbDate, todayIn } from "../util/dates.js";
import { getCurrency } from "./account.js";
import { normalizePhone } from "./audiences.js";
import { ensureAdMirrored } from "./mirror.js";

/** Meta signs webhook bodies with the app secret: X-Hub-Signature-256: sha256=<hex>. */
export function verifyMetaSignature(rawBody: string | Buffer, header: string | undefined, appSecret: string): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest("hex");
  const got = header.slice(7);
  return got.length === expected.length && timingSafeEqual(Buffer.from(got, "hex"), Buffer.from(expected, "hex"));
}

/** Shopify signs webhooks with base64 HMAC-SHA256: X-Shopify-Hmac-Sha256. */
export function verifyShopifySignature(rawBody: string | Buffer, header: string | undefined, secret: string): boolean {
  if (!header) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("base64");
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Records the first message of each customer per day; attributes it to the ad from the CTWA referral. */
export async function handleWhatsappWebhook(ctx: CoreContext, payload: any) {
  const recorded: { wa_id: string; ad_id: string | null }[] = [];
  if (payload?.object !== "whatsapp_business_account") return { recorded, ignored: true };
  const currency = await getCurrency(ctx).catch(() => "PKR");
  const date = todayIn(ctx.config.DEFAULT_TIMEZONE);
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value ?? {};
      for (const msg of value.messages ?? []) {
        const waId: string | undefined = msg.from;
        if (!waId) continue;
        const ref = msg.referral;
        let adId: string | null = ref?.source_type === "ad" && /^\d+$/.test(ref.source_id ?? "") ? ref.source_id : null;
        if (adId) {
          try {
            if (!(await ensureAdMirrored(ctx, adId, currency))) adId = null;
          } catch (err) {
            ctx.log.warn({ err: String(err), adId }, "Could not mirror ad from WhatsApp referral");
            adId = null;
          }
        }
        const existing = await ctx.db.whatsappChat.findUnique({ where: { waId_date: { waId, date: toDbDate(date) } } });
        if (existing) {
          // Keep the first attribution of the day, but fill it in if the first message had none.
          if (!existing.adId && adId) await ctx.db.whatsappChat.update({ where: { id: existing.id }, data: { adId, sourceId: ref?.source_id, ctwaClid: ref?.ctwa_clid ?? null } });
          continue;
        }
        await ctx.db.whatsappChat.create({
          data: {
            waId,
            adId,
            sourceId: ref?.source_id ?? null,
            ctwaClid: ref?.ctwa_clid ?? null,
            headline: ref?.headline ?? null,
            firstText: (msg.text?.body ?? "").slice(0, 500) || null,
            date: toDbDate(date),
          },
        });
        recorded.push({ wa_id: waId, ad_id: adId });
      }
    }
  }
  return { recorded, ignored: false };
}

/** Chats per day (and per ad) from the WhatsApp webhook, for the Orders page. */
export async function chatCounts(ctx: CoreContext, since: string, until: string) {
  const rows = await ctx.db.whatsappChat.groupBy({
    by: ["date", "adId"],
    where: { date: { gte: toDbDate(since), lte: toDbDate(until) } },
    _count: { _all: true },
  });
  return rows.map((r) => ({ date: fromDbDate(r.date), ad_id: r.adId, chats: r._count._all }));
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** Sends one Shopify order to the Conversions API as a Purchase event (deduplicated by order ID). */
export async function sendShopifyPurchase(ctx: CoreContext, order: any) {
  if (!ctx.config.META_PIXEL_ID) throw new Error("META_PIXEL_ID is not configured.");
  const email: string | undefined = order.email ?? order.customer?.email ?? undefined;
  const phone: string | undefined = order.phone ?? order.customer?.phone ?? order.shipping_address?.phone ?? order.billing_address?.phone ?? undefined;
  const addr = order.shipping_address ?? order.billing_address ?? {};
  const userData: Record<string, unknown> = {};
  if (email) userData.em = [sha(email.trim().toLowerCase())];
  if (phone) userData.ph = [sha(normalizePhone(phone))];
  if (addr.first_name) userData.fn = [sha(String(addr.first_name).trim().toLowerCase())];
  if (addr.last_name) userData.ln = [sha(String(addr.last_name).trim().toLowerCase())];
  if (addr.city) userData.ct = [sha(String(addr.city).replace(/\s+/g, "").toLowerCase())];
  if (addr.country_code) userData.country = [sha(String(addr.country_code).toLowerCase())];
  if (order.customer?.id) userData.external_id = [sha(String(order.customer.id))];
  if (order.client_details?.browser_ip) userData.client_ip_address = order.client_details.browser_ip;
  if (order.client_details?.user_agent) userData.client_user_agent = order.client_details.user_agent;

  const event = {
    event_name: "Purchase",
    event_time: Math.floor(new Date(order.created_at ?? Date.now()).getTime() / 1000),
    event_id: `shopify-order-${order.id}`,
    action_source: "website",
    event_source_url: order.order_status_url ?? undefined,
    user_data: userData,
    custom_data: {
      currency: order.currency ?? "PKR",
      value: Number(order.total_price ?? order.current_total_price ?? 0),
      order_id: String(order.id),
      contents: (order.line_items ?? []).slice(0, 50).map((li: any) => ({
        id: String(li.sku || li.product_id || li.id),
        quantity: li.quantity ?? 1,
        item_price: Number(li.price ?? 0),
      })),
      content_type: "product",
    },
  };
  const res = await ctx.meta.post<{ events_received?: number; fbtrace_id?: string }>(`${ctx.config.META_PIXEL_ID}/events`, {
    data: [event],
    ...(process.env.META_CAPI_TEST_EVENT_CODE ? { test_event_code: process.env.META_CAPI_TEST_EVENT_CODE } : {}),
  });
  await ctx.db.auditLog.create({
    data: {
      actor: ctx.actor,
      action: "capi_purchase",
      objectId: String(order.id),
      request: { order_id: String(order.id), value: event.custom_data.value, currency: event.custom_data.currency },
      response: res as object,
    },
  });
  return { events_received: res.events_received ?? 0, event_id: event.event_id };
}
