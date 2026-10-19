// Stage 4 (spec weeks 6-10): optimization reports, alerts, weekly report, audiences, catalog / DPA.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDb } from "@sandalez/db";
import { alertsService, audiencesService } from "@sandalez/core";
import { call, connectClient, startHarness, startMcp, type Harness } from "../../../test/harness.js";

let h: Harness;
let mcp: Awaited<ReturnType<typeof startMcp>>;
let client: Client;
const db = getDb();
const ids: Record<string, string> = {};

beforeAll(async () => {
  h = await startHarness();
  mcp = await startMcp(h.core);
  client = await connectClient(mcp.url);
  await call(client, "sync_now", { days: 14 });
});
afterAll(async () => {
  await client?.close();
  await mcp?.close();
  await h?.close();
});

describe("optimization reports", () => {
  it("detect_fatigue flags the ad whose CTR collapsed and frequency is high", async () => {
    const { ok, data } = await call(client, "detect_fatigue", {});
    expect(ok, JSON.stringify(data)).toBe(true);
    const tired = data.ads.find((a: any) => a.ad_name === "A2-Everyday-Flats");
    expect(tired.fatigued).toBe(true);
    expect(tired.severity).toBe("high");
    expect(tired.reasons.join(" ")).toMatch(/frequency/);
    expect(tired.reasons.join(" ")).toMatch(/CTR down/);
    const fresh = data.ads.find((a: any) => a.ad_name === "A1-Wedding-Pearl");
    expect(fresh.fatigued).toBe(false);
    expect(data.ads[0].fatigued).toBe(true); // fatigued sorted first
  });

  it("placement_report flags Marketplace as expensive (spend, no chats)", async () => {
    const { ok, data } = await call(client, "placement_report", { date_preset: "last_7d" });
    expect(ok, JSON.stringify(data)).toBe(true);
    const mp = data.placements.find((p: any) => p.position === "marketplace");
    expect(mp).toMatchObject({ platform: "facebook", conversations: 0, flag: "expensive" });
    const share = data.placements.reduce((s: number, p: any) => s + p.spend_share_pct, 0);
    expect(share).toBeGreaterThan(99);
    expect(data.summary.join(" ")).toMatch(/marketplace/);
  });

  it("placement_report works for a single campaign", async () => {
    const c = [...h.mock.objects.values()].find((o) => o._type === "campaign")!;
    const { ok, data } = await call(client, "placement_report", { object_id: c.id });
    expect(ok, JSON.stringify(data)).toBe(true);
    expect(data.placements.length).toBe(5);
  });

  it("wasted_spend_report finds the ad with zero chats", async () => {
    const { ok, data } = await call(client, "wasted_spend_report", { date_preset: "last_7d", min_spend: 100 });
    expect(ok, JSON.stringify(data)).toBe(true);
    const item = data.items.find((i: any) => i.ad_name === "A3-Kolhapuri");
    expect(item.conversations).toBe(0);
    expect(item.wasted_spend).toBe(item.spend);
    expect(data.wasted_spend).toBeGreaterThanOrEqual(item.spend);
    expect(data.wasted_pct).toBeGreaterThan(0);
  });
});

describe("alerts", () => {
  it("set_alert validates the object belongs to the account", async () => {
    const { ok, data } = await call(client, "set_alert", { metric: "spend", operator: "gt", threshold: 1, object_id: "99999999999" });
    expect(ok).toBe(false);
    expect(data.kind).toBe("meta");
  });

  it("set_alert + list_alerts", async () => {
    const a = await call(client, "set_alert", { metric: "cost_per_chat", operator: "gt", threshold: 1 });
    expect(a.ok).toBe(true);
    ids.alert = a.data.id;
    expect(a.data.name).toBe("cost per chat above 1");
    await call(client, "set_alert", { metric: "frequency", operator: "gt", threshold: 3, name: "Frequency above 3" });
    await call(client, "set_alert", { metric: "spend", operator: "gt", threshold: 999999 });
    const { data } = await call(client, "list_alerts", {});
    expect(data).toHaveLength(3);
  });

  it("evaluateAlerts fires matching alerts once, then respects the cooldown and mutes", async () => {
    const ctx = h.core.context("worker", "worker");
    const first = await alertsService.evaluateAlerts(ctx);
    const fired = first.fired.map((f) => f.message).join(" | ");
    expect(fired).toMatch(/cost per chat above 1/);
    expect(fired).not.toMatch(/spend above 999999/);
    const second = await alertsService.evaluateAlerts(ctx);
    expect(second.fired).toHaveLength(0); // cooldown
    const events = await db.alertEvent.count({ where: { alertId: ids.alert } });
    expect(events).toBe(1);
    await alertsService.updateAlert(ctx, ids.alert, { mute_hours: 24 });
    const later = await alertsService.evaluateAlerts(ctx, new Date(Date.now() + 7 * 3600_000));
    expect(later.fired.find((f) => f.alert_id === ids.alert)).toBeUndefined();
    const { data } = await call(client, "list_alerts", { events: 5 });
    expect(data.find((a: any) => a.id === ids.alert).events).toHaveLength(1);
  });

  it("spend_stopped fires only after noon when active campaigns have no spend today", async () => {
    const ctx = h.core.context("worker", "worker");
    await alertsService.setAlert(ctx, { metric: "spend_stopped" });
    // Pause every ad so today's spend is zero in the mock.
    for (const o of h.mock.objects.values()) if (o._type === "ad") o.created_time = "2999-01-01T00:00:00+0000";
    await db.campaign.updateMany({ data: { status: "ACTIVE" } });
    const noonPk = new Date(`${new Date().toISOString().slice(0, 10)}T09:00:00Z`); // 14:00 in Karachi
    const res = await alertsService.evaluateAlerts(ctx, noonPk);
    expect(res.fired.map((f) => f.message).join(" ")).toMatch(/No spend today/);
  });
});

