// Sales tracking and self-service editing: Shopify order sync linked to ads through click-to-WhatsApp chats,
// cost per (delivered) order, sales alerts, rejected-ad and account alerts, review details, get_creative,
// update_ad, update_adset, ad comments, and copies of ad sets that still carry the retired 7-day click window.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDb } from "@sandalez/db";
import { alertsService, webhooksService } from "@sandalez/core";
import { call, connectClient, startHarness, startMcp, type Harness } from "../../../test/harness.js";

let h: Harness;
let mcp: Awaited<ReturnType<typeof startMcp>>;
let client: Client;
const db = getDb();
const ids: Record<string, any> = {};
const media = (f: string) => `${h.mock.baseUrl}/__mock/media/${f}`;

beforeAll(async () => {
  h = await startHarness({ env: { SHOPIFY_STORE_DOMAIN: "sandalez.myshopify.com", SHOPIFY_ADMIN_TOKEN: "shpat_mock" } });
  // The Shopify client talks to the mock (SHOPIFY_BASE_URL is only known once the mock is listening).
  (h.core.config as any).SHOPIFY_BASE_URL = h.mock.baseUrl;
  mcp = await startMcp(h.core);
  client = await connectClient(mcp.url);
  await call(client, "sync_now", { days: 14 });
  const ad = await db.ad.findFirstOrThrow({ where: { name: "A1-Wedding-Pearl" } });
  ids.ad = ad.id;
  ids.campaign = (await db.adSet.findUniqueOrThrow({ where: { id: ad.adSetId } })).campaignId;
});
afterAll(async () => {
  await client?.close();
  await mcp?.close();
  await h?.close();
});

const whatsappMessage = (from: string, adId: string) => ({
  object: "whatsapp_business_account",
  entry: [{ changes: [{ value: { messages: [{ from, type: "text", text: { body: "Price?" }, referral: { source_type: "ad", source_id: adId, ctwa_clid: "clid" } }] } }] }],
});
const order = (id: string, over: Record<string, unknown> = {}) => ({
  legacyResourceId: id,
  name: `#${id}`,
  phone: null,
  displayFinancialStatus: "PENDING",
  displayFulfillmentStatus: "UNFULFILLED",
  totalPriceSet: { shopMoney: { amount: "2800.00", currencyCode: "PKR" } },
  ...over,
});

