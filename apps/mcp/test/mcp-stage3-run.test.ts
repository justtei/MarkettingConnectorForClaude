// Stage 3 (spec week 3): create_ctwa_campaign + rollback, set_status/update_budget/update_targeting with confirm
// and guards, get_insights, log_orders, get_cost_per_order, bulk edits, duplicate, rate limits.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDb } from "@sandalez/db";
import { settingsService, todayIn, addDays } from "@sandalez/core";
import { call, connectClient, startHarness, startMcp, type Harness } from "../../../test/harness.js";

let h: Harness;
let mcp: Awaited<ReturnType<typeof startMcp>>;
let client: Client;
const db = getDb();
const ids: Record<string, any> = {};

beforeAll(async () => {
  h = await startHarness();
  mcp = await startMcp(h.core);
  client = await connectClient(mcp.url);
});
afterAll(async () => {
  await client?.close();
  await mcp?.close();
  await h?.close();
});

const media = (f: string) => `${h.mock.baseUrl}/__mock/media/${f}`;
const ctwaArgs = (over: Record<string, unknown> = {}) => ({
  name: "SZ-KHI-Prospecting-WA",
  daily_budget: 600,
  city: "Karachi",
  age_min: 20,
  age_max: 40,
  gender: "female",
  primary_text: "Shaadi season ki tayyari? Pearl flats ab 30% OFF. COD + easy exchange.",
  headline: "Shaadi-ready pearl flats",
  welcome_message: "Assalam o Alaikum! Sandalez mein khush aamdeed.",
  autofill_message: "Hi Sandalez! Mujhe yeh design chahiye. Size:",
  creatives: [
    { type: "video", name: "A1-Wedding-Pearl", video_url: media("sample.mp4"), thumbnail_url: media("sample.jpg") },
    { type: "image", name: "A2-Everyday-Flats", image_url: media("sample.jpg"), primary_text: "Everyday flats, PKR 1,999" },
  ],
  ...over,
});

