// Several messaging apps per ad (Instagram DMs + WhatsApp + Messenger), Sales objective, text versions,
// Advantage+ creative features, map pins, the ad / ad set destination check, and duplicate_campaign's
// rebuild when Meta's own copy refuses a campaign (retired standard_enhancements).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { call, connectClient, startHarness, startMcp, type Harness } from "../../../test/harness.js";

let h: Harness;
let mcp: Awaited<ReturnType<typeof startMcp>>;
let client: Client;
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

describe("Instagram DMs + WhatsApp", () => {
  it("create_ctwa_campaign builds a Sales campaign with one button per app and text versions", async () => {
    const { ok, data } = await call(client, "create_ctwa_campaign", {
      name: "SZ-KHI-Sales-IG-WA",
      objective: "OUTCOME_SALES",
      messaging_apps: ["instagram_direct", "whatsapp"],
      daily_budget: 600,
      city: "Karachi",
      age_min: 20,
      age_max: 40,
      gender: "female",
      primary_text: "Simple outfit? Let your slides do the talking.",
      primary_texts: ["Sparkle that goes with everything.", "Black or blush, which one is yours?"],
      headline: "Which Pair Is Yours?",
      headlines: ["Black, Blush or Pearl?"],
      creative_features: { text_optimizations: true, video_auto_crop: true },
      creatives: [{ type: "video", name: "Which Pair", video_url: media("sample.mp4"), thumbnail_url: media("sample.jpg") }],
    });
    expect(ok, JSON.stringify(data)).toBe(true);
    Object.assign(ids, { campaign: data.campaign_id, adset: data.adset_id, creative: data.ads[0].creative_id });
    expect(data.messaging_apps).toEqual(["whatsapp", "instagram_direct"]);

    expect(h.mock.objects.get(data.campaign_id)).toMatchObject({ objective: "OUTCOME_SALES", status: "PAUSED" });
    const s = h.mock.objects.get(data.adset_id)!;
    expect(s).toMatchObject({ destination_type: "MESSAGING_INSTAGRAM_DIRECT_WHATSAPP", optimization_goal: "CONVERSATIONS", status: "PAUSED" });
    expect(s.promoted_object).toMatchObject({ page_id: h.mock.opts.pageId, whatsapp_phone_number: expect.any(String), custom_event_type: "PURCHASE" });

    const cr = h.mock.objects.get(ids.creative)!;
    // WhatsApp is the main button; both apps are in the feed.
    expect(cr.object_story_spec.video_data.call_to_action).toMatchObject({ type: "WHATSAPP_MESSAGE", value: { app_destination: "WHATSAPP" } });
    expect(cr.asset_feed_spec.optimization_type).toBe("DOF_MESSAGING_DESTINATION");
    expect(cr.asset_feed_spec.call_to_actions.map((c: any) => c.value.app_destination)).toEqual(["WHATSAPP", "INSTAGRAM_DIRECT"]);
    expect(cr.asset_feed_spec.bodies).toHaveLength(3);
    expect(cr.asset_feed_spec.titles).toHaveLength(2);
    expect(cr.degrees_of_freedom_spec).toEqual({
      creative_features_spec: { text_optimizations: { enroll_status: "OPT_IN" }, video_auto_crop: { enroll_status: "OPT_IN" } },
    });
  });

  it("create_ad explains a WhatsApp-only creative doesn't fit an Instagram + WhatsApp ad set, before calling Meta", async () => {
    const wa = await call(client, "create_creative", {
      name: "WA only",
      format: "image",
      destination: "whatsapp",
      image_url: media("sample.jpg"),
      primary_text: "Order on WhatsApp",
    });
    expect(wa.ok, JSON.stringify(wa.data)).toBe(true);
    const before = h.mock.calls.filter((c) => c.method === "POST" && /\/ads$/.test(c.path)).length;
    const { ok, data } = await call(client, "create_ad", { adset_id: ids.adset, creative_id: wa.data.creative_id, name: "mismatch" });
    expect(ok).toBe(false);
    expect(data.error).toMatch(/WhatsApp, but the ad set .* WhatsApp \+ Instagram DMs/);
    expect(data.error).toMatch(/messaging_apps \["whatsapp","instagram_direct"\]/);
    expect(h.mock.calls.filter((c) => c.method === "POST" && /\/ads$/.test(c.path)).length).toBe(before);
  });

  it("reuses the multi-app creative in a new ad of the same ad set", async () => {
    const { ok, data } = await call(client, "create_ad", { adset_id: ids.adset, creative_id: ids.creative, name: "second ad" });
    expect(ok, JSON.stringify(data)).toBe(true);
    expect(data.status).toBe("PAUSED");
  });

  it("create_adset takes Messenger + WhatsApp and map pins", async () => {
    const camp = await call(client, "create_campaign", { name: "Pins test" });
    const { ok, data } = await call(client, "create_adset", {
      campaign_id: camp.data.campaign_id,
      name: "Pins",
      daily_budget: 500,
      destination: "MESSAGING_MESSENGER_WHATSAPP",
      targeting: {
        pins: [{ latitude: 24.9089, longitude: 67.121, radius_km: 3, name: "Gulistan-e-Johar" }],
        age_min: 20,
        age_max: 40,
        gender: "female",
      },
    });
    expect(ok, JSON.stringify(data)).toBe(true);
    const s = h.mock.objects.get(data.adset_id)!;
    expect(s.destination_type).toBe("MESSAGING_MESSENGER_WHATSAPP");
    expect(s.targeting.geo_locations.custom_locations).toEqual([
      { latitude: 24.9089, longitude: 67.121, radius: 3, distance_unit: "kilometer", name: "Gulistan-e-Johar" },
    ]);
  });

  it("several apps on a carousel is refused with a plain reason", async () => {
    const { ok, data } = await call(client, "create_creative", {
      name: "carousel",
      format: "carousel",
      messaging_apps: ["whatsapp", "messenger"],
      cards: [
        { image_url: media("sample.jpg"), headline: "a" },
        { image_url: media("sample.jpg"), headline: "b" },
      ],
    });
    expect(ok).toBe(false);
    expect(data.error).toMatch(/image and video creatives only/);
  });

  it("the retired standard_enhancements bundle is refused with what to do instead", async () => {
    const { ok, data } = await call(client, "create_creative", {
      name: "old bundle",
      format: "image",
      image_url: media("sample.jpg"),
      creative_features: { standard_enhancements: true },
    });
    expect(ok).toBe(false);
    expect(data.error).toMatch(/retired 'standard_enhancements'.*one by one/);
  });
});

