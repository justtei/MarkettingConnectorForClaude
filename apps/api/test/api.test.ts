import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { hashPassword, getDb } from "@sandalez/db";
import { addDays, todayIn } from "@sandalez/core";
import { buildApi } from "../src/app.js";
import { bootstrapOwner } from "../src/routes/auth.js";
import { startHarness, type Harness } from "../../../test/harness.js";

const SECRET = "internal-secret-0123456789abcdef";
let h: Harness;
let app: FastifyInstance;
const db = getDb();

const owner = { "x-internal-secret": SECRET, "x-user-email": "owner@sandalez.pk", "x-user-role": "owner" };
const staff = { "x-internal-secret": SECRET, "x-user-email": "staff@sandalez.pk", "x-user-role": "staff" };

beforeAll(async () => {
  h = await startHarness();
  app = buildApi(h.core, { internalSecret: SECRET, whatsappVerifyToken: "verify-me", shopifySecret: "shop-secret" });
  await app.ready();
});
afterAll(async () => {
  await app?.close();
  await h?.close();
});

describe("auth boundary", () => {
  it("health is public", async () => {
    expect((await app.inject("/health")).statusCode).toBe(200);
  });

  it("refuses /api without the internal secret or user", async () => {
    expect((await app.inject({ url: "/api/overview" })).statusCode).toBe(401);
    expect((await app.inject({ url: "/api/overview", headers: { "x-internal-secret": "nope" } })).statusCode).toBe(401);
    expect((await app.inject({ url: "/api/overview", headers: { "x-internal-secret": SECRET } })).statusCode).toBe(401);
    expect((await app.inject({ url: "/api/overview", headers: { ...owner, "x-user-role": "admin" } })).statusCode).toBe(401);
  });

  it("refuses to start with a short secret", () => {
    expect(() => buildApi(h.core, { internalSecret: "short" })).toThrow(/24 characters/);
  });

  it("bootstraps the first owner and logs in with the right password only", async () => {
    expect(await bootstrapOwner(h.core, "Owner@Sandalez.pk", "correct-horse-battery")).toBe("owner@sandalez.pk");
    expect(await bootstrapOwner(h.core, "x@y.z", "another-password")).toBeNull(); // only when empty
    const login = (password: string, ip = "1.1.1.1") =>
      app.inject({ method: "POST", url: "/api/auth/login", headers: { "x-internal-secret": SECRET, "x-client-ip": ip }, payload: { email: "owner@sandalez.pk", password } });
    const ok = await login("correct-horse-battery");
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ email: "owner@sandalez.pk", role: "owner" });
    expect((await login("wrong")).statusCode).toBe(401);
  });

  it("locks out after 5 failed logins from the same IP", async () => {
    const login = (password: string) =>
      app.inject({ method: "POST", url: "/api/auth/login", headers: { "x-internal-secret": SECRET, "x-client-ip": "9.9.9.9" }, payload: { email: "owner@sandalez.pk", password } });
    for (let i = 0; i < 5; i++) expect((await login("bad")).statusCode).toBe(401);
    expect((await login("correct-horse-battery")).statusCode).toBe(429);
    expect(await db.auditLog.count({ where: { action: "login_failed" } })).toBeGreaterThanOrEqual(5);
  });

  it("owner manages users; staff cannot", async () => {
    const add = await app.inject({ method: "POST", url: "/api/users", headers: owner, payload: { email: "staff@sandalez.pk", password: "staff-password-1", role: "staff" } });
    expect(add.statusCode).toBe(200);
    expect((await app.inject({ url: "/api/users", headers: staff })).statusCode).toBe(403);
    const list = await app.inject({ url: "/api/users", headers: owner });
    expect(list.json().map((u: any) => u.email)).toEqual(["owner@sandalez.pk", "staff@sandalez.pk"]);
    expect(list.body).not.toContain("passwordHash");
    const self = await app.inject({ method: "DELETE", url: "/api/users/owner@sandalez.pk", headers: owner });
    expect(self.statusCode).toBe(400);
  });
});