describe("create_ctwa_campaign", () => {
  it("builds campaign -> ad set -> creatives -> ads, all PAUSED, exactly as the spec payloads", async () => {
    const { ok, data } = await call(client, "create_ctwa_campaign", ctwaArgs());
    expect(ok, JSON.stringify(data)).toBe(true);
    Object.assign(ids, { campaign: data.campaign_id, adset: data.adset_id, ads: data.ads });
    expect(data.status).toBe("PAUSED");
    expect(data.ads).toHaveLength(2);

    const c = h.mock.objects.get(data.campaign_id)!;
    expect(c).toMatchObject({ name: "SZ-KHI-Prospecting-WA", objective: "OUTCOME_ENGAGEMENT", status: "PAUSED", special_ad_categories: [] });
    const s = h.mock.objects.get(data.adset_id)!;
    expect(s).toMatchObject({
      campaign_id: data.campaign_id,
      status: "PAUSED",
      daily_budget: "60000",
      billing_event: "IMPRESSIONS",
      optimization_goal: "CONVERSATIONS",
      bid_strategy: "LOWEST_COST_WITHOUT_CAP",
      destination_type: "WHATSAPP",
      promoted_object: { page_id: h.mock.opts.pageId, whatsapp_phone_number: "923499066816" },
      targeting: {
        geo_locations: { cities: [{ key: "2211096" }], location_types: ["home", "recent"] },
        age_min: 20,
        age_max: 40,
        genders: [2],
        targeting_automation: { advantage_audience: 1 },
      },
    });
    for (const ad of data.ads) {
      const a = h.mock.objects.get(ad.ad_id)!;
      expect(a.status).toBe("PAUSED");
      expect(a.adset_id).toBe(data.adset_id);
    }
    const video = h.mock.objects.get(data.ads[0].creative_id)!.object_story_spec.video_data;
    expect(video).toMatchObject({ title: "Shaadi-ready pearl flats", call_to_action: { type: "WHATSAPP_MESSAGE" } });
    expect(video.image_hash).toMatch(/^[a-f0-9]{32}$/); // uploaded thumbnail
    const img = h.mock.objects.get(data.ads[1].creative_id)!.object_story_spec.link_data;
    expect(img.message).toBe("Everyday flats, PKR 1,999"); // per-creative text overrides the default

    const tree = await db.campaign.findUnique({ where: { id: data.campaign_id }, include: { adSets: { include: { ads: true } } } });
    expect(tree?.adSets[0]?.ads).toHaveLength(2);
    const audit = await db.auditLog.findMany({ where: { action: "create_ctwa_campaign" } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ ok: true, objectId: data.campaign_id, actor: "claude-mcp" });
  });

  it("refuses a budget above the cap before creating anything", async () => {
    const before = h.mock.objects.size;
    const { ok, data } = await call(client, "create_ctwa_campaign", ctwaArgs({ daily_budget: 5000 }));
    expect(ok).toBe(false);
    expect(data.rule).toBe("budget_cap");
    expect(h.mock.objects.size).toBe(before);
  });

  it("rolls back campaign, ad set and creative when the ad step fails", async () => {
    h.mock.failNext(/^act_\d+\/ads$/, { method: "POST", error: { message: "Ad creation failed (injected)", code: 100, error_subcode: 1487390 } });
    const beforeCampaigns = await db.campaign.count();
    const { ok, data } = await call(client, "create_ctwa_campaign", ctwaArgs({ name: "Rollback-Test", creatives: [{ type: "image", image_url: media("sample.jpg") }] }));
    expect(ok).toBe(false);
    expect(data.error).toMatch(/failed while creating the ad/);
    expect(data.error).toMatch(/Rollback: 3 object\(s\) deleted/);
    const created = [...h.mock.objects.values()].filter((o) => String(o.name ?? "").startsWith("Rollback-Test"));
    expect(created.length).toBeGreaterThanOrEqual(3);
    for (const o of created) expect(o.status, `${o._type} ${o.id}`).toBe("DELETED");
    expect(await db.campaign.count()).toBe(beforeCampaigns);
    expect(await db.auditLog.findFirst({ where: { action: "create_ctwa_campaign", ok: false } })).toBeTruthy();
  });

  it("age_min above 25 turns Advantage+ audience off by default (Meta does not allow it there)", async () => {
    const { ok, data } = await call(client, "create_ctwa_campaign", ctwaArgs({ name: "Strict-Age", age_min: 30, age_max: 45, creatives: [{ type: "image", image_url: media("sample.jpg") }] }));
    expect(ok, JSON.stringify(data)).toBe(true);
    expect(h.mock.objects.get(data.adset_id)!.targeting).toMatchObject({ age_min: 30, targeting_automation: { advantage_audience: 0 } });
    await call(client, "set_status", { object_id: data.campaign_id, status: "ARCHIVED", confirm: true });
  });

  it("an explicit Advantage+ audience with age_min above 25 is refused by Meta and rolled back", async () => {
    const { ok, data } = await call(client, "create_ctwa_campaign", ctwaArgs({ name: "Adv-Age", age_min: 30, age_max: 45, advantage_audience: true, creatives: [{ type: "image", image_url: media("sample.jpg") }] }));
    expect(ok).toBe(false);
    expect(data.error).toMatch(/ad set/);
    const c = [...h.mock.objects.values()].find((o) => o.name === "Adv-Age");
    expect(c?.status).toBe("DELETED");
  });

  it("requires primary text for every creative", async () => {
    const { ok, data } = await call(client, "create_ctwa_campaign", ctwaArgs({ primary_text: undefined, creatives: [{ type: "image", image_url: media("sample.jpg") }] }));
    expect(ok).toBe(false);
    expect(data.error).toMatch(/primary_text/);
  });
});

