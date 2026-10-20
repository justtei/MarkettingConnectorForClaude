import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  addDays,
  appsForCreative,
  appsForDestinationType,
  destinationTypeForApps,
  sanitizeDegreesOfFreedom,
  buildCreativePayload,
  buildWelcomeMessage,
  checkDailyBudget,
  forcePaused,
  fromMinorUnits,
  GuardError,
  loadConfig,
  MetaApiError,
  MetaClient,
  requireConfirm,
  resolveRange,
  sanitizeForAudit,
  toMinorUnits,
  assertOwnAccount,
  webhooksService,
  audiencesService,
  insightsService,
  shopifyService,
  targetingService,
} from "../src/index.js";

const baseEnv = { META_ACCESS_TOKEN: "t", META_AD_ACCOUNT_ID: "act_123" };

describe("money", () => {
  it("converts PKR to minor units and back (the 100x bug guard)", () => {
    expect(toMinorUnits(600, "PKR")).toBe("60000");
    expect(fromMinorUnits("60000", "PKR")).toBe(600);
    expect(toMinorUnits(599.995, "PKR")).toBe("60000");
    expect(toMinorUnits(1000, "JPY")).toBe("1000");
    expect(fromMinorUnits(null, "PKR")).toBeNull();
    expect(() => toMinorUnits(-1, "PKR")).toThrow();
    expect(() => toMinorUnits(Number.NaN, "PKR")).toThrow();
  });
});

describe("config", () => {
  it("applies defaults and pins v26.0", () => {
    const c = loadConfig(baseEnv);
    expect(c.META_API_VERSION).toBe("v26.0");
    expect(c.MAX_DAILY_BUDGET_PKR).toBe(2000);
    expect(c.MAX_BUDGET_INCREASE_PCT).toBe(30);
  });
  it("rejects a bad account ID and missing token with readable messages", () => {
    expect(() => loadConfig({ META_AD_ACCOUNT_ID: "123" })).toThrow(/META_ACCESS_TOKEN[\s\S]*act_/);
  });
  it("normalizes the WhatsApp number to digits", () => {
    expect(loadConfig({ ...baseEnv, WHATSAPP_PHONE_NUMBER: "+92 349-9066816" }).WHATSAPP_PHONE_NUMBER).toBe("923499066816");
  });
});

describe("guards", () => {
  const s = { maxDailyBudgetPkr: 2000, maxBudgetIncreasePct: 30 };
  it("forcePaused overrides any status", () => {
    expect(forcePaused({ name: "x", status: "ACTIVE" }).status).toBe("PAUSED");
  });
  it("requireConfirm only accepts literal true", () => {
    expect(() => requireConfirm(undefined, "x")).toThrow(GuardError);
    expect(() => requireConfirm(false, "x")).toThrow(/confirm: true/);
    expect(() => requireConfirm(true, "x")).not.toThrow();
  });
  it("budget cap and increase limit", () => {
    expect(() => checkDailyBudget(s, 2000)).not.toThrow();
    expect(() => checkDailyBudget(s, 2001)).toThrow(/above the cap/);
    expect(() => checkDailyBudget(s, 1300, 1000)).not.toThrow();
    expect(() => checkDailyBudget(s, 1301, 1000)).toThrow(/30% per change/);
    expect(() => checkDailyBudget(s, 100, 1000)).not.toThrow();
    expect(() => checkDailyBudget(s, 0)).toThrow(/positive/);
  });
  it("one ad account only", () => {
    const c = loadConfig(baseEnv);
    expect(() => assertOwnAccount(c, "123")).not.toThrow();
    expect(() => assertOwnAccount(c, "act_123")).not.toThrow();
    expect(() => assertOwnAccount(c, "456")).toThrow(/not the Sandalez account/);
  });
});