describe("delete_object", () => {
  it("needs confirm, refuses an active object, then deletes a paused campaign with its ad sets and ads", async () => {
    const camp = await call(client, "create_campaign", { name: "Leftover" });
    const set = await call(client, "create_adset", {
      campaign_id: camp.data.campaign_id,
      name: "Leftover WA",
      daily_budget: 500,
      targeting: { cities: ["Karachi"], age_min: 20, age_max: 40 },
    });
    expect(set.ok, JSON.stringify(set.data)).toBe(true);
    const id = camp.data.campaign_id;

    const noConfirm = await call(client, "delete_object", { object_id: id });
    expect(noConfirm.data.rule).toBe("confirm_required");
    expect(noConfirm.data.error).toMatch(/permanently delete campaign "Leftover".*1 ad set/);
    expect(h.mock.objects.get(id)!.status).toBe("PAUSED");

    h.mock.objects.get(id)!.status = "ACTIVE";
    const active = await call(client, "delete_object", { object_id: id, confirm: true });
    expect(active.ok).toBe(false);
    expect(active.data.error).toMatch(/is active\. Pause it first/);
    h.mock.objects.get(id)!.status = "PAUSED";

    const { ok, data } = await call(client, "delete_object", { object_id: id, confirm: true });
    expect(ok, JSON.stringify(data)).toBe(true);
    expect(data).toMatchObject({ deleted: true, type: "campaign", also_deleted: { adsets: 1, ads: 0 } });
    expect(h.mock.objects.get(id)!.status).toBe("DELETED");
    const rows = await h.core.db.adSet.findMany({ where: { campaignId: id } });
    expect(rows.every((r) => r.status === "DELETED")).toBe(true);
    const audit = await h.core.db.auditLog.findFirst({ where: { action: "delete_object", objectId: id } });
    expect(audit?.ok).toBe(true);
    expect((audit?.before as any).name).toBe("Leftover");
  });

  it("refuses things that aren't campaigns, ad sets or ads", async () => {
    const { ok, data } = await call(client, "delete_object", { object_id: ids.creative, confirm: true });
    expect(ok).toBe(false);
    expect(data.error).toMatch(/only campaigns, ad sets and ads can be deleted/);
  });
});

describe("duplicate_campaign when Meta's copy refuses the campaign", () => {
  it("rebuilds it object by object, keeps the destination, and cleans the creative", async () => {
    // Make the source look like an older ad: its creative still carries the retired bundle, so /copies fails.
    const src = h.mock.objects.get(ids.creative)!;
    src.degrees_of_freedom_spec = {
      creative_features_spec: { standard_enhancements: { enroll_status: "OPT_IN" }, inline_comment: { enroll_status: "OPT_IN" } },
    };
    // And Meta refuses to reuse that creative in a new ad, so a clean copy of the creative is made.
    h.mock.failNext(/^act_\d+\/ads$/, {
      method: "POST",
      error: { message: "Invalid parameter", code: 100, error_subcode: 1885183, error_user_msg: "Ads creative post was created by an app that is in development mode." },
    });

    const { ok, data } = await call(client, "duplicate_campaign", { campaign_id: ids.campaign, new_name: "SZ-KHI-Sales-IG-WA (stable)" });
    expect(ok, JSON.stringify(data)).toBe(true);
    expect(data).toMatchObject({ method: "rebuilt", name: "SZ-KHI-Sales-IG-WA (stable)", status: "PAUSED" });
    expect(data.meta_copy_error).toMatch(/standard enhancements/i);
    expect(data.notes.join(" ")).toMatch(/clean copy of its creative/);

    const sets = [...h.mock.objects.values()].filter((o) => o._type === "adset" && o.campaign_id === data.campaign_id);
    expect(sets).toHaveLength(1);
    expect(sets[0]).toMatchObject({ destination_type: "MESSAGING_INSTAGRAM_DIRECT_WHATSAPP", status: "PAUSED", daily_budget: "60000" });
    const ads = [...h.mock.objects.values()].filter((o) => o._type === "ad" && o.campaign_id === data.campaign_id);
    expect(ads.length).toBeGreaterThan(0);
    expect(ads.every((a) => a.status === "PAUSED")).toBe(true);
    const copied = h.mock.objects.get(String(ads[0]!.creative.id))!;
    expect(copied.id).not.toBe(ids.creative);
    expect(copied.degrees_of_freedom_spec).toEqual({ creative_features_spec: { inline_comment: { enroll_status: "OPT_IN" } } });
    expect(copied.asset_feed_spec.call_to_actions).toHaveLength(2);
  });
});