describe("set_status", () => {
  it("activation without confirm is refused and changes nothing", async () => {
    const { ok, data } = await call(client, "set_status", { object_id: ids.campaign, status: "ACTIVE" });
    expect(ok).toBe(false);
    expect(data.rule).toBe("confirm_required");
    expect(data.error).toMatch(/Ask the user to confirm/);
    expect(h.mock.objects.get(ids.campaign)!.status).toBe("PAUSED");
  });

  it("activation with confirm activates campaign, ad set and ads, and returns the policy reminder", async () => {
    const { ok, data } = await call(client, "set_status", { object_id: ids.campaign, status: "ACTIVE", confirm: true });
    expect(ok, JSON.stringify(data)).toBe(true);
    expect(data.changed.map((c: any) => c.type)).toEqual(["campaign", "adset", "ad", "ad"]);
    expect(data.policy_reminder).toMatch(/misleading/);
    expect(h.mock.objects.get(ids.campaign)!.status).toBe("ACTIVE");
    expect(h.mock.objects.get(ids.adset)!.status).toBe("ACTIVE");
    for (const a of ids.ads) expect(h.mock.objects.get(a.ad_id)!.status).toBe("ACTIVE");
    expect((await db.adSet.findUnique({ where: { id: ids.adset } }))?.status).toBe("ACTIVE");
    const audit = await db.auditLog.findFirst({ where: { action: "set_status", objectId: ids.campaign } });
    expect(audit?.before).toMatchObject({ status: "PAUSED" });
  });

  it("pausing needs no confirmation", async () => {
    const { ok } = await call(client, "set_status", { object_id: ids.ads[1].ad_id, status: "PAUSED" });
    expect(ok).toBe(true);
    expect(h.mock.objects.get(ids.ads[1].ad_id)!.status).toBe("PAUSED");
  });

  it("activating an ad under a paused ad set warns that it will not deliver", async () => {
    await call(client, "set_status", { object_id: ids.adset, status: "PAUSED" });
    const { data } = await call(client, "set_status", { object_id: ids.ads[1].ad_id, status: "ACTIVE", confirm: true });
    expect(data.warnings.join(" ")).toMatch(/parent ad set is paused/);
  });

  it("activation is refused when an ad set budget is above the (lowered) cap", async () => {
    const ctx = h.core.context("owner@sandalez.pk", "dashboard");
    await settingsService.updateSettings(ctx, { maxDailyBudgetPkr: 500 });
    const { ok, data } = await call(client, "set_status", { object_id: ids.adset, status: "ACTIVE", confirm: true });
    expect(ok).toBe(false);
    expect(data.rule).toBe("budget_cap");
    expect(h.mock.objects.get(ids.adset)!.status).toBe("PAUSED");
    await settingsService.updateSettings(ctx, { maxDailyBudgetPkr: 2000 });
  });

  it("archive requires confirm", async () => {
    const r = await call(client, "set_status", { object_id: ids.ads[1].ad_id, status: "ARCHIVED" });
    expect(r.data.rule).toBe("confirm_required");
  });
});