describe("audit sanitizing", () => {
  it("drops secrets and large blobs", () => {
    const out = sanitizeForAudit({ access_token: "x", password: "p", base64: "aaa", nested: { token: "t", text: "a".repeat(3000) }, ok: 1 }) as any;
    expect(out).toMatchObject({ access_token: "[omitted]", password: "[omitted]", base64: "[omitted]", ok: 1 });
    expect(out.nested.token).toBe("[omitted]");
    expect(out.nested.text).toBe("[3000 chars omitted]");
  });
});

describe("dates", () => {
  it("resolves presets in Karachi time", () => {
    const now = new Date("2026-10-16T20:30:00Z"); // 01:30 on Oct 17 in Karachi
    vi.useFakeTimers();
    vi.setSystemTime(now);
    expect(resolveRange({ date_preset: "today" })).toEqual({ since: "2026-10-17", until: "2026-10-17" });
    expect(resolveRange({ date_preset: "last_7d" })).toEqual({ since: "2026-10-10", until: "2026-10-16" });
    expect(resolveRange({ date_preset: "last_month" })).toEqual({ since: "2026-09-01", until: "2026-09-30" });
    expect(resolveRange({ date_preset: "this_week_mon_today" }).since).toBe("2026-10-12");
    expect(resolveRange({ since: "2026-10-01" })).toEqual({ since: "2026-10-01", until: "2026-10-17" });
    vi.useRealTimers();
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
    expect(() => resolveRange({ since: "2026-10-05", until: "2026-10-01" })).toThrow();
  });
});

describe("creative payloads (fixtures from the spec)", () => {
  it("video CTWA creative matches the spec payload", () => {
    const p = buildCreativePayload({
      name: "A1-Wedding-Pearl",
      format: "video",
      destination: "whatsapp",
      page_id: "PAGE",
      instagram_user_id: "IG",
      video_id: "VID",
      thumbnail_hash: "THUMB",
      headline: "Shaadi-ready pearl flats",
      primary_text: "Shaadi season ki tayyari? Pearl flats ab 30% OFF. COD + easy exchange.",
      welcome: { welcome_message: "Assalam o Alaikum! Sandalez mein khush aamdeed.", autofill_message: "Hi Sandalez! Mujhe yeh design chahiye. Size:" },
    }) as any;
    expect(p.object_story_spec).toMatchObject({
      page_id: "PAGE",
      instagram_user_id: "IG",
      video_data: {
        video_id: "VID",
        image_hash: "THUMB",
        title: "Shaadi-ready pearl flats",
        call_to_action: { type: "WHATSAPP_MESSAGE", value: { app_destination: "WHATSAPP", link: "https://api.whatsapp.com/send" } },
      },
    });
    expect(p.object_story_spec.video_data.page_welcome_message.text_format.message.autofill_message.content).toBe(
      "Hi Sandalez! Mujhe yeh design chahiye. Size:",
    );
  });
  it("website image creative uses the link and SHOP_NOW", () => {
    const p = buildCreativePayload({ name: "w", format: "image", destination: "website", page_id: "P", image_hash: "H", link: "https://sandalez.pk" }) as any;
    expect(p.object_story_spec.link_data).toMatchObject({ link: "https://sandalez.pk", call_to_action: { type: "SHOP_NOW", value: { link: "https://sandalez.pk" } } });
    expect(p.object_story_spec.link_data.page_welcome_message).toBeUndefined();
  });
  it("rejects incomplete creatives", () => {
    expect(() => buildCreativePayload({ name: "x", format: "video", destination: "whatsapp", page_id: "P", video_id: "V" })).toThrow(/thumbnail/);
    expect(() => buildCreativePayload({ name: "x", format: "carousel", destination: "whatsapp", page_id: "P", cards: [{ headline: "a", image_hash: "h" }] })).toThrow(/2 to 10/);
    expect(() => buildCreativePayload({ name: "x", format: "image", destination: "website", page_id: "P", image_hash: "h" })).toThrow(/link/);
  });
  it("defaults the welcome message and caps icebreakers at 4", () => {
    const w = buildWelcomeMessage({ icebreakers: ["a", "b", "c", "d", "e"] }) as any;
    expect(w.text_format.message.ice_breakers).toHaveLength(4);
    expect((buildWelcomeMessage({}) as any).text_format.message.text).toMatch(/Sandalez/);
  });
});

