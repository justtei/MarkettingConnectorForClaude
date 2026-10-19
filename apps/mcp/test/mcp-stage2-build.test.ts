// Stage 2 (spec week 2): targeting search, media upload, create campaign/ad set/creative/ad, guards, audit log.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDb } from "@sandalez/db";
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
});
afterAll(async () => {
  await client?.close();
  await mcp?.close();
  await h?.close();
});

const sample = () => `${h.mock.baseUrl}/__mock/media/sample.jpg`;

describe("targeting", () => {
  it("search_interests finds shoe interests", async () => {
    const { ok, data } = await call(client, "search_interests", { query: "shoe" });
    expect(ok).toBe(true);
    expect(data.map((i: any) => i.name)).toContain("Shoes");
    expect(data[0].id).toMatch(/^\d+$/);
  });

  it("search_locations resolves Karachi to its city key (Pakistan only)", async () => {
    const { data } = await call(client, "search_locations", { query: "Karachi" });
    expect(data).toEqual([expect.objectContaining({ key: "2211096", name: "Karachi", type: "city", country_code: "PK" })]);
  });

  it("estimate_audience returns bounds for Karachi women 20-40", async () => {
    const { ok, data } = await call(client, "estimate_audience", { targeting: { cities: ["Karachi"], age_min: 20, age_max: 40, gender: "female" } });
    expect(ok).toBe(true);
    expect(data.users_upper_bound).toBeGreaterThan(data.users_lower_bound);
    expect(data.targeting).toMatchObject({ geo_locations: { cities: [{ key: "2211096" }] }, genders: [2], age_min: 20, age_max: 40 });
  });

  it("estimate_audience without a location is a clear input error", async () => {
    const { ok, data } = await call(client, "estimate_audience", { targeting: { age_min: 20 } });
    expect(ok).toBe(false);
    expect(data.kind).toBe("input");
    expect(data.error).toMatch(/location/i);
  });

  it("unknown city is a clear input error", async () => {
    const { ok, data } = await call(client, "estimate_audience", { targeting: { cities: ["Atlantis"] } });
    expect(ok).toBe(false);
    expect(data.error).toMatch(/No city called "Atlantis"/);
  });

  it("age_min above age_max is refused", async () => {
    const { ok, data } = await call(client, "estimate_audience", { targeting: { cities: ["Karachi"], age_min: 40, age_max: 20 } });
    expect(ok).toBe(false);
    expect(data.error).toMatch(/greater than age_max/);
  });
});

describe("assets", () => {
  it("upload_image from a URL returns a hash and records the asset + audit", async () => {
    const { ok, data } = await call(client, "upload_image", { url: sample(), name: "pearl.jpg" });
    expect(ok).toBe(true);
    expect(data.image_hash).toMatch(/^[a-f0-9]{32}$/);
    ids.imageHash = data.image_hash;
    expect(await db.asset.findUnique({ where: { metaRef: data.image_hash } })).toMatchObject({ type: "image", name: "pearl.jpg" });
    const audit = await db.auditLog.findFirst({ where: { action: "upload_image" } });
    expect(audit).toMatchObject({ actor: "claude-mcp", ok: true, objectId: data.image_hash });
  });

  it("upload_image from base64 works and the bytes are not stored in the audit log", async () => {
    const b64 = (await (await fetch(sample())).arrayBuffer()) as ArrayBuffer;
    const { ok, data } = await call(client, "upload_image", { base64: `data:image/jpeg;base64,${Buffer.from(b64).toString("base64")}`, name: "b64.jpg" });
    expect(ok).toBe(true);
    expect(data.image_hash).toBe(ids.imageHash);
    const all = JSON.stringify(await db.auditLog.findMany());
    expect(all).not.toContain(Buffer.from(b64).toString("base64").slice(0, 40));
  });

  it("upload_image rejects a non-image URL", async () => {
    const { ok, data } = await call(client, "upload_image", { url: `${h.mock.baseUrl}/__mock/media/not-image.txt` });
    expect(ok).toBe(false);
    expect(data.error).toMatch(/not an image/);
  });

  it("upload_image with neither url nor base64 is refused", async () => {
    const { ok, data } = await call(client, "upload_image", {});
    expect(ok).toBe(false);
    expect(data.error).toMatch(/url or base64/);
  });

  it("upload_video by URL returns a video ID and can wait until ready", async () => {
    const { ok, data } = await call(client, "upload_video", { url: `${h.mock.baseUrl}/__mock/media/sample.mp4`, wait_until_ready: true });
    expect(ok).toBe(true);
    expect(data).toMatchObject({ status: "ready", name: "sample.mp4" });
    ids.videoId = data.video_id;
  });

  it("list_assets returns images and videos", async () => {
    const { data } = await call(client, "list_assets", { type: "all" });
    expect(data.images.map((i: any) => i.image_hash)).toContain(ids.imageHash);
    expect(data.videos.map((v: any) => v.video_id)).toContain(ids.videoId);
  });
});