describe("update_budget", () => {
  it("requires confirm", async () => {
    const { data } = await call(client, "update_budget", { object_id: ids.adset, daily_budget: 700 });
    expect(data.rule).toBe("confirm_required");
  });

  it("allows +30% (600 -> 780) and stores the previous value", async () => {
    const { ok, data } = await call(client, "update_budget", { object_id: ids.adset, daily_budget: 780, confirm: true });
    expect(ok, JSON.stringify(data)).toBe(true);
    expect(data).toMatchObject({ previous_daily_budget: 600, daily_budget: 780, change_pct: 30 });
    expect(h.mock.objects.get(ids.adset)!.daily_budget).toBe("78000");
    expect((await db.adSet.findUnique({ where: { id: ids.adset } }))?.dailyBudget).toBe(780);
    const audit = await db.auditLog.findFirst({ where: { action: "update_budget" }, orderBy: { at: "desc" } });
    expect(audit?.before).toEqual({ daily_budget: 600 });
  });

  it("refuses a bigger jump than 30% and says the max allowed now", async () => {
    const { ok, data } = await call(client, "update_budget", { object_id: ids.adset, daily_budget: 1100, confirm: true });
    expect(ok).toBe(false);
    expect(data.rule).toBe("budget_increase");
    expect(data.error).toMatch(/max PKR 1,014 now/);
    expect(h.mock.objects.get(ids.adset)!.daily_budget).toBe("78000");
  });

  it("refuses above the absolute cap", async () => {
    const { data } = await call(client, "update_budget", { object_id: ids.adset, daily_budget: 2100, confirm: true });
    expect(data.rule).toBe("budget_cap");
  });

  it("allows decreases", async () => {
    const { ok } = await call(client, "update_budget", { object_id: ids.adset, daily_budget: 500, confirm: true });
    expect(ok).toBe(true);
    expect(h.mock.objects.get(ids.adset)!.daily_budget).toBe("50000");
  });

  it("explains that a campaign without campaign budget has budgets on its ad sets", async () => {
    const { ok, data } = await call(client, "update_budget", { object_id: ids.campaign, daily_budget: 500, confirm: true });
    expect(ok).toBe(false);
    expect(data.error).toMatch(/budget on its ad sets/);
  });

  it("refuses a budget on an ad", async () => {
    const { data } = await call(client, "update_budget", { object_id: ids.ads[0].ad_id, daily_budget: 500, confirm: true });
    expect(data.error).toMatch(/budgets live on ad sets/);
  });
});

describe("update_targeting", () => {
  it("requires confirm", async () => {
    const { data } = await call(client, "update_targeting", { adset_id: ids.adset, changes: { age_min: 25 } });
    expect(data.rule).toBe("confirm_required");
  });

  it("merges age changes into the current targeting", async () => {
    const { ok, data } = await call(client, "update_targeting", { adset_id: ids.adset, changes: { age_min: 22, age_max: 35 }, confirm: true });
    expect(ok, JSON.stringify(data)).toBe(true);
    expect(h.mock.objects.get(ids.adset)!.targeting).toMatchObject({ age_min: 22, age_max: 35, genders: [2], geo_locations: { cities: [{ key: "2211096" }] } });
    expect(data.previous_targeting.age_min).toBe(20);
  });

  it("gender 'all' removes the gender restriction; interests can be added", async () => {
    const { ok } = await call(client, "update_targeting", { adset_id: ids.adset, changes: { gender: "all", interests: [{ id: "6003107902433", name: "Shoes" }] }, confirm: true });
    expect(ok).toBe(true);
    const t = h.mock.objects.get(ids.adset)!.targeting;
    expect(t.genders).toBeUndefined();
    expect(t.flexible_spec).toEqual([{ interests: [{ id: "6003107902433", name: "Shoes" }] }]);
  });

  it("can move the ad set to Lahore", async () => {
    const { ok } = await call(client, "update_targeting", { adset_id: ids.adset, changes: { cities: ["Lahore"] }, confirm: true });
    expect(ok).toBe(true);
    expect(h.mock.objects.get(ids.adset)!.targeting.geo_locations.cities).toEqual([{ key: "2211241" }]);
  });

  it("replace without a location is refused", async () => {
    const { ok, data } = await call(client, "update_targeting", { adset_id: ids.adset, changes: { age_min: 20 }, replace: true, confirm: true });
    expect(ok).toBe(false);
    expect(data.error).toMatch(/location/);
  });
});