describe("tools endpoint (same guards as MCP)", () => {
  it("staff sees only staff-allowed tools", async () => {
    const all = (await app.inject({ url: "/api/tools", headers: owner })).json();
    const staffTools = (await app.inject({ url: "/api/tools", headers: staff })).json();
    expect(staffTools.length).toBeLessThan(all.length);
    expect(staffTools.map((t: any) => t.name)).toContain("log_orders");
    expect(staffTools.map((t: any) => t.name)).not.toContain("set_status");
  });

  it("staff cannot run owner tools", async () => {
    const r = await app.inject({ method: "POST", url: "/api/tools/create_campaign", headers: staff, payload: { name: "x" } });
    expect(r.statusCode).toBe(403);
  });

  it("owner creates a CTWA campaign from the dashboard (PAUSED, audited as the user)", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/tools/create_ctwa_campaign",
      headers: owner,
      payload: {
        name: "Dashboard-CTWA",
        daily_budget: 500,
        primary_text: "Flats 30% OFF",
        creatives: [{ type: "image", image_url: `${h.mock.baseUrl}/__mock/media/sample.jpg` }],
      },
    });
    expect(r.statusCode, r.body).toBe(200);
    const body = r.json();
    expect(h.mock.objects.get(body.campaign_id)!.status).toBe("PAUSED");
    const audit = await db.auditLog.findFirst({ where: { action: "create_ctwa_campaign" } });
    expect(audit?.actor).toBe("owner@sandalez.pk");
    expect((audit?.request as any).via).toBe("dashboard");
    expect((await db.campaign.findUnique({ where: { id: body.campaign_id } }))?.createdVia).toBe("dashboard");
  });

  it("maps guard refusals to 409 and validation errors to 400", async () => {
    const big = await app.inject({ method: "POST", url: "/api/tools/create_campaign", headers: owner, payload: { name: "x", daily_budget: 99999 } });
    expect(big.statusCode).toBe(409);
    expect(big.json().rule).toBe("budget_cap");
    const bad = await app.inject({ method: "POST", url: "/api/tools/create_campaign", headers: owner, payload: {} });
    expect(bad.statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/tools/nope", headers: owner, payload: {} })).statusCode).toBe(404);
  });

  it("set_status ACTIVE without confirm -> 409", async () => {
    const c = (await db.campaign.findFirst({ where: { name: "Dashboard-CTWA" } }))!;
    const r = await app.inject({ method: "POST", url: "/api/tools/set_status", headers: owner, payload: { object_id: c.id, status: "ACTIVE" } });
    expect(r.statusCode).toBe(409);
    expect(r.json().rule).toBe("confirm_required");
  });
});

describe("dashboard reads", () => {
  beforeAll(async () => {
    const r = await app.inject({ method: "POST", url: "/api/sync", headers: owner, payload: { days: 30 } });
    expect(r.statusCode, r.body).toBe(200);
  });

  it("staff cannot trigger a sync", async () => {
    expect((await app.inject({ method: "POST", url: "/api/sync", headers: staff, payload: {} })).statusCode).toBe(403);
  });

  it("overview has today/7d/30d KPIs and a daily series", async () => {
    const r = await app.inject({ url: "/api/overview?days=30", headers: staff });
    expect(r.statusCode).toBe(200);
    const o = r.json();
    expect(o.series).toHaveLength(30);
    expect(o.last_7d.spend).toBeGreaterThan(0);
    expect(o.last_7d.cost_per_chat).toBeGreaterThan(0);
    expect(o.last_sync.ok).toBe(true);
    expect(o.active_campaigns).toBe(1);
    expect((await app.inject({ url: "/api/overview?days=0", headers: staff })).statusCode).toBe(400);
  });

  it("campaign tree with stats", async () => {
    const r = await app.inject({ url: "/api/campaigns?days=7", headers: staff });
    const seeded = r.json().campaigns.find((c: any) => c.name === "SZ-KHI-Existing-WA");
    expect(seeded.adsets[0].ads).toHaveLength(3);
    expect(seeded.stats.spend).toBeGreaterThan(0);
    expect(seeded.adsets[0].daily_budget).toBe(600);
  });

  it("ad detail includes daily stats, video watch and the preview", async () => {
    const ad = (await db.ad.findFirst({ where: { name: "A1-Wedding-Pearl" } }))!;
    const r = await app.inject({ url: `/api/ads/${ad.id}`, headers: staff });
    expect(r.statusCode).toBe(200);
    const d = r.json();
    expect(d.daily.length).toBeGreaterThan(20);
    expect(d.video.completion_pct).toBeGreaterThan(0);
    expect(d.preview_html).toContain("iframe");
    expect((await app.inject({ url: "/api/ads/123", headers: staff })).statusCode).toBe(400);
  });

  it("creatives performance", async () => {
    const r = await app.inject({ url: "/api/creatives", headers: staff });
    expect(r.json().creatives.length).toBeGreaterThan(2);
  });

  it("settings + token + account", async () => {
    const s = await app.inject({ url: "/api/settings", headers: staff });
    expect(s.json()).toMatchObject({ api_version: "v26.0", settings: { maxDailyBudgetPkr: 2000 } });
    expect((await app.inject({ url: "/api/settings/token", headers: staff })).json().healthy).toBe(true);
    expect((await app.inject({ url: "/api/account", headers: staff })).json().currency).toBe("PKR");
  });

  it("only the owner edits caps; invalid values are refused; changes are audited", async () => {
    expect((await app.inject({ method: "PUT", url: "/api/settings", headers: staff, payload: { maxDailyBudgetPkr: 5000 } })).statusCode).toBe(403);
    expect((await app.inject({ method: "PUT", url: "/api/settings", headers: owner, payload: { maxDailyBudgetPkr: -1 } })).statusCode).toBe(400);
    const r = await app.inject({ method: "PUT", url: "/api/settings", headers: owner, payload: { maxDailyBudgetPkr: 3000, alertEmail: "owner@sandalez.pk" } });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().maxDailyBudgetPkr).toBe(3000);
    const a = await db.auditLog.findFirst({ where: { action: "update_settings" } });
    expect((a?.before as any).maxDailyBudgetPkr).toBe(2000);
    await app.inject({ method: "PUT", url: "/api/settings", headers: owner, payload: { maxDailyBudgetPkr: 2000 } });
  });

  it("activity log paginates", async () => {
    const p1 = (await app.inject({ url: "/api/activity?limit=3", headers: staff })).json();
    expect(p1.items).toHaveLength(3);
    const p2 = (await app.inject({ url: `/api/activity?limit=3&before=${encodeURIComponent(p1.next_before)}`, headers: staff })).json();
    expect(p2.items[0].id).not.toBe(p1.items[0].id);
  });

  it("targeting search for the wizard", async () => {
    expect((await app.inject({ url: "/api/targeting/locations?q=Kar", headers: owner })).json()[0].name).toBe("Karachi");
    expect((await app.inject({ url: "/api/targeting/interests?q=wedding", headers: owner })).json()[0].name).toBe("Wedding");
  });
});