describe("messaging destinations", () => {
  it("maps apps to ad set destinations and back", () => {
    expect(destinationTypeForApps(["whatsapp"])).toBe("WHATSAPP");
    expect(destinationTypeForApps(["whatsapp", "instagram_direct"])).toBe("MESSAGING_INSTAGRAM_DIRECT_WHATSAPP");
    expect(destinationTypeForApps(["messenger", "whatsapp", "instagram_direct"])).toBe("MESSAGING_INSTAGRAM_DIRECT_MESSENGER_WHATSAPP");
    expect(appsForDestinationType("MESSAGING_MESSENGER_WHATSAPP")).toEqual(["whatsapp", "messenger"]);
    expect(appsForDestinationType("INSTAGRAM_DIRECT")).toEqual(["instagram_direct"]);
    expect(appsForDestinationType("WEBSITE")).toEqual([]);
  });
  it("reads the apps from a creative as Meta returns it (the live Instagram + WhatsApp ad)", () => {
    const live = {
      object_story_spec: { video_data: { call_to_action: { type: "WHATSAPP_MESSAGE", value: { app_destination: "WHATSAPP" } } } },
      asset_feed_spec: {
        optimization_type: "DOF_MESSAGING_DESTINATION",
        call_to_actions: [
          { type: "WHATSAPP_MESSAGE", value: { app_destination: "WHATSAPP" } },
          { type: "INSTAGRAM_MESSAGE", value: { app_destination: "INSTAGRAM_DIRECT", app_link: "instagram://direct?userid=1" } },
        ],
      },
    };
    expect(appsForCreative(live)).toEqual(["whatsapp", "instagram_direct"]);
  });
  it("builds one button per app with WhatsApp as the main button", () => {
    const p = buildCreativePayload({
      name: "multi",
      format: "image",
      destination: "whatsapp",
      messaging_apps: ["messenger", "instagram_direct", "whatsapp"],
      page_id: "P",
      instagram_user_id: "IG",
      image_hash: "H",
      primary_text: "t",
    }) as any;
    expect(p.object_story_spec.link_data.call_to_action.type).toBe("WHATSAPP_MESSAGE");
    expect(p.object_story_spec.link_data.page_welcome_message).toBeDefined();
    expect(p.asset_feed_spec).toEqual({
      optimization_type: "DOF_MESSAGING_DESTINATION",
      call_to_actions: [
        { type: "WHATSAPP_MESSAGE", value: { app_destination: "WHATSAPP", link: "https://api.whatsapp.com/send" } },
        { type: "INSTAGRAM_MESSAGE", value: { app_destination: "INSTAGRAM_DIRECT", link: "https://www.instagram.com" } },
        { type: "MESSAGE_PAGE", value: { app_destination: "MESSENGER", link: "https://fb.com/messenger_doc/" } },
      ],
    });
  });
  it("single Instagram or Messenger destinations get their own button", () => {
    const ig = buildCreativePayload({ name: "ig", format: "image", destination: "instagram_direct", page_id: "P", image_hash: "H" }) as any;
    expect(ig.object_story_spec.link_data.call_to_action).toEqual({ type: "INSTAGRAM_MESSAGE", value: { app_destination: "INSTAGRAM_DIRECT", link: "https://www.instagram.com" } });
    expect(ig.asset_feed_spec).toBeUndefined();
    const m = buildCreativePayload({ name: "m", format: "image", destination: "messenger", page_id: "P", image_hash: "H" }) as any;
    expect(m.object_story_spec.link_data.call_to_action).toEqual({ type: "MESSAGE_PAGE", value: { app_destination: "MESSENGER" } });
    expect(m.object_story_spec.link_data.link).toBe("https://fb.com/messenger_doc/");
  });
  it("text versions use DEGREES_OF_FREEDOM and drop duplicates", () => {
    const p = buildCreativePayload({
      name: "v", format: "video", destination: "whatsapp", page_id: "P", video_id: "V", thumbnail_hash: "T",
      primary_text: "a", primary_texts: ["b", "a"], headline: "h",
    }) as any;
    expect(p.asset_feed_spec).toEqual({ optimization_type: "DEGREES_OF_FREEDOM", bodies: [{ text: "a" }, { text: "b" }], titles: [{ text: "h" }] });
  });
  it("creative features are named one by one; the retired bundle is refused and stripped from copies", () => {
    const p = buildCreativePayload({ name: "f", format: "image", destination: "whatsapp", page_id: "P", image_hash: "H", creative_features: { image_touchups: true, inline_comment: false } }) as any;
    expect(p.degrees_of_freedom_spec).toEqual({ creative_features_spec: { image_touchups: { enroll_status: "OPT_IN" }, inline_comment: { enroll_status: "OPT_OUT" } } });
    expect(() => buildCreativePayload({ name: "f", format: "image", destination: "whatsapp", page_id: "P", image_hash: "H", creative_features: { standard_enhancements: true } })).toThrow(/retired/);
    expect(sanitizeDegreesOfFreedom({ creative_features_spec: { standard_enhancements: { enroll_status: "OPT_IN" } } })).toBeUndefined();
    expect(sanitizeDegreesOfFreedom({ creative_features_spec: { standard_enhancements: {}, video_auto_crop: { enroll_status: "OPT_IN" } } })).toEqual({
      creative_features_spec: { video_auto_crop: { enroll_status: "OPT_IN" } },
    });
  });
});