describe("placements", () => {
  it("get_placements reads them; new ad sets start automatic", async () => {
    const { ok, data } = await call(client, "get_placements", { adset_id: ids.adset });
    expect(ok, JSON.stringify(data)).toBe(true);
    expect(data.placements.mode).toBe("automatic");
  });

  it("update_placements requires confirm", async () => {
    const { data } = await call(client, "update_placements", { adset_id: ids.adset, platforms: ["instagram"] });
    expect(data.rule).toBe("confirm_required");
  });

  it("sets manual placements and keeps the rest of the targeting", async () => {
    const before = h.mock.objects.get(ids.adset)!.targeting;
    const { ok, data } = await call(client, "update_placements", {
      adset_id: ids.adset,
      platforms: ["facebook", "instagram"],
      facebook_positions: ["feed", "story"],
      instagram_positions: ["stream", "story", "reels"],
      devices: ["mobile"],
      confirm: true,
    });
    expect(ok, JSON.stringify(data)).toBe(true);
    expect(data.previous_placements.mode).toBe("automatic");
    expect(data.placements).toMatchObject({ mode: "manual", positions: { facebook: ["feed", "story"], instagram: ["stream", "story", "reels"] } });
    const t = h.mock.objects.get(ids.adset)!.targeting;
    expect(t).toMatchObject({ publisher_platforms: ["facebook", "instagram"], instagram_positions: ["stream", "story", "reels"], device_platforms: ["mobile"] });
    expect(t.geo_locations).toEqual(before.geo_locations);
  });

  it("new placements replace old positions; the campaign tree shows them", async () => {
    const { ok } = await call(client, "update_placements", { adset_id: ids.adset, platforms: ["instagram"], confirm: true });
    expect(ok).toBe(true);
    const t = h.mock.objects.get(ids.adset)!.targeting;
    expect(t.publisher_platforms).toEqual(["instagram"]);
    expect(t.facebook_positions).toBeUndefined();
    expect(t.instagram_positions).toBeUndefined();
    expect(t.device_platforms).toBeUndefined();
    const { data } = await call(client, "get_campaign_tree", { campaign_id: ids.campaign });
    expect(data.adsets[0].placements).toMatchObject({ mode: "manual", platforms: ["instagram"], positions: { instagram: "all" } });
  });

  it("automatic: true goes back to Advantage+ placements", async () => {
    const { ok, data } = await call(client, "update_placements", { adset_id: ids.adset, automatic: true, confirm: true });
    expect(ok).toBe(true);
    expect(data.placements.mode).toBe("automatic");
    expect(h.mock.objects.get(ids.adset)!.targeting.publisher_platforms).toBeUndefined();
  });

  it("explains an invalid combination without calling Meta", async () => {
    const { ok, data } = await call(client, "update_placements", { adset_id: ids.adset, facebook_positions: ["marketplace"], confirm: true });
    expect(ok).toBe(false);
    expect(data.error).toMatch(/needs Facebook feed/);
  });

  it("get_placements refuses a campaign ID", async () => {
    const { ok, data } = await call(client, "get_placements", { adset_id: ids.campaign });
    expect(ok).toBe(false);
    expect(data.error).toMatch(/not an ad set/);
  });
});

describe("get_insights", () => {
  const seeded = () => [...h.mock.objects.values()].find((o) => o._type === "campaign" && o.name === "SZ-KHI-Existing-WA")!;

  it("account totals for last 7 days include spend and WhatsApp conversations", async () => {
    const { ok, data } = await call(client, "get_insights", { level: "account", date_preset: "last_7d" });
    expect(ok, JSON.stringify(data)).toBe(true);
    expect(data.currency).toBe("PKR");
    expect(data.totals.spend).toBeGreaterThan(0);
    expect(data.totals.conversations).toBeGreaterThan(0);
    expect(data.totals.cost_per_conversation).toBeCloseTo(data.totals.spend / data.totals.conversations, 1);
    expect(data.range.until).toBe(addDays(todayIn(), -1));
  });

  it("campaign level with age breakdown", async () => {
    const { data } = await call(client, "get_insights", { object_id: seeded().id, level: "campaign", date_preset: "last_7d", breakdowns: ["age"] });
    expect(data.rows.map((r: any) => r.breakdown.age).sort()).toEqual(["18-24", "25-34", "35-44"]);
  });

  it("daily rows at ad level with video metrics for the video ad", async () => {
    const { data } = await call(client, "get_insights", { object_id: seeded().id, level: "ad", since: addDays(todayIn(), -3), until: addDays(todayIn(), -1), time_increment: 1 });
    expect(data.rows).toHaveLength(9); // 3 ads x 3 days
    const video = data.rows.find((r: any) => r.ad_name === "A1-Wedding-Pearl");
    expect(video.video_p25).toBeGreaterThan(video.video_p100);
  });

  it("an ad ID with level=campaign is reported at ad level", async () => {
    const ad = [...h.mock.objects.values()].find((o) => o._type === "ad" && o.name === "A3-Kolhapuri")!;
    const { data } = await call(client, "get_insights", { object_id: ad.id, level: "campaign" });
    expect(data.level).toBe("ad");
    expect(data.totals.conversations).toBe(0);
  });

  it("since after until is refused", async () => {
    const { ok, data } = await call(client, "get_insights", { since: "2026-10-10", until: "2026-10-01" });
    expect(ok).toBe(false);
    expect(data.error).toMatch(/after/);
  });
});