describe("campaign building (always PAUSED)", () => {
  it("create_campaign forces PAUSED even if the caller asks for ACTIVE", async () => {
    const { ok, data } = await call(client, "create_campaign", { name: "SZ-Test-WA", status: "ACTIVE" } as any);
    expect(ok).toBe(true);
    expect(data).toMatchObject({ status: "PAUSED", objective: "OUTCOME_ENGAGEMENT" });
    ids.campaign = data.campaign_id;
    const meta = h.mock.objects.get(data.campaign_id)!;
    expect(meta.status).toBe("PAUSED");
    expect(meta.is_adset_budget_sharing_enabled).toBe("false"); // form-encoded, as Meta receives it
    expect(await db.campaign.findUnique({ where: { id: data.campaign_id } })).toMatchObject({ status: "PAUSED", createdVia: "mcp" });
  });

  it("create_adset converts PKR 600 to minor units and fills the WhatsApp promoted object", async () => {
    const { ok, data } = await call(client, "create_adset", {
      campaign_id: ids.campaign,
      name: "SZ-KHI-Women-20-40",
      daily_budget: 600,
      targeting: { cities: ["Karachi"], age_min: 20, age_max: 40, gender: "female", advantage_audience: true },
    });
    expect(ok, JSON.stringify(data)).toBe(true);
    ids.adset = data.adset_id;
    const s = h.mock.objects.get(data.adset_id)!;
    expect(s).toMatchObject({
      status: "PAUSED",
      daily_budget: "60000",
      billing_event: "IMPRESSIONS",
      optimization_goal: "CONVERSATIONS",
      bid_strategy: "LOWEST_COST_WITHOUT_CAP",
      destination_type: "WHATSAPP",
      promoted_object: { page_id: h.mock.opts.pageId, whatsapp_phone_number: "923499066816" },
    });
    expect(s.targeting).toEqual({
      geo_locations: { cities: [{ key: "2211096" }], location_types: ["home", "recent"] },
      age_min: 20,
      age_max: 40,
      genders: [2],
      targeting_automation: { advantage_audience: 1 },
    });
    expect(await db.adSet.findUnique({ where: { id: data.adset_id } })).toMatchObject({ dailyBudget: 600, destination: "WHATSAPP" });
  });

  it("v26: every new ad set states the Advantage+ audience flag (on by default, off above age 25)", async () => {
    const camp = await call(client, "create_campaign", { name: "Advantage flag" });
    const campaign_id = camp.data.campaign_id;
    const plain = await call(client, "create_adset", { campaign_id, name: "default flag", daily_budget: 500, targeting: { cities: ["Karachi"] } });
    expect(plain.ok, JSON.stringify(plain.data)).toBe(true);
    expect(h.mock.objects.get(plain.data.adset_id)!.targeting.targeting_automation).toEqual({ advantage_audience: 1 });

    const older = await call(client, "create_adset", { campaign_id, name: "30+", daily_budget: 500, targeting: { cities: ["Karachi"], age_min: 30, age_max: 50 } });
    expect(older.ok, JSON.stringify(older.data)).toBe(true);
    expect(h.mock.objects.get(older.data.adset_id)!.targeting).toMatchObject({ age_min: 30, targeting_automation: { advantage_audience: 0 } });

    // An explicit request for Advantage+ with age 30 still reaches Meta, whose refusal comes back in plain words.
    const clash = await call(client, "create_adset", { campaign_id, name: "clash", daily_budget: 500, targeting: { cities: ["Karachi"], age_min: 30, advantage_audience: true } });
    expect(clash.ok).toBe(false);
    expect(clash.data.error).toMatch(/25 or lower/);
  });

  it("budget cap: an ad set above PKR 2,000/day is refused before calling Meta", async () => {
    const before = h.mock.calls.filter((c) => c.method === "POST" && c.path.endsWith("/adsets")).length;
    const { ok, data } = await call(client, "create_adset", { campaign_id: ids.campaign, name: "too big", daily_budget: 2500, targeting: { cities: ["Karachi"] } });
    expect(ok).toBe(false);
    expect(data).toMatchObject({ kind: "guard", rule: "budget_cap" });
    expect(data.error).toMatch(/above the cap of PKR 2,000/);
    expect(h.mock.calls.filter((c) => c.method === "POST" && c.path.endsWith("/adsets")).length).toBe(before);
  });

  it("an ad set without budget under a no-budget campaign is refused", async () => {
    const { ok, data } = await call(client, "create_adset", { campaign_id: ids.campaign, name: "no budget", targeting: { cities: ["Karachi"] } });
    expect(ok).toBe(false);
    expect(data.error).toMatch(/daily_budget/);
  });

  it("one ad account only: objects from another account are refused", async () => {
    const foreign = h.mock.create("campaign", { name: "Other brand", objective: "OUTCOME_ENGAGEMENT", status: "PAUSED", account_id: "999999" });
    const { ok, data } = await call(client, "create_adset", { campaign_id: foreign.id, name: "x", daily_budget: 500, targeting: { cities: ["Karachi"] } });
    expect(ok).toBe(false);
    expect(data).toMatchObject({ kind: "guard", rule: "wrong_account" });
    const r2 = await call(client, "set_status", { object_id: foreign.id, status: "PAUSED" });
    expect(r2.data.rule).toBe("wrong_account");
  });

  it("create_creative (image, WhatsApp) builds the CTA and welcome message per the spec", async () => {
    const { ok, data } = await call(client, "create_creative", {
      name: "A1-Wedding-Pearl-img",
      format: "image",
      image_hash: ids.imageHash,
      headline: "Shaadi-ready pearl flats",
      primary_text: "Shaadi season ki tayyari? Pearl flats ab 30% OFF. COD + easy exchange.",
      welcome_message: "Assalam o Alaikum! Sandalez mein khush aamdeed.",
      autofill_message: "Hi Sandalez! Mujhe yeh design chahiye. Size:",
    });
    expect(ok, JSON.stringify(data)).toBe(true);
    ids.creative = data.creative_id;
    const cr = h.mock.objects.get(data.creative_id)!;
    const ld = cr.object_story_spec.link_data;
    expect(cr.object_story_spec.page_id).toBe(h.mock.opts.pageId);
    expect(cr.object_story_spec.instagram_user_id).toBe(h.mock.opts.igUserId);
    expect(ld).toMatchObject({
      image_hash: ids.imageHash,
      name: "Shaadi-ready pearl flats",
      link: "https://api.whatsapp.com/send",
      call_to_action: { type: "WHATSAPP_MESSAGE", value: { app_destination: "WHATSAPP", link: "https://api.whatsapp.com/send" } },
    });
    expect(ld.page_welcome_message).toEqual({
      type: "VISUAL_EDITOR",
      version: 2,
      landing_screen_type: "welcome_message",
      media_type: "text",
      text_format: {
        customer_action_type: "autofill_message",
        message: { text: "Assalam o Alaikum! Sandalez mein khush aamdeed.", autofill_message: { content: "Hi Sandalez! Mujhe yeh design chahiye. Size:" } },
      },
    });
  });

  it("create_creative (video by URL) uploads, waits for processing and uses Meta's thumbnail", async () => {
    const { ok, data } = await call(client, "create_creative", {
      name: "A1-video",
      format: "video",
      video_url: `${h.mock.baseUrl}/__mock/media/sample.mp4`,
      headline: "Pearl flats",
      primary_text: "30% OFF",
      icebreakers: ["Price?", "Sizes?", "Delivery time?"],
    });
    expect(ok, JSON.stringify(data)).toBe(true);
    const vd = h.mock.objects.get(data.creative_id)!.object_story_spec.video_data;
    expect(vd.video_id).toMatch(/^\d+$/);
    expect(vd.image_url).toContain("/__mock/media/sample.jpg");
    const w = vd.page_welcome_message;
    expect(w.text_format.customer_action_type).toBe("ice_breakers");
    expect(w.text_format.message.ice_breakers).toEqual([{ title: "Price?" }, { title: "Sizes?" }, { title: "Delivery time?" }]);
  });

  it("create_creative (carousel) uploads card images", async () => {
    const { ok, data } = await call(client, "create_creative", {
      name: "Carousel",
      format: "carousel",
      primary_text: "New arrivals",
      cards: [
        { image_url: sample(), headline: "Pearl flats" },
        { image_hash: ids.imageHash, headline: "Kolhapuri", description: "PKR 2,499" },
      ],
    });
    expect(ok, JSON.stringify(data)).toBe(true);
    const ld = h.mock.objects.get(data.creative_id)!.object_story_spec.link_data;
    expect(ld.child_attachments).toHaveLength(2);
    expect(ld.child_attachments[0].call_to_action.type).toBe("WHATSAPP_MESSAGE");
  });

  it("create_creative (instagram_post) reuses an existing post", async () => {
    const { ok, data } = await call(client, "create_creative", { name: "IG reuse", format: "instagram_post", instagram_media_id: "17900000000000001" });
    expect(ok, JSON.stringify(data)).toBe(true);
    const cr = h.mock.objects.get(data.creative_id)!;
    expect(cr).toMatchObject({ object_id: h.mock.opts.pageId, source_instagram_media_id: "17900000000000001", instagram_user_id: h.mock.opts.igUserId });
  });

  it("create_creative (dynamic / DCO) builds an asset feed", async () => {
    const { ok, data } = await call(client, "create_creative", {
      name: "DCO",
      format: "dynamic",
      dynamic: { image_hashes: [ids.imageHash], headlines: ["A", "B"], primary_texts: ["X", "Y"] },
    });
    expect(ok, JSON.stringify(data)).toBe(true);
    const f = h.mock.objects.get(data.creative_id)!.asset_feed_spec;
    expect(f).toMatchObject({ images: [{ hash: ids.imageHash }], titles: [{ text: "A" }, { text: "B" }], call_to_action_types: ["WHATSAPP_MESSAGE"] });
  });

  it("create_creative with a missing image is a clear input error (no Meta call)", async () => {
    const { ok, data } = await call(client, "create_creative", { name: "bad", format: "image", primary_text: "x" });
    expect(ok).toBe(false);
    expect(data.kind).toBe("input");
    expect(data.error).toMatch(/need an image/);
  });

  it("create_ad creates a PAUSED ad and mirrors it", async () => {
    const { ok, data } = await call(client, "create_ad", { adset_id: ids.adset, creative_id: ids.creative, name: "A1-Wedding-Pearl" });
    expect(ok, JSON.stringify(data)).toBe(true);
    ids.ad = data.ad_id;
    expect(h.mock.objects.get(data.ad_id)!.status).toBe("PAUSED");
    const ad = await db.ad.findUnique({ where: { id: data.ad_id }, include: { creative: true } });
    expect(ad).toMatchObject({ status: "PAUSED", adSetId: ids.adset, creativeId: ids.creative });
    expect(ad?.creative?.type).toBe("image");
  });

  it("create_ad into a campaign ID (wrong type) is refused", async () => {
    const { ok, data } = await call(client, "create_ad", { adset_id: ids.campaign, creative_id: ids.creative, name: "x" });
    expect(ok).toBe(false);
    expect(data.error).toMatch(/not an ad set/);
  });

  it("add_ad_to_adset creates creative + ad in one call", async () => {
    const { ok, data } = await call(client, "add_ad_to_adset", {
      adset_id: ids.adset,
      name: "A2-new",
      creative: { name: "A2-new", format: "image", image_url: sample(), primary_text: "New design" },
    });
    expect(ok, JSON.stringify(data)).toBe(true);
    expect(h.mock.objects.get(data.ad_id)!.status).toBe("PAUSED");
  });

  it("list_campaigns returns the new and the existing campaigns with PKR budgets", async () => {
    const { data } = await call(client, "list_campaigns", { status: "ALL" });
    const names = data.map((c: any) => c.name);
    expect(names).toContain("SZ-Test-WA");
    expect(names).toContain("SZ-KHI-Existing-WA");
    const paused = await call(client, "list_campaigns", { status: "PAUSED" });
    expect(paused.data.every((c: any) => c.status === "PAUSED")).toBe(true);
  });

  it("get_campaign_tree shows ad sets with budget/targeting and ads", async () => {
    const { data } = await call(client, "get_campaign_tree", { campaign_id: ids.campaign });
    expect(data.adsets).toHaveLength(1);
    expect(data.adsets[0]).toMatchObject({ id: ids.adset, daily_budget: 600, status: "PAUSED" });
    expect(data.adsets[0].ads.length).toBeGreaterThanOrEqual(2);
  });

  it("audit log records every write with actor and request", async () => {
    const actions = (await db.auditLog.findMany({ select: { action: true, actor: true, ok: true } })).map((a) => a.action);
    for (const a of ["create_campaign", "create_adset", "create_creative", "create_ad", "add_ad_to_adset", "upload_image", "upload_video"]) {
      expect(actions, a).toContain(a);
    }
    const failed = await db.auditLog.findFirst({ where: { ok: false } });
    expect(failed).toBeTruthy(); // the injected wrong-type create_ad attempt etc. are logged as failures
    const act = await call(client, "get_activity_log", { limit: 5 });
    expect(act.data.items).toHaveLength(5);
  });
});