describe("orders (staff allowed)", () => {
  let rowId = "";
  it("staff adds, edits and deletes order rows", async () => {
    const add = await app.inject({ method: "POST", url: "/api/orders", headers: staff, payload: { date: addDays(todayIn(), -1), chats: 20, orders: 6, refused: 1, revenue: 15000 } });
    expect(add.statusCode, add.body).toBe(200);
    rowId = add.json().id;
    expect(add.json().created_by).toBe("staff@sandalez.pk");
    const edit = await app.inject({ method: "PATCH", url: `/api/orders/${rowId}`, headers: staff, payload: { orders: 7 } });
    expect(edit.json()).toMatchObject({ orders: 7, delivered: 6 });
    const bad = await app.inject({ method: "PATCH", url: `/api/orders/${rowId}`, headers: staff, payload: { refused: 99 } });
    expect(bad.statusCode).toBe(400);
    const missing = await app.inject({ method: "PATCH", url: `/api/orders/nope`, headers: staff, payload: { orders: 1 } });
    expect(missing.statusCode).toBe(400);
  });

  it("CSV import reports per-line errors", async () => {
    const ad = (await db.ad.findFirst({ where: { name: "A2-Everyday-Flats" } }))!;
    const csv = [
      "date,ad_id,chats,orders,refused,revenue,note",
      `${addDays(todayIn(), -2)},${ad.id},30,9,1,"PKR 22,500","from csv, quoted"`,
      `${addDays(todayIn(), -3)},,12,4,0,9000,`,
      "not-a-date,,1,1,0,10,",
      `${addDays(todayIn(), -3)},,1,1,5,10,`,
    ].join("\n");
    const r = await app.inject({ method: "POST", url: "/api/orders/import", headers: staff, payload: { csv } });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().imported).toBe(2);
    expect(r.json().errors.map((e: any) => e.line)).toEqual([4, 5]);
    const rows = (await app.inject({ url: "/api/orders", headers: staff })).json();
    const imported = rows.find((o: any) => o.note === "from csv, quoted");
    expect(imported).toMatchObject({ revenue: 22500, ad_name: "A2-Everyday-Flats" });
  });

  it("CSV without required columns is refused", async () => {
    const r = await app.inject({ method: "POST", url: "/api/orders/import", headers: staff, payload: { csv: "date,orders\n2026-01-01,1" } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/chats/);
  });

  it("summary by day uses synced spend", async () => {
    const r = await app.inject({ url: "/api/orders/summary?date_preset=last_7d", headers: staff });
    expect(r.json().total.orders).toBeGreaterThanOrEqual(20);
    expect(r.json().rows).toHaveLength(7);
  });

  it("delete", async () => {
    expect((await app.inject({ method: "DELETE", url: `/api/orders/${rowId}`, headers: staff })).statusCode).toBe(200);
  });
});