describe("orders", () => {
  it("log_orders links to an existing Ads Manager ad (mirrors it on demand)", async () => {
    const ad = [...h.mock.objects.values()].find((o) => o._type === "ad" && o.name === "A1-Wedding-Pearl" && o.status === "ACTIVE" && !o.id.startsWith("x"))!;
    const date = addDays(todayIn(), -1);
    const { ok, data } = await call(client, "log_orders", { date, ad_id: ad.id, chats: 40, orders: 12, refused: 2, revenue: 36000, note: "Pearl flats" });
    expect(ok, JSON.stringify(data)).toBe(true);
    expect(data).toMatchObject({ date, ad_id: ad.id, delivered: 10, created_by: "claude-mcp" });
    ids.seededAd = ad.id;
    await call(client, "log_orders", { date: addDays(todayIn(), -2), chats: 10, orders: 3, revenue: 9000 });
  });

  it("refused cannot exceed orders", async () => {
    const { ok, data } = await call(client, "log_orders", { date: todayIn(), chats: 5, orders: 1, refused: 2, revenue: 100 });
    expect(ok).toBe(false);
    expect(data.error).toMatch(/cannot exceed/);
  });

  it("an ad from another account is refused", async () => {
    const foreign = h.mock.create("ad", { name: "foreign", adset_id: "1", campaign_id: "1", status: "PAUSED", account_id: "424242" });
    const { data } = await call(client, "log_orders", { date: todayIn(), ad_id: foreign.id, chats: 1, orders: 1, revenue: 1 });
    expect(data.rule).toBe("wrong_account");
  });

  it("get_cost_per_order joins Meta spend with the order log", async () => {
    const { ok, data } = await call(client, "get_cost_per_order", { date_preset: "last_7d" });
    expect(ok, JSON.stringify(data)).toBe(true);
    expect(data.total).toMatchObject({ orders: 15, refused: 2, delivered: 13, revenue: 45000 });
    expect(data.total.cost_per_order).toBeCloseTo(data.total.spend / 15, 1);
    expect(data.total.refusal_rate_pct).toBeCloseTo(13.33, 1);
    expect(data.spend_source).toBe("meta");
  });

  it("group_by ad separates orders not linked to an ad", async () => {
    const { data } = await call(client, "get_cost_per_order", { date_preset: "last_7d", group_by: "ad" });
    const linked = data.rows.find((r: any) => r.key === ids.seededAd);
    expect(linked).toMatchObject({ orders: 12, label: "A1-Wedding-Pearl" });
    expect(data.rows.find((r: any) => r.key === "unattributed")).toMatchObject({ orders: 3 });
  });

  it("group_by day lists every day; source db works after sync_now", async () => {
    const sync = await call(client, "sync_now", { days: 7 });
    expect(sync.ok, JSON.stringify(sync.data)).toBe(true);
    expect(sync.data.insights.upserted).toBeGreaterThan(0);
    const { data } = await call(client, "get_cost_per_order", { date_preset: "last_7d", group_by: "day", source: "db" });
    expect(data.spend_source).toBe("db");
    expect(data.rows).toHaveLength(7);
    expect(data.total.spend).toBeGreaterThan(0);
  });

  it("falls back to DB spend when Meta is down", async () => {
    h.mock.failNext(/insights$/, { status: 500, times: 10, error: { message: "boom", code: 2, is_transient: true } });
    const { data } = await call(client, "get_cost_per_order", { date_preset: "last_7d" });
    expect(data.spend_source).toBe("db");
    h.mock.failures = [];
  });
});