describe("Shopify order outcome", () => {
  const tags = ["refused", "rto"];
  const st = (o: Record<string, unknown>) => shopifyService.orderStatus(o, tags);
  it("maps Shopify's states to pending / delivered / refused / cancelled", () => {
    expect(st({})).toBe("pending");
    expect(st({ fulfillments: [{ displayStatus: "DELIVERED" }] })).toBe("delivered");
    expect(st({ displayFinancialStatus: "PAID", displayFulfillmentStatus: "FULFILLED" })).toBe("delivered");
    expect(st({ tags: ["RTO"], fulfillments: [{ displayStatus: "DELIVERED" }] })).toBe("refused");
    expect(st({ returnStatus: "RETURNED" })).toBe("refused");
    expect(st({ fulfillments: [{ displayStatus: "NOT_DELIVERED" }] })).toBe("refused");
    expect(st({ cancelledAt: "2026-10-01T00:00:00Z", fulfillments: [{ displayStatus: "IN_TRANSIT" }] })).toBe("refused");
    expect(st({ cancelledAt: "2026-10-01T00:00:00Z" })).toBe("cancelled");
  });
});

describe("creative asset breakdowns", () => {
  it("labels asset breakdown objects by their text, name or media ID", () => {
    const row = insightsService.parseInsightRow(
      { date_start: "2026-10-01", date_stop: "2026-10-01", spend: "10", body_asset: { text: "Sparkle for Eid", id: "1" }, video_asset: { video_id: "99", id: "2" } },
      ["body_asset", "video_asset"],
    );
    expect(row.breakdown).toEqual({ body_asset: "Sparkle for Eid", video_asset: "99" });
  });
});

describe("targeting merge", () => {
  it("drops read-only fields Meta returns", () => {
    const m = targetingService.mergeTargeting({ age_min: 20, age_range: [20, 40], geo_locations: { countries: ["PK"] } }, { age_min: 25 });
    expect(m).toEqual({ age_min: 25, geo_locations: { countries: ["PK"] } });
  });
});