describe("alerts routes", () => {
  it("owner creates, mutes and deletes an alert; staff reads", async () => {
    const c = await app.inject({ method: "POST", url: "/api/alerts", headers: owner, payload: { metric: "frequency", operator: "gt", threshold: 3 } });
    expect(c.statusCode, c.body).toBe(200);
    const id = c.json().id;
    expect((await app.inject({ method: "POST", url: "/api/alerts", headers: staff, payload: { metric: "spend" } })).statusCode).toBe(403);
    const m = await app.inject({ method: "PATCH", url: `/api/alerts/${id}`, headers: owner, payload: { mute_hours: 12 } });
    expect(m.json().muted_until).toBeTruthy();
    expect((await app.inject({ url: "/api/alerts", headers: staff })).json()).toHaveLength(1);
    expect((await app.inject({ method: "DELETE", url: `/api/alerts/${id}`, headers: owner })).statusCode).toBe(200);
    const bad = await app.inject({ method: "POST", url: "/api/alerts", headers: owner, payload: { metric: "nope" } });
    expect(bad.statusCode).toBe(400);
  });
});

describe("webhooks", () => {
  const sign = (body: string, secret: string) => "sha256=" + createHmac("sha256", secret).update(body).digest("hex");

  it("WhatsApp verification handshake", async () => {
    const ok = await app.inject({ url: "/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=12345" });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe("12345");
    expect((await app.inject({ url: "/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1" })).statusCode).toBe(403);
  });

  it("WhatsApp messages: rejects bad signatures, records CTWA chats per ad once per day", async () => {
    const ad = (await db.ad.findFirst({ where: { name: "A1-Wedding-Pearl" } }))!;
    const payload = {
      object: "whatsapp_business_account",
      entry: [{ changes: [{ value: { messages: [
        { from: "923001234567", text: { body: "Price?" }, referral: { source_type: "ad", source_id: ad.id, ctwa_clid: "CLID1", headline: "Pearl flats" } },
        { from: "923001234567", text: { body: "Size 38" } },
        { from: "923111111111", text: { body: "Hi" } },
      ] } }] }],
    };
    const body = JSON.stringify(payload);
    const bad = await app.inject({ method: "POST", url: "/webhooks/whatsapp", headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=00" }, payload: body });
    expect(bad.statusCode).toBe(401);
    const good = await app.inject({ method: "POST", url: "/webhooks/whatsapp", headers: { "content-type": "application/json", "x-hub-signature-256": sign(body, h.mock.opts.appSecret) }, payload: body });
    expect(good.statusCode).toBe(200);
    expect(good.json().recorded).toBe(2);
    const chats = await db.whatsappChat.findMany();
    expect(chats).toHaveLength(2);
    expect(chats.find((c) => c.waId === "923001234567")).toMatchObject({ adId: ad.id, ctwaClid: "CLID1" });
    const counts = (await app.inject({ url: "/api/orders/chats", headers: staff })).json();
    expect(counts.find((c: any) => c.ad_id === ad.id).chats).toBe(1);
  });

  it("Shopify order -> Conversions API Purchase with hashed user data", async () => {
    const order = { id: 5551, email: "Buyer@Example.com", phone: "0300-1234567", total_price: "4999.00", currency: "PKR", created_at: new Date().toISOString(), line_items: [{ sku: "PF-38", quantity: 1, price: "4999.00" }], shipping_address: { first_name: "Ayesha", city: "Karachi", country_code: "PK" } };
    const body = JSON.stringify(order);
    const hmac = createHmac("sha256", "shop-secret").update(body).digest("base64");
    expect((await app.inject({ method: "POST", url: "/webhooks/shopify/orders-create", headers: { "content-type": "application/json", "x-shopify-hmac-sha256": "bad" }, payload: body })).statusCode).toBe(401);
    const r = await app.inject({ method: "POST", url: "/webhooks/shopify/orders-create", headers: { "content-type": "application/json", "x-shopify-hmac-sha256": hmac }, payload: body });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ ok: true, events_received: 1, event_id: "shopify-order-5551" });
    const ev = h.mock.pixelEvents[0];
    expect(ev).toMatchObject({ event_name: "Purchase", action_source: "website", custom_data: { value: 4999, currency: "PKR", order_id: "5551" } });
    expect(ev.user_data.em[0]).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(ev)).not.toContain("Buyer@Example.com");
  });

  it("rejects malformed JSON", async () => {
    const r = await app.inject({ method: "POST", url: "/api/orders", headers: { ...owner, "content-type": "application/json" }, payload: "{bad" });
    expect(r.statusCode).toBe(400);
  });
});