describe("phase 2 management", () => {
  it("bulk_update pauses several ads without confirm", async () => {
    const { ok, data } = await call(client, "bulk_update", { items: ids.ads.map((a: any) => ({ object_id: a.ad_id, status: "PAUSED" })) });
    expect(ok).toBe(true);
    expect(data.succeeded).toBe(2);
  });

  it("bulk_update activation without confirm is refused as a whole", async () => {
    const { ok, data } = await call(client, "bulk_update", { items: [{ object_id: ids.ads[0].ad_id, status: "ACTIVE" }] });
    expect(ok).toBe(false);
    expect(data.rule).toBe("confirm_required");
  });

  it("bulk_update reports per-item guard failures", async () => {
    const { data } = await call(client, "bulk_update", { items: [{ object_id: ids.adset, daily_budget: 5000 }, { object_id: ids.adset, daily_budget: 450 }], confirm: true });
    expect(data.results[0]).toMatchObject({ ok: false });
    expect(data.results[0].error).toMatch(/cap/);
    expect(data.results[1]).toMatchObject({ ok: true });
  });

  it("duplicate_campaign copies to Lahore, PAUSED, with a new budget", async () => {
    const { ok, data } = await call(client, "duplicate_campaign", { campaign_id: ids.campaign, new_name: "SZ-LHR-Prospecting-WA", city: "Lahore", daily_budget: 500 });
    expect(ok, JSON.stringify(data)).toBe(true);
    expect(data).toMatchObject({ name: "SZ-LHR-Prospecting-WA", status: "PAUSED", city: "Lahore" });
    const copy = h.mock.objects.get(data.campaign_id)!;
    expect(copy.status).toBe("PAUSED");
    const sets = [...h.mock.objects.values()].filter((o) => o._type === "adset" && o.campaign_id === data.campaign_id);
    expect(sets).toHaveLength(1);
    expect(sets[0]!.targeting.geo_locations.cities).toEqual([{ key: "2211241" }]);
    expect(sets[0]!.daily_budget).toBe("50000");
    expect(sets[0]!.status).toBe("PAUSED");
    const ads = [...h.mock.objects.values()].filter((o) => o._type === "ad" && o.campaign_id === data.campaign_id);
    expect(ads.every((a) => a.status === "PAUSED")).toBe(true);
  });

  it("duplicate_campaign refuses a budget above the cap", async () => {
    const { data } = await call(client, "duplicate_campaign", { campaign_id: ids.campaign, daily_budget: 9000 });
    expect(data.rule).toBe("budget_cap");
  });
});

describe("rate limits and transient errors", () => {
  it("retries a rate-limited read and succeeds", async () => {
    h.mock.failNext(new RegExp(`^${h.mock.act}$`), { method: "GET", error: { message: "User request limit reached", code: 17 } });
    const { ok } = await call(client, "get_account");
    expect(ok).toBe(true);
  });

  it("reads usage headers and reports usage above 75%", async () => {
    h.mock.usagePct = 90;
    const { data } = await call(client, "get_account");
    expect(data.rate_limit_usage.max_pct).toBe(90);
    h.mock.usagePct = 5;
  });

  it("does not blindly retry a failed write", async () => {
    h.mock.failNext(/^act_\d+\/campaigns$/, { method: "POST", status: 500, error: { message: "Unknown error", code: 1, is_transient: true } });
    const before = h.mock.calls.filter((c) => c.method === "POST" && c.path.endsWith("/campaigns")).length;
    const { ok, data } = await call(client, "create_campaign", { name: "Write-Retry" });
    expect(ok).toBe(false);
    expect(data.error).toMatch(/temporary problem/);
    expect(h.mock.calls.filter((c) => c.method === "POST" && c.path.endsWith("/campaigns")).length).toBe(before + 1);
  });
});