describe("Shopify orders linked to ads", () => {
  it("syncs orders, works out each outcome and links them to the ad through the WhatsApp chat", async () => {
    const ctx = h.core.context("whatsapp-webhook", "webhook");
    await webhooksService.handleWhatsappWebhook(ctx, whatsappMessage("923001234567", ids.ad));

    h.mock.addShopOrder(order("1001", { phone: "+92 300 1234567", displayFinancialStatus: "PAID", displayFulfillmentStatus: "FULFILLED", fulfillments: [{ displayStatus: "DELIVERED", status: "SUCCESS" }] }));
    h.mock.addShopOrder(order("1002", { shippingAddress: { phone: "0300-1234567" }, tags: ["RTO"], fulfillments: [{ displayStatus: "IN_TRANSIT", status: "SUCCESS" }] }));
    h.mock.addShopOrder(order("1003", { phone: "03111111111" }));
    h.mock.addShopOrder(order("1004", { phone: "03001234567", cancelledAt: new Date().toISOString() }));
    h.mock.addShopOrder(order("1005", { phone: "03001234567", test: true }));

    const { ok, data } = await call(client, "sync_shop_orders", {});
    expect(ok, JSON.stringify(data)).toBe(true);
    expect(data).toMatchObject({ fetched: 5, saved: 4, skipped_test: 1 });

    const list = await call(client, "list_shop_orders", {});
    const byName = Object.fromEntries(list.data.orders.map((o: any) => [o.name, o]));
    expect(byName["#1001"]).toMatchObject({ status: "delivered", ad_id: ids.ad, attribution: "whatsapp_chat", phone_last4: "4567" });
    expect(byName["#1002"]).toMatchObject({ status: "refused", ad_id: ids.ad });
    expect(byName["#1003"]).toMatchObject({ status: "pending", ad_id: null });
    expect(byName["#1004"].status).toBe("cancelled");
  });

  it("cost per order counts delivered, pending and refused separately; cancelled orders don't count", async () => {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi" }).format(new Date());
    const { ok, data } = await call(client, "get_cost_per_order", { since: today, until: today, group_by: "ad" });
    expect(ok, JSON.stringify(data)).toBe(true);
    expect(data.total).toMatchObject({ orders: 3, delivered: 1, pending: 1, refused: 1, revenue: 5600, revenue_delivered: 2800 });
    expect(data.total.refusal_rate_pct).toBe(50);
    const row = data.rows.find((r: any) => r.key === ids.ad);
    expect(row).toMatchObject({ orders: 2, delivered: 1, refused: 1, chats_logged: 1 });
    expect(row.cost_per_delivered_order).toBe(row.spend);
    expect(data.notes.join(" ")).toMatch(/1 Shopify order\(s\) aren't linked/);

    const one = await call(client, "get_cost_per_order", { since: today, until: today, object_id: ids.campaign });
    expect(one.data.total).toMatchObject({ orders: 2, refused: 1 });
  });

  it("link_shop_order links by hand; a later sync updates the status but keeps the manual link", async () => {
    const linked = await call(client, "link_shop_order", { order: "1003", ad_id: ids.ad });
    expect(linked.data).toMatchObject({ ad_id: ids.ad, attribution: "manual" });
    h.mock.addShopOrder(order("1003", { phone: "03111111111", displayFinancialStatus: "PAID", displayFulfillmentStatus: "FULFILLED", updatedAt: new Date(Date.now() + 60_000).toISOString() }));
    const sync = await call(client, "sync_shop_orders", {});
    expect(sync.data.fetched).toBe(1); // only the changed order
    const list = await call(client, "list_shop_orders", { ad_id: ids.ad });
    expect(list.data.orders.find((o: any) => o.name === "#1003")).toMatchObject({ status: "delivered", attribution: "manual" });
  });

  it("a wrong Shopify token is explained", async () => {
    h.mock.shopToken = "other";
    const { ok, data } = await call(client, "sync_shop_orders", { full: true });
    expect(ok).toBe(false);
    expect(data.error).toMatch(/Shopify refused the access token/);
    h.mock.shopToken = "shpat_mock";
  });

  it("weekly_report includes delivered orders and the best-selling ads", async () => {
    // The report covers the 7 full days before today: move the orders to yesterday.
    await db.shopOrder.updateMany({ data: { date: new Date(Date.now() - 86_400_000) } });
    const { ok, data } = await call(client, "weekly_report", {});
    expect(ok, JSON.stringify(data)).toBe(true);
    expect(data).toMatchObject({ delivered: 2, refused: 1 });
    expect(data.best_selling_ads[0]).toMatchObject({ ad_id: ids.ad, orders: 3 });
    await db.shopOrder.updateMany({ data: { date: new Date() } });
  });
});

describe("sales and review alerts", () => {
  it("needs a threshold for sales metrics", async () => {
    const { ok, data } = await call(client, "set_alert", { metric: "cost_per_order" });
    expect(ok).toBe(false);
    expect(data.error).toMatch(/Give a threshold/);
  });

  it("fires on cost per order, refusal rate and ROAS over the last 7 days", async () => {
    const ctx = h.core.context("worker", "worker");
    const cpo = await alertsService.setAlert(ctx, { metric: "cost_per_order", operator: "gt", threshold: 1 });
    const refusal = await alertsService.setAlert(ctx, { metric: "refusal_rate", operator: "gt", threshold: 20 });
    const roas = await alertsService.setAlert(ctx, { metric: "roas", operator: "lt", threshold: 1000 });
    const res = await alertsService.evaluateAlerts(ctx);
    const msg = (id: string) => res.fired.find((f) => f.alert_id === id)?.message ?? "";
    expect(msg(cpo.id)).toMatch(/cost per order above 1 — last 7 days/);
    expect(msg(refusal.id)).toMatch(/refusal rate above 20 — last 7 days: 33\.33% \(1 refused\)/);
    expect(msg(roas.id)).toMatch(/roas below 1000/);
  });

  it("ad_rejected fires once per rejected ad, with Meta's reason", async () => {
    const ctx = h.core.context("worker", "worker");
    const a = await alertsService.setAlert(ctx, { metric: "ad_rejected" });
    const ad = h.mock.objects.get(ids.ad)!;
    ad.status = "DISAPPROVED";
    ad.ad_review_feedback = { global: { "Unrealistic outcomes": "Ads can't promise exaggerated results." } };
    const first = await alertsService.evaluateAlerts(ctx);
    expect(first.fired.find((f) => f.alert_id === a.id)?.message).toMatch(/Ad rejected: .*Unrealistic outcomes/);
    const second = await alertsService.evaluateAlerts(ctx, new Date(Date.now() + 60_000));
    expect(second.fired.find((f) => f.alert_id === a.id)).toBeUndefined();
  });

  it("get_campaign_tree shows the rejection reason; get_account warns about it", async () => {
    const tree = await call(client, "get_campaign_tree", { campaign_id: ids.campaign });
    const ad = tree.data.adsets.flatMap((s: any) => s.ads).find((x: any) => x.id === ids.ad);
    expect(ad.review).toMatchObject({ status: "DISAPPROVED", reasons: [expect.stringMatching(/Unrealistic outcomes/)] });
    const acc = await call(client, "get_account", {});
    expect(acc.data.warnings.map((w: any) => w.code)).toContain("ads_rejected");
    h.mock.objects.get(ids.ad)!.status = "ACTIVE";
    delete h.mock.objects.get(ids.ad)!.ad_review_feedback;
  });

  it("account_problem fires on a failed payment and a reached spending limit", async () => {
    const ctx = h.core.context("worker", "worker");
    const a = await alertsService.setAlert(ctx, { metric: "account_problem" });
    const acc = h.mock.objects.get(h.mock.act)!;
    Object.assign(acc, { account_status: 3, spend_cap: "4567800" });
    const res = await alertsService.evaluateAlerts(ctx);
    expect(res.fired.find((f) => f.alert_id === a.id)?.message).toMatch(/payment failed.*spending limit/is);
    const info = await call(client, "get_account", {});
    expect(info.data.warnings.filter((w: any) => w.severity === "critical").map((w: any) => w.code)).toEqual(["payment_failed", "spend_cap_reached"]);
    Object.assign(acc, { account_status: 1, spend_cap: "0" });
  });
});

describe("reading and editing ads", () => {
  it("get_creative reads text, media, buttons and the welcome message, and as_new_creative builds a new version", async () => {
    const built = await call(client, "create_ctwa_campaign", {
      name: "Read-me",
      daily_budget: 500,
      city: "Karachi",
      messaging_apps: ["whatsapp", "instagram_direct"],
      primary_text: "Pearl flats, COD",
      primary_texts: ["Sparkle for Eid"],
      headline: "Which Pair Is Yours?",
      welcome_message: "Hi! Which size?",
      icebreakers: ["Price?", "Sizes?"],
      creatives: [{ type: "video", video_url: media("sample.mp4"), thumbnail_url: media("sample.jpg") }],
    });
    expect(built.ok, JSON.stringify(built.data)).toBe(true);
    Object.assign(ids, { newAd: built.data.ads[0].ad_id, newAdset: built.data.adset_id, newCampaign: built.data.campaign_id, newCreative: built.data.ads[0].creative_id });

    const { ok, data } = await call(client, "get_creative", { ad_id: ids.newAd });
    expect(ok, JSON.stringify(data)).toBe(true);
    expect(data).toMatchObject({ format: "video", primary_text: "Pearl flats, COD", headline: "Which Pair Is Yours?" });
    expect(data.media.video_id).toBeTruthy();
    expect(data.buttons).toMatchObject({ messaging_apps: ["whatsapp", "instagram_direct"], multi_destination: true });
    expect(data.welcome_message).toMatchObject({ text: "Hi! Which size?", icebreakers: ["Price?", "Sizes?"] });
    expect(data.text_versions.primary_texts).toEqual(["Pearl flats, COD", "Sparkle for Eid"]);

    const v2 = await call(client, "create_creative", { ...data.as_new_creative, primary_text: "New line for v2" });
    expect(v2.ok, JSON.stringify(v2.data)).toBe(true);
    ids.v2 = v2.data.creative_id;
  });

  it("update_ad renames freely; swapping the creative of an active ad needs confirm", async () => {
    const renamed = await call(client, "update_ad", { ad_id: ids.newAd, name: "Read-me renamed" });
    expect(renamed.ok, JSON.stringify(renamed.data)).toBe(true);
    expect(h.mock.objects.get(ids.newAd)!.name).toBe("Read-me renamed");

    h.mock.objects.get(ids.newAd)!.status = "ACTIVE";
    const noConfirm = await call(client, "update_ad", { ad_id: ids.newAd, creative_id: ids.v2 });
    expect(noConfirm.data.rule).toBe("confirm_required");
    const swapped = await call(client, "update_ad", { ad_id: ids.newAd, creative_id: ids.v2, confirm: true });
    expect(swapped.ok, JSON.stringify(swapped.data)).toBe(true);
    expect(swapped.data).toMatchObject({ creative_id: ids.v2, previous_creative_id: ids.newCreative });
    expect(h.mock.objects.get(ids.newAd)!.creative.id).toBe(ids.v2);
    h.mock.objects.get(ids.newAd)!.status = "PAUSED";
  });

  it("update_adset sets a cost cap and schedule with confirm; refuses a cap without an amount", async () => {
    const missing = await call(client, "update_adset", { adset_id: ids.newAdset, bid_strategy: "COST_CAP", confirm: true });
    expect(missing.data.error).toMatch(/COST_CAP needs bid_amount/);
    const noConfirm = await call(client, "update_adset", { adset_id: ids.newAdset, bid_strategy: "COST_CAP", bid_amount: 150 });
    expect(noConfirm.data.rule).toBe("confirm_required");
    const end = new Date(Date.now() + 14 * 86_400_000).toISOString();
    const { ok, data } = await call(client, "update_adset", { adset_id: ids.newAdset, bid_strategy: "COST_CAP", bid_amount: 150, end_time: end, confirm: true });
    expect(ok, JSON.stringify(data)).toBe(true);
    expect(data).toMatchObject({ bid_strategy: "COST_CAP", bid_amount: 150 });
    expect(h.mock.objects.get(ids.newAdset)).toMatchObject({ bid_strategy: "COST_CAP", bid_amount: "15000", end_time: end });
  });

  it("update_adset passes on Meta's refusal of a 7-day click window for chat ad sets", async () => {
    const { ok, data } = await call(client, "update_adset", { adset_id: ids.newAdset, attribution: { click_days: 7 }, confirm: true });
    expect(ok).toBe(false);
    expect(data.error).toMatch(/supported windows: 1 days/);
    const fine = await call(client, "update_adset", { adset_id: ids.newAdset, attribution: { click_days: 1 }, confirm: true });
    expect(fine.ok, JSON.stringify(fine.data)).toBe(true);
    expect(fine.data.attribution_spec).toEqual([{ event_type: "CLICK_THROUGH", window_days: 1 }]);
  });

  it("lists and hides comments on Facebook (Page token) and Instagram", async () => {
    const spam = h.mock.addComment(ids.v2, "facebook", "Earn money fast, DM me", "Spammer");
    h.mock.addComment(ids.v2, "facebook", "Size 38 available?", "Ayesha");
    const ig = h.mock.addComment(ids.v2, "instagram", "fake product!!", "troll");
    const { ok, data } = await call(client, "list_ad_comments", { ad_id: ids.newAd });
    expect(ok, JSON.stringify(data)).toBe(true);
    expect(data.count).toBe(3);
    expect(data.comments.map((c: any) => c.platform).sort()).toEqual(["facebook", "facebook", "instagram"]);

    expect((await call(client, "hide_comment", { comment_id: spam, platform: "facebook" })).ok).toBe(true);
    expect((await call(client, "hide_comment", { comment_id: ig, platform: "instagram" })).ok).toBe(true);
    const after = await call(client, "list_ad_comments", { ad_id: ids.newAd });
    expect(after.data.comments.filter((c: any) => c.hidden).map((c: any) => c.author).sort()).toEqual(["Spammer", "troll"]);
    // The Page token call carried its own appsecret_proof (checked by the mock).
    expect(h.mock.calls.some((c) => c.path.endsWith("/comments") && c.signed)).toBe(true);
  });
});

describe("duplicate_campaign with a retired attribution window", () => {
  it("copies a chat ad set that still has a 7-day click window by leaving the window out", async () => {
    const set = h.mock.objects.get(ids.newAdset)!;
    set.attribution_spec = [{ event_type: "CLICK_THROUGH", window_days: 7 }];
    // Force the rebuild path (Meta's own copy refuses the retired creative bundle).
    h.mock.objects.get(ids.v2)!.degrees_of_freedom_spec = { creative_features_spec: { standard_enhancements: { enroll_status: "OPT_IN" } } };
    const { ok, data } = await call(client, "duplicate_campaign", { campaign_id: ids.newCampaign, new_name: "Read-me copy" });
    expect(ok, JSON.stringify(data)).toBe(true);
    expect(data.method).toBe("rebuilt");
    const copy = [...h.mock.objects.values()].find((o) => o._type === "adset" && o.campaign_id === data.campaign_id)!;
    expect(copy.attribution_spec).toBeUndefined();
    expect(copy.optimization_goal).toBe("CONVERSATIONS");
  });
});