describe("weekly report", () => {
  it("weekly_report compares two weeks, lists best/worst ads and is saved", async () => {
    // Restore ad history after the spend_stopped test.
    for (const o of h.mock.objects.values()) if (o._type === "ad" && o.created_time === "2999-01-01T00:00:00+0000") o.created_time = "2020-01-01T00:00:00+0000";
    const { ok, data } = await call(client, "weekly_report", {});
    expect(ok, JSON.stringify(data)).toBe(true);
    expect(data.spend).toBeGreaterThan(0);
    expect(data.chats).toBeGreaterThan(0);
    expect(data.top_ads.length).toBeGreaterThan(0);
    expect(data.worst_ads[0].ad_name).toBe("A3-Kolhapuri");
    expect(data.email).toMatchObject({ sent: false });
    const saved = await db.report.findUnique({ where: { id: data.report_id } });
    expect(saved?.html).toContain("weekly report");
  });

  it("send_email without SMTP reports why it was not sent", async () => {
    const { data } = await call(client, "weekly_report", { send_email: true, email_to: "owner@sandalez.pk" });
    expect(data.email).toMatchObject({ sent: false });
    expect(data.email.reason).toMatch(/SMTP/);
  });
});

describe("audiences (phase 3)", () => {
  it("creates a website audience from pixel purchases", async () => {
    const { ok, data } = await call(client, "create_custom_audience", { name: "Purchasers 180d", source: "website", website_event: "Purchase", retention_days: 180 });
    expect(ok, JSON.stringify(data)).toBe(true);
    ids.website = data.audience_id;
    const a = h.mock.objects.get(data.audience_id)!;
    const rule = a.rule.inclusions.rules[0];
    expect(rule.event_sources).toEqual([{ id: h.mock.opts.pixelId, type: "pixel" }]);
    expect(rule.retention_seconds).toBe(180 * 86400);
    expect(rule.filter.filters[0]).toEqual({ field: "event", operator: "eq", value: "Purchase" });
  });

  it("creates an Instagram engagement audience", async () => {
    const { ok, data } = await call(client, "create_custom_audience", { name: "IG engagers", source: "engagement", engagement_source: "instagram", retention_days: 90 });
    expect(ok).toBe(true);
    const rule = h.mock.objects.get(data.audience_id)!.rule.inclusions.rules[0];
    expect(rule.event_sources).toEqual([{ id: h.mock.opts.igUserId, type: "ig_business" }]);
  });

  it("creates a customer list with hashed, normalized Pakistani phones", async () => {
    const { ok, data } = await call(client, "create_custom_audience", {
      name: "COD customers",
      source: "customer_list",
      customers: [{ phone: "0349-9066816" }, { email: " Ayesha@Example.com ", phone: "+92 300 1234567" }, { email: "not-an-email", phone: "12" }],
    });
    expect(ok, JSON.stringify(data)).toBe(true);
    expect(data.uploaded).toEqual({ received: 2, invalid: 0, skipped: 1 });
    const upload = h.mock.calls.find((c) => c.path === `${data.audience_id}/users`)!;
    const rows = upload.params.payload.data;
    expect(rows[0][1]).toBe(audiencesService.hashCustomer({ phone: "923499066816" })[1]);
    expect(rows[1][0]).toBe(audiencesService.hashCustomer({ email: "ayesha@example.com" })[0]);
    expect(JSON.stringify(upload.params)).not.toContain("Ayesha");
  });

  it("customer list without customers is refused", async () => {
    const { ok, data } = await call(client, "create_custom_audience", { name: "empty", source: "customer_list" });
    expect(ok).toBe(false);
    expect(data.error).toMatch(/needs customers/);
  });

  it("creates a 1% Pakistan lookalike", async () => {
    const { ok, data } = await call(client, "create_lookalike", { name: "LAL 1% purchasers", origin_audience_id: ids.website! });
    expect(ok, JSON.stringify(data)).toBe(true);
    expect(h.mock.objects.get(data.audience_id)!.lookalike_spec).toEqual({ ratio: 0.01, country: "PK", type: "similarity" });
  });

  it("list_audiences shows sizes", async () => {
    const { data } = await call(client, "list_audiences");
    expect(data.length).toBe(4);
    expect(data[0]).toHaveProperty("size_upper");
  });

  it("an audience can be used to retarget in a new ad set", async () => {
    const c = await call(client, "create_campaign", { name: "Retarget" });
    const { ok, data } = await call(client, "create_adset", {
      campaign_id: c.data.campaign_id,
      name: "Retarget purchasers",
      daily_budget: 300,
      targeting: { countries: ["PK"], custom_audience_ids: [ids.website!] },
    });
    expect(ok, JSON.stringify(data)).toBe(true);
    expect(h.mock.objects.get(data.adset_id)!.targeting.custom_audiences).toEqual([{ id: ids.website }]);
  });
});