describe("insights parsing", () => {
  it("extracts conversations and cost per conversation from actions", () => {
    const r = insightsService.parseInsightRow({
      spend: "1234.5",
      impressions: "10000",
      clicks: "150",
      ctr: "1.5",
      actions: [{ action_type: "onsite_conversion.messaging_conversation_started_7d", value: "30" }],
      cost_per_action_type: [{ action_type: "onsite_conversion.messaging_conversation_started_7d", value: "41.15" }],
    });
    expect(r).toMatchObject({ spend: 1234.5, conversations: 30, cost_per_conversation: 41.15, video_p25: null });
    expect(insightsService.totalsOf([r, r])).toMatchObject({ spend: 2469, conversations: 60, cost_per_conversation: 41.15, ctr: 1.5 });
  });
});

describe("phones and signatures", () => {
  it("normalizes Pakistani numbers to 92XXXXXXXXXX", () => {
    expect(audiencesService.normalizePhone("0349-9066816")).toBe("923499066816");
    expect(audiencesService.normalizePhone("+92 349 9066816")).toBe("923499066816");
    expect(audiencesService.normalizePhone("0092 3499066816")).toBe("923499066816");
    expect(audiencesService.normalizePhone("3499066816")).toBe("923499066816");
  });
  it("verifies Meta and Shopify webhook signatures", () => {
    const body = '{"a":1}';
    const meta = "sha256=" + createHmac("sha256", "s3cret").update(body).digest("hex");
    expect(webhooksService.verifyMetaSignature(body, meta, "s3cret")).toBe(true);
    expect(webhooksService.verifyMetaSignature(body, meta, "other")).toBe(false);
    expect(webhooksService.verifyMetaSignature(body, undefined, "s3cret")).toBe(false);
    const shop = createHmac("sha256", "shop").update(body).digest("base64");
    expect(webhooksService.verifyShopifySignature(body, shop, "shop")).toBe(true);
    expect(webhooksService.verifyShopifySignature(body + " ", shop, "shop")).toBe(false);
  });
});