describe("catalog / dynamic product ads (phase 3)", () => {
  it("list_catalogs shows the Shopify catalog and product sets", async () => {
    const { ok, data } = await call(client, "list_catalogs");
    expect(ok, JSON.stringify(data)).toBe(true);
    expect(data[0]).toMatchObject({ name: "Sandalez Shopify", product_count: 86 });
    expect(data[0].product_sets[0].name).toBe("All products");
    ids.catalog = data[0].id;
  });

  it("create_product_set with a filter", async () => {
    const { ok, data } = await call(client, "create_product_set", { catalog_id: ids.catalog!, name: "Flats", filter: { product_type: { i_contains: "flats" } } });
    expect(ok).toBe(true);
    ids.productSet = data.product_set_id;
  });

  it("create_catalog_campaign builds a PAUSED retargeting DPA", async () => {
    const { ok, data } = await call(client, "create_catalog_campaign", {
      name: "SZ-DPA-Retarget",
      catalog_id: ids.catalog!,
      product_set_id: ids.productSet!,
      daily_budget: 400,
      primary_text: "Abhi bhi soch rahe hain? {{product.name}} sirf {{product.price}} mein.",
    });
    expect(ok, JSON.stringify(data)).toBe(true);
    const c = h.mock.objects.get(data.campaign_id)!;
    expect(c).toMatchObject({ objective: "OUTCOME_SALES", status: "PAUSED", promoted_object: { product_catalog_id: ids.catalog } });
    const s = h.mock.objects.get(data.adset_id)!;
    expect(s).toMatchObject({ status: "PAUSED", optimization_goal: "OFFSITE_CONVERSIONS", promoted_object: { product_set_id: ids.productSet, custom_event_type: "PURCHASE" } });
    expect(s.targeting.product_audience_specs[0].exclusions[0].rule).toEqual({ event: { eq: "Purchase" } });
    expect(h.mock.objects.get(data.ad_id)!.status).toBe("PAUSED");
    expect(h.mock.objects.get(data.creative_id)!.product_set_id).toBe(ids.productSet);
  });

  it("catalog campaign rolls back on failure", async () => {
    h.mock.failNext(/^act_\d+\/adcreatives$/, { method: "POST" });
    const { ok } = await call(client, "create_catalog_campaign", { name: "DPA-Fail", catalog_id: ids.catalog!, product_set_id: ids.productSet!, daily_budget: 400, primary_text: "x" });
    expect(ok).toBe(false);
    const leftovers = [...h.mock.objects.values()].filter((o) => String(o.name ?? "").startsWith("DPA-Fail") && o.status !== "DELETED");
    expect(leftovers).toHaveLength(0);
  });

  it("catalog campaign respects the budget cap", async () => {
    const { data } = await call(client, "create_catalog_campaign", { name: "DPA-big", catalog_id: ids.catalog!, product_set_id: ids.productSet!, daily_budget: 3000, primary_text: "x" });
    expect(data.rule).toBe("budget_cap");
  });
});