describe("MetaClient", () => {
  const ok = (body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status: 200, headers });
  const fail = (code: number, status = 400, extra: Record<string, unknown> = {}) =>
    new Response(JSON.stringify({ error: { message: "m", code, fbtrace_id: "TRACE", ...extra } }), { status });

  function client(fetchImpl: any, extra: Record<string, unknown> = {}) {
    const sleeps: number[] = [];
    const c = new MetaClient({
      accessToken: "tok",
      appSecret: "sec",
      apiVersion: "v26.0",
      baseUrl: "https://graph.example/",
      retryBaseMs: 10,
      fetchImpl,
      sleep: async (ms) => void sleeps.push(ms),
      ...extra,
    });
    return { c, sleeps };
  }

  it("builds versioned URLs with token and appsecret_proof; JSON-encodes objects on POST", async () => {
    const fetchImpl = vi.fn(async () => ok({ id: "1" }));
    const { c } = client(fetchImpl);
    await c.get("act_1/campaigns", { fields: "id", effective_status: ["ACTIVE"] });
    const [url] = fetchImpl.mock.calls[0]! as any[];
    expect(url).toMatch(/^https:\/\/graph\.example\/v26\.0\/act_1\/campaigns\?/);
    const u = new URL(url);
    expect(u.searchParams.get("effective_status")).toBe('["ACTIVE"]');
    expect(u.searchParams.get("appsecret_proof")).toBe(createHmac("sha256", "sec").update("tok").digest("hex"));
    await c.post("act_1/adsets", { targeting: { age_min: 20 } });
    const [, init] = fetchImpl.mock.calls[1]! as any[];
    expect(init.method).toBe("POST");
    expect(new URLSearchParams(init.body.toString()).get("targeting")).toBe('{"age_min":20}');
  });

  it("maps errors to plain language and keeps fbtrace_id", async () => {
    const { c } = client(async () => fail(190, 400, { error_subcode: 463 }));
    const err = (await c.get("me").catch((e) => e)) as MetaApiError;
    expect(err).toBeInstanceOf(MetaApiError);
    expect(err.plain).toMatch(/expired/);
    expect(err.fbtraceId).toBe("TRACE");
    expect(err.transient).toBe(false);
  });

  it("retries rate-limit errors with backoff, then succeeds", async () => {
    let n = 0;
    const { c, sleeps } = client(async () => (++n < 3 ? fail(17) : ok({ ok: true })));
    expect(await c.post("x", {})).toEqual({ ok: true });
    expect(n).toBe(3);
    expect(sleeps.length).toBe(2);
    expect(sleeps[1]!).toBeGreaterThan(sleeps[0]!);
  });

  it("gives up after maxRetries", async () => {
    let n = 0;
    const { c } = client(async () => (n++, fail(4)), { maxRetries: 2 });
    await expect(c.get("x")).rejects.toThrow(/Too many calls/);
    expect(n).toBe(3);
  });

  it("retries network errors for reads but not writes", async () => {
    let n = 0;
    const { c } = client(async () => {
      n++;
      throw new TypeError("fetch failed");
    }, { maxRetries: 2 });
    await expect(c.get("x")).rejects.toThrow(/Could not reach Meta/);
    expect(n).toBe(3);
    n = 0;
    await expect(c.post("x", {})).rejects.toThrow(/Could not reach Meta/);
    expect(n).toBe(1);
  });

  it("throttles when usage passes 75% and waits for regain time at 100%", async () => {
    const usage = (pct: number, regain = 0) => ({
      "x-business-use-case-usage": JSON.stringify({ "1": [{ call_count: pct, total_cputime: 1, total_time: 1, estimated_time_to_regain_access: regain }] }),
    });
    const responses = [ok({}, usage(90)), ok({}, usage(10))];
    const { c, sleeps } = client(async () => responses.shift() ?? ok({}));
    await c.get("a");
    expect(c.lastUsage?.maxPct).toBe(90);
    await c.get("b");
    expect(sleeps.length).toBe(1);
    expect(sleeps[0]!).toBeGreaterThan(10_000);
    expect(sleeps[0]!).toBeLessThanOrEqual(18_000);
  });

  it("follows paging.next until done or maxItems", async () => {
    const pages = [
      ok({ data: [1, 2], paging: { next: "https://graph.example/v26.0/x?after=2" } }),
      ok({ data: [3, 4], paging: { next: "https://graph.example/v26.0/x?after=4" } }),
      ok({ data: [5] }),
    ];
    const fetchImpl = vi.fn(async () => pages.shift()!);
    const { c } = client(fetchImpl);
    expect(await c.getAll("x")).toEqual([1, 2, 3, 4, 5]);
    expect((fetchImpl.mock.calls[1] as any[])[0]).toBe("https://graph.example/v26.0/x?after=2");
  });

  it("allows a per-call access_token override without appsecret_proof", async () => {
    const fetchImpl = vi.fn(async () => ok({ data: {} }));
    const { c } = client(fetchImpl);
    await c.get("debug_token", { input_token: "tok", access_token: "app|secret" });
    const u = new URL((fetchImpl.mock.calls[0] as any[])[0]);
    expect(u.searchParams.get("access_token")).toBe("app|secret");
    expect(u.searchParams.has("appsecret_proof")).toBe(false);
  });

  it("signs a per-call Page token with its own appsecret_proof", async () => {
    const fetchImpl = vi.fn(async () => ok({ data: [] }));
    const { c } = client(fetchImpl);
    await c.get("123_456/comments", { access_token: "page-token" });
    const u = new URL((fetchImpl.mock.calls[0] as any[])[0]);
    expect(u.searchParams.get("access_token")).toBe("page-token");
    expect(u.searchParams.get("appsecret_proof")).toBe(createHmac("sha256", "sec").update("page-token").digest("hex"));
  });

  it("handles non-JSON error bodies", async () => {
    const { c } = client(async () => new Response("<html>Bad gateway</html>", { status: 502 }), { maxRetries: 0 });
    await expect(c.get("x")).rejects.toThrow(/server error/);
  });
});
