/**
 * A stateful, in-memory fake of the Meta Graph / Marketing API endpoints used by Sandalez Ads Tool.
 * Used by the test suite and for running the whole stack locally without a real ad account.
 *
 * Control endpoints (not part of Meta):
 *   POST /__mock/reset                 reset state
 *   GET  /__mock/state                 dump objects
 *   POST /__mock/fail  {method?, path, times?, status?, error}   make the next matching call(s) fail
 *   POST /__mock/usage {pct, regain_minutes?}                    set rate-limit header usage
 *   GET  /__mock/media/sample.jpg|sample.mp4                     sample media for upload-by-URL tests
 */
import { createHash, randomInt } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { addDays, eachDay, resolveRange, todayIn } from "@sandalez/core/dates";

export interface MockOptions {
  token?: string;
  appId?: string;
  appSecret?: string;
  accountId?: string; // digits only
  pageId?: string;
  igUserId?: string;
  pixelId?: string;
  businessId?: string;
  /** Video polls before status becomes ready. */
  videoReadyAfterPolls?: number;
  /** Seed an existing, active campaign with 30 days of history. */
  seed?: boolean;
  log?: boolean;
}

type Obj = Record<string, any> & { id: string; _type: string };

interface Failure {
  method?: string;
  path: RegExp;
  times: number;
  status: number;
  error: Record<string, unknown>;
}

const KARACHI = { key: "2211096", name: "Karachi", type: "city", country_code: "PK", country_name: "Pakistan", region: "Sindh", region_id: 3354, supports_city: true, supports_region: true };
const LAHORE = { key: "2211241", name: "Lahore", type: "city", country_code: "PK", country_name: "Pakistan", region: "Punjab", region_id: 3353, supports_city: true, supports_region: true };
const ISLAMABAD = { key: "2210961", name: "Islamabad", type: "city", country_code: "PK", country_name: "Pakistan", region: "Islamabad Capital Territory", region_id: 3351, supports_city: true, supports_region: true };
const KARACHI_SUB = { key: "1018923", name: "Karachi Cantonment", type: "subcity", country_code: "PK", country_name: "Pakistan", region: "Sindh" };

const INTERESTS = [
  { id: "6003107902433", name: "Shoes", audience_size_lower_bound: 410000000, audience_size_upper_bound: 482000000, path: ["Shopping and fashion", "Clothing", "Shoes"], topic: "Shopping and fashion" },
  { id: "6003346592981", name: "Sandal", audience_size_lower_bound: 21000000, audience_size_upper_bound: 24700000, path: ["Shopping and fashion", "Shoes", "Sandal"], topic: "Shopping and fashion" },
  { id: "6003409392877", name: "Wedding", audience_size_lower_bound: 590000000, audience_size_upper_bound: 694000000, path: ["Family and relationships", "Wedding"], topic: "Family and relationships" },
  { id: "6003456388203", name: "Fashion accessories", audience_size_lower_bound: 300000000, audience_size_upper_bound: 352000000, path: ["Shopping and fashion", "Fashion accessories"], topic: "Shopping and fashion" },
  { id: "6002839660079", name: "Online shopping", audience_size_lower_bound: 900000000, audience_size_upper_bound: 1100000000, path: ["Shopping and fashion", "Shopping", "Online shopping"], topic: "Shopping and fashion" },
];

const OBJECTIVES = new Set(["OUTCOME_ENGAGEMENT", "OUTCOME_TRAFFIC", "OUTCOME_SALES", "OUTCOME_LEADS", "OUTCOME_AWARENESS", "OUTCOME_APP_PROMOTION"]);
const STATUSES = new Set(["ACTIVE", "PAUSED", "ARCHIVED", "DELETED"]);
const DESTINATIONS = new Set([
  "WHATSAPP",
  "INSTAGRAM_DIRECT",
  "MESSENGER",
  "MESSAGING_INSTAGRAM_DIRECT_WHATSAPP",
  "MESSAGING_MESSENGER_WHATSAPP",
  "MESSAGING_INSTAGRAM_DIRECT_MESSENGER",
  "MESSAGING_INSTAGRAM_DIRECT_MESSENGER_WHATSAPP",
  "WEBSITE",
  "ON_AD",
  "UNDEFINED",
]);
const MESSAGING_APPS = ["WHATSAPP", "INSTAGRAM_DIRECT", "MESSENGER"];
/** Fields that exist only on some node types (others answer "(#100) Tried accessing nonexisting field"). */
const TYPE_ONLY_FIELDS: Record<string, string[]> = {
  adset_id: ["ad"],
  campaign_id: ["ad", "adset"],
  objective: ["campaign"],
  object_type: ["adcreative"],
  subtype: ["customaudience"],
};
/** Button type -> the app_destination Meta requires with it. */
const CTA_APP: Record<string, string> = { WHATSAPP_MESSAGE: "WHATSAPP", INSTAGRAM_MESSAGE: "INSTAGRAM_DIRECT", MESSAGE_PAGE: "MESSENGER" };

function appsForDestination(d: unknown): string[] {
  const s = String(d ?? "");
  if (MESSAGING_APPS.includes(s)) return [s];
  return s.startsWith("MESSAGING_") ? MESSAGING_APPS.filter((a) => s.includes(a)) : [];
}

function creativeApps(cr: Record<string, any>): string[] {
  const oss = cr.object_story_spec ?? {};
  const ctas = [...(cr.asset_feed_spec?.call_to_actions ?? []), oss.link_data?.call_to_action, oss.video_data?.call_to_action, cr.call_to_action];
  const apps = new Set<string>();
  for (const c of ctas) if (c?.value?.app_destination && MESSAGING_APPS.includes(c.value.app_destination)) apps.add(c.value.app_destination);
  return [...apps];
}
const MIN_DAILY_BUDGET_MINOR = 10_000; // PKR 100 in the mock

// A 1x1 JPEG.
const SAMPLE_JPG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=",
  "base64",
);

export class MetaMock {
  readonly opts: Required<MockOptions>;
  private server: Server | null = null;
  baseUrl = "";
  objects = new Map<string, Obj>();
  images = new Map<string, Obj>();
  failures: Failure[] = [];
  usagePct = 5;
  regainMinutes = 0;
  calls: { method: string; path: string; version: string; signed: boolean; params: Record<string, any> }[] = [];
  pixelEvents: any[] = [];
  private nextId = 120210000000000;

  constructor(options: MockOptions = {}) {
    this.opts = {
      token: options.token ?? "test-token",
      appId: options.appId ?? "1111111111",
      appSecret: options.appSecret ?? "test-app-secret",
      accountId: options.accountId ?? "1234567890",
      pageId: options.pageId ?? "100200300400500",
      igUserId: options.igUserId ?? "17841400000000000",
      pixelId: options.pixelId ?? "555666777888999",
      businessId: options.businessId ?? "999888777666555",
      videoReadyAfterPolls: options.videoReadyAfterPolls ?? 1,
      seed: options.seed ?? true,
      log: options.log ?? false,
    };
    this.reset();
  }

  get act(): string {
    return `act_${this.opts.accountId}`;
  }

  reset(): void {
    this.objects.clear();
    this.images.clear();
    this.failures = [];
    this.calls = [];
    this.pixelEvents = [];
    this.usagePct = 5;
    this.regainMinutes = 0;
    this.nextId = 120210000000000;
    const o = this.opts;
    this.put({ id: this.act, _type: "adaccount", account_id: o.accountId, name: "Sandalez", currency: "PKR", timezone_name: "Asia/Karachi", account_status: 1, amount_spent: "4567800", spend_cap: "0", balance: "0", business_name: "Sandalez" });
    this.put({ id: o.pageId, _type: "page", name: "Sandalez", category: "Shoe Store", link: "https://facebook.com/sandalez", instagram_business_account: { id: o.igUserId, username: "sandalez_" }, tasks: ["ADVERTISE", "ANALYZE", "CREATE_CONTENT", "MANAGE"] });
    this.put({ id: o.igUserId, _type: "instagram", username: "sandalez_" });
    this.put({ id: o.pixelId, _type: "pixel", name: "Sandalez Pixel", last_fired_time: new Date().toISOString(), is_unavailable: false, creation_time: "2024-01-01T00:00:00+0000" });
    this.put({ id: "888777666555444", _type: "catalog", name: "Sandalez Shopify", product_count: 86, vertical: "commerce", business: o.businessId });
    this.put({ id: "777666555444333", _type: "productset", name: "All products", product_count: 86, catalog_id: "888777666555444", filter: null });
    if (o.seed) this.seedHistory();
  }

  private seedHistory(): void {
    const today = todayIn("Asia/Karachi");
    const created = `${addDays(today, -30)}T10:00:00+0500`;
    const c = this.create("campaign", { name: "SZ-KHI-Existing-WA", objective: "OUTCOME_ENGAGEMENT", status: "ACTIVE", special_ad_categories: [], buying_type: "AUCTION", created_time: created });
    const s = this.create("adset", {
      name: "SZ-KHI-Women-20-40", campaign_id: c.id, status: "ACTIVE", daily_budget: "60000", billing_event: "IMPRESSIONS",
      optimization_goal: "CONVERSATIONS", bid_strategy: "LOWEST_COST_WITHOUT_CAP", destination_type: "WHATSAPP",
      promoted_object: { page_id: this.opts.pageId, whatsapp_phone_number: "923499066816" },
      targeting: { geo_locations: { cities: [{ key: KARACHI.key, name: "Karachi" }], location_types: ["home", "recent"] }, age_min: 20, age_max: 40, genders: [2] },
      created_time: created,
    });
    const names = [["A1-Wedding-Pearl", "video", "normal"], ["A2-Everyday-Flats", "image", "fatigued"], ["A3-Kolhapuri", "image", "wasted"]];
    for (const [name, kind, profile] of names) {
      const cr = this.create("adcreative", {
        name, object_story_spec: kind === "video"
          ? { page_id: this.opts.pageId, video_data: { video_id: "1500000000001", title: "Shaadi-ready pearl flats", message: "Pearl flats ab 30% OFF." } }
          : { page_id: this.opts.pageId, link_data: { image_hash: "seedhash" + name, name, message: "COD + easy exchange.", link: "https://api.whatsapp.com/send" } },
        thumbnail_url: "https://example.com/thumb.jpg",
      });
      this.create("ad", { name, adset_id: s.id, campaign_id: c.id, status: "ACTIVE", creative: { id: cr.id }, created_time: created, _profile: profile, _video: kind === "video" });
    }
  }

  private genId(): string {
    return String(this.nextId++);
  }

  private put(o: Obj): Obj {
    this.objects.set(o.id, o);
    return o;
  }

  create(type: string, fields: Record<string, any>): Obj {
    const id = this.genId();
    const o: Obj = { id, _type: type, account_id: this.opts.accountId, created_time: new Date().toISOString(), ...fields };
    if (["campaign", "adset", "ad"].includes(type)) o.effective_status = o.status;
    return this.put(o);
  }

  // ------------------------------------------------------------------ server

  async start(port = 0, host = "127.0.0.1", publicUrl?: string): Promise<string> {
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        this.send(res, 500, { error: { message: String(err?.stack ?? err), type: "MockError", code: 1 } });
      });
    });
    await new Promise<void>((r) => this.server!.listen(port, host, r));
    const addr = this.server.address() as AddressInfo;
    // URLs the mock hands out (thumbnails, image URLs) must be reachable by the API container.
    this.baseUrl = publicUrl?.replace(/\/+$/, "") ?? `http://127.0.0.1:${addr.port}`;
    return this.baseUrl;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((r) => this.server!.close(() => r()));
    this.server = null;
  }

  private send(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
    const usage = { [this.opts.accountId]: [{ type: "ads_management", call_count: this.usagePct, total_cputime: Math.max(1, this.usagePct - 2), total_time: Math.max(1, this.usagePct - 1), estimated_time_to_regain_access: this.regainMinutes }] };
    res.writeHead(status, {
      "content-type": "application/json",
      "x-business-use-case-usage": JSON.stringify(usage),
      "x-app-usage": JSON.stringify({ call_count: 1, total_cputime: 1, total_time: 1 }),
      ...extraHeaders,
    });
    res.end(JSON.stringify(body));
  }

  private err(res: ServerResponse, status: number, message: string, code = 100, subcode?: number, extra: Record<string, unknown> = {}): void {
    this.send(res, status, { error: { message, type: "OAuthException", code, ...(subcode ? { error_subcode: subcode } : {}), fbtrace_id: `MOCK${randomInt(1e9)}`, ...extra } });
  }

  private async readBody(req: IncomingMessage): Promise<{ params: Record<string, any>; raw: Buffer }> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks);
    const type = req.headers["content-type"] ?? "";
    const params: Record<string, any> = {};
    if (type.startsWith("application/x-www-form-urlencoded")) {
      for (const [k, v] of new URLSearchParams(raw.toString("utf8"))) params[k] = v;
    } else if (type.startsWith("multipart/form-data")) {
      const form = await new Response(raw, { headers: { "content-type": type } }).formData();
      for (const [k, v] of form.entries()) params[k] = typeof v === "string" ? v : { file: true, name: (v as File).name, size: (v as File).size };
    } else if (type.startsWith("application/json") && raw.length) {
      Object.assign(params, JSON.parse(raw.toString("utf8")));
    }
    return { params, raw };
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", this.baseUrl || "http://localhost");
    const method = (req.method ?? "GET").toUpperCase();

    // ---- control + media endpoints
    if (url.pathname.startsWith("/__mock/")) return this.control(url, method, req, res);

    const m = /^\/(v\d+\.\d+)\/(.*)$/.exec(url.pathname);
    if (!m) return this.err(res, 400, "Unknown path (missing API version)", 2635);
    const path = m[2]!.replace(/\/+$/, "");
    const body = method === "GET" || method === "DELETE" ? { params: {}, raw: Buffer.alloc(0) } : await this.readBody(req);
    const params: Record<string, any> = { ...Object.fromEntries(url.searchParams), ...body.params };
    for (const [k, v] of Object.entries(params)) {
      if (typeof v === "string" && /^[[{]/.test(v.trim())) {
        try {
          params[k] = JSON.parse(v);
        } catch {
          /* leave as string */
        }
      }
    }
    this.calls.push({ method, path, version: m[1]!, signed: Boolean(params.appsecret_proof), params: { ...params, access_token: undefined, appsecret_proof: undefined, bytes: params.bytes ? `[${String(params.bytes).length}]` : undefined } });
    if (this.opts.log) console.log(method, path);

    // ---- injected failures
    const f = this.failures.find((x) => (!x.method || x.method === method) && x.path.test(path));
    if (f) {
      f.times--;
      if (f.times <= 0) this.failures.splice(this.failures.indexOf(f), 1);
      return this.send(res, f.status, { error: { fbtrace_id: "MOCKFAIL", ...f.error } });
    }

    // ---- auth
    const token = params.access_token;
    const appToken = `${this.opts.appId}|${this.opts.appSecret}`;
    if (!token) return this.err(res, 400, "An access token is required to request this resource.", 104);
    if (token !== this.opts.token && !(path === "debug_token" && token === appToken)) {
      return this.err(res, 400, "Invalid OAuth access token - Cannot parse access token", 190);
    }
    if (params.appsecret_proof) {
      const expected = (await import("node:crypto")).createHmac("sha256", this.opts.appSecret).update(this.opts.token).digest("hex");
      if (params.appsecret_proof !== expected) return this.err(res, 400, "Invalid appsecret_proof provided in the API argument", 100);
    }

    const parts = path.split("/");
    try {
      if (method === "GET") return this.get(parts, params, url, res);
      if (method === "POST") return this.post(parts, params, res);
      if (method === "DELETE") return this.del(parts, res);
    } catch (e) {
      if (e instanceof MockHttpError) return this.err(res, e.status, e.message, e.code, e.subcode, e.extra);
      throw e;
    }
    return this.err(res, 400, "Unsupported method");
  }

  private async control(url: URL, method: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const p = url.pathname;
    if (p === "/__mock/media/sample.jpg") {
      res.writeHead(200, { "content-type": "image/jpeg" });
      res.end(SAMPLE_JPG);
      return;
    }
    if (p === "/__mock/media/sample.mp4") {
      res.writeHead(200, { "content-type": "video/mp4" });
      res.end(Buffer.alloc(1024, 1));
      return;
    }
    if (p === "/__mock/media/not-image.txt") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("hello");
      return;
    }
    if (p === "/__mock/reset" && method === "POST") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }
    if (p === "/__mock/state") {
      return this.send(res, 200, { objects: [...this.objects.values()], images: [...this.images.values()], calls: this.calls.length });
    }
    if (p === "/__mock/fail" && method === "POST") {
      const { params } = await this.readBody(req);
      this.failures.push({ method: params.method, path: new RegExp(params.path), times: Number(params.times ?? 1), status: Number(params.status ?? 400), error: params.error ?? { message: "Injected failure", code: 100 } });
      return this.send(res, 200, { ok: true });
    }
    if (p === "/__mock/usage" && method === "POST") {
      const { params } = await this.readBody(req);
      this.usagePct = Number(params.pct ?? 5);
      this.regainMinutes = Number(params.regain_minutes ?? 0);
      return this.send(res, 200, { ok: true });
    }
    return this.err(res, 404, "Unknown mock control endpoint");
  }

  /** Programmatic failure injection for in-process tests. */
  failNext(path: RegExp | string, opts: { method?: string; times?: number; status?: number; error?: Record<string, unknown> } = {}): void {
    this.failures.push({
      method: opts.method,
      path: typeof path === "string" ? new RegExp(path) : path,
      times: opts.times ?? 1,
      status: opts.status ?? 400,
      error: opts.error ?? { message: "Injected failure", code: 100, type: "OAuthException" },
    });
  }

  // ------------------------------------------------------------------ helpers

  private requireObj(id: string, type?: string | string[]): Obj {
    const o = this.objects.get(id);
    const types = type ? (Array.isArray(type) ? type : [type]) : null;
    if (!o || o.status === "DELETED" || (types && !types.includes(o._type))) {
      throw new MockHttpError(400, `Unsupported get request. Object with ID '${id}' does not exist, cannot be loaded due to missing permissions, or does not support this operation.`, 100, 33);
    }
    return o;
  }

  private publicView(o: Obj, fieldsParam?: string): Record<string, any> {
    const out: Record<string, any> = {};
    const fields = fieldsParam ? splitFields(fieldsParam) : null;
    for (const [k, v] of Object.entries(o)) {
      if (k.startsWith("_")) continue;
      out[k] = v;
    }
    if (o._type === "ad" && o.creative?.id) {
      const cr = this.objects.get(o.creative.id);
      if (cr) out.creative = this.publicView(cr);
    }
    if (o._type === "advideo") {
      o._polls = (o._polls ?? 0) + 1;
      out.status = { video_status: o._polls > this.opts.videoReadyAfterPolls ? "ready" : "processing", processing_progress: o._polls > this.opts.videoReadyAfterPolls ? 100 : 50 };
    }
    if (!fields) return out;
    const picked: Record<string, any> = { id: out.id };
    for (const f of fields) {
      const name = f.replace(/\{.*$/, "");
      if (name in out) picked[name] = out[name];
    }
    return picked;
  }

  private page(res: ServerResponse, items: any[], params: Record<string, any>, url: URL) {
    const limit = Math.max(1, Math.min(Number(params.limit ?? 25), 500));
    const start = params.after ? Number(Buffer.from(String(params.after), "base64").toString()) : 0;
    const data = items.slice(start, start + limit);
    const next = start + limit < items.length ? Buffer.from(String(start + limit)).toString("base64") : null;
    const paging: any = { cursors: { before: Buffer.from(String(start)).toString("base64"), after: next ?? undefined } };
    if (next) {
      const u = new URL(url.toString());
      u.searchParams.set("after", next);
      u.searchParams.set("limit", String(limit));
      paging.next = u.toString();
    }
    return this.send(res, 200, { data, paging });
  }

  private children(type: string, filter: (o: Obj) => boolean, params: Record<string, any>): Obj[] {
    let list = [...this.objects.values()].filter((o) => o._type === type && o.status !== "DELETED" && filter(o));
    const eff = params.effective_status;
    if (Array.isArray(eff)) list = list.filter((o) => eff.includes(this.effectiveStatus(o)));
    return list.sort((a, b) => (a.created_time < b.created_time ? 1 : -1));
  }

  effectiveStatus(o: Obj): string {
    if (o.status !== "ACTIVE") return o.status;
    if (o._type === "adset") {
      const c = this.objects.get(o.campaign_id);
      if (c && c.status === "PAUSED") return "CAMPAIGN_PAUSED";
    }
    if (o._type === "ad") {
      const s = this.objects.get(o.adset_id);
      const c = this.objects.get(o.campaign_id);
      if (c && c.status === "PAUSED") return "CAMPAIGN_PAUSED";
      if (s && s.status === "PAUSED") return "ADSET_PAUSED";
      if (o._pendingReview) return "PENDING_REVIEW";
    }
    return "ACTIVE";
  }

  private withEffective(o: Obj): Obj {
    if (["campaign", "adset", "ad"].includes(o._type)) o.effective_status = this.effectiveStatus(o);
    return o;
  }

  // ------------------------------------------------------------------ GET

  private get(parts: string[], params: Record<string, any>, url: URL, res: ServerResponse) {
    const [id, edge] = parts;
    if (id === "me" && edge === "accounts") {
      const pages = [...this.objects.values()].filter((o) => o._type === "page").map((p) => this.publicView(p, params.fields));
      return this.page(res, pages, params, url);
    }
    if (id === "debug_token") {
      const valid = params.input_token === this.opts.token;
      return this.send(res, 200, {
        data: {
          app_id: this.opts.appId, type: "SYSTEM_USER", application: "Sandalez Ads Tool", data_access_expires_at: 0, expires_at: 0,
          is_valid: valid, scopes: valid ? ["ads_management", "ads_read", "business_management", "pages_show_list", "pages_read_engagement", "pages_manage_ads", "catalog_management"] : [], user_id: "61550000000000",
        },
      });
    }
    if (id === "search") return this.search(params, res);
    if (!id) return this.err(res, 400, "Missing ID");

    if (id === this.act) {
      const acc = this.objects.get(this.act)!;
      if (!edge) return this.send(res, 200, this.publicView(acc, params.fields));
      switch (edge) {
        case "campaigns":
          return this.page(res, this.children("campaign", () => true, params).map((o) => this.publicView(this.withEffective(o), params.fields)), params, url);
        case "adsets":
          return this.page(res, this.children("adset", () => true, params).map((o) => this.publicView(this.withEffective(o), params.fields)), params, url);
        case "ads":
          return this.page(res, this.children("ad", () => true, params).map((o) => this.publicView(this.withEffective(o), params.fields)), params, url);
        case "adcreatives":
          return this.page(res, this.children("adcreative", () => true, params).map((o) => this.publicView(o, params.fields)), params, url);
        case "adimages":
          return this.page(res, [...this.images.values()].map((i) => ({ ...i })), params, url);
        case "advideos":
          return this.page(res, this.children("advideo", () => true, params).map((o) => this.publicView(o, params.fields)), params, url);
        case "instagram_accounts":
          return this.page(res, [{ id: this.opts.igUserId, username: "sandalez_" }], params, url);
        case "adspixels":
          return this.page(res, [...this.objects.values()].filter((o) => o._type === "pixel").map((p) => this.publicView(p, params.fields)), params, url);
        case "customaudiences":
          return this.page(res, this.children("customaudience", () => true, params).map((o) => this.publicView(o, params.fields)), params, url);
        case "reachestimate": {
          const t = params.targeting_spec;
          if (!t?.geo_locations) return this.err(res, 400, "Invalid targeting spec: location required", 100, 1487756);
          const base = t.genders?.length === 1 ? 2_400_000 : 4_100_000;
          const ageFactor = ((t.age_max ?? 65) - (t.age_min ?? 18)) / 47;
          const n = Math.round(base * Math.max(0.1, ageFactor));
          return this.send(res, 200, { data: { users_lower_bound: Math.round(n * 0.85), users_upper_bound: n, estimate_ready: true } });
        }
        case "delivery_estimate":
          return this.send(res, 200, { data: [{ estimate_mau_lower_bound: 1000000, estimate_mau_upper_bound: 1200000, estimate_ready: true }] });
        case "insights":
          return this.insights(this.act, params, res, url);
      }
      return this.err(res, 400, `Unknown edge ${edge}`);
    }

    if (id === this.opts.businessId && edge === "owned_product_catalogs") {
      return this.page(res, [...this.objects.values()].filter((o) => o._type === "catalog").map((o) => this.publicView(o, params.fields)), params, url);
    }
    if (id === this.opts.businessId && edge === "owned_pages") {
      return this.page(res, [...this.objects.values()].filter((o) => o._type === "page").map((o) => this.publicView(o, params.fields)), params, url);
    }

    const obj = this.requireObj(id);
    if (!edge) {
      const view = this.publicView(this.withEffective(obj), params.fields);
      if (params.fields && splitFields(params.fields).includes("account_id") && obj.account_id) view.account_id = obj.account_id;
      // Like the live v26 API: no `metadata` on these nodes, and asking for a field the node type doesn't have is an error.
      const wanted = params.fields ? splitFields(params.fields) : [];
      for (const [field, types] of Object.entries(TYPE_ONLY_FIELDS)) {
        if (wanted.includes(field) && !types.includes(obj._type)) {
          return this.err(res, 400, `(#100) Tried accessing nonexisting field (${field}) on node type (${obj._type})`, 100);
        }
      }
      return this.send(res, 200, view);
    }
    switch (edge) {
      case "adsets":
        return this.page(res, this.children("adset", (o) => o.campaign_id === id, params).map((o) => this.publicView(this.withEffective(o), params.fields)), params, url);
      case "ads":
        return this.page(res, this.children("ad", (o) => o.campaign_id === id || o.adset_id === id, params).map((o) => this.publicView(this.withEffective(o), params.fields)), params, url);
      case "insights":
        return this.insights(id, params, res, url);
      case "thumbnails":
        return this.send(res, 200, { data: [{ id: "t1", uri: `${this.baseUrl}/__mock/media/sample.jpg`, is_preferred: true, width: 1, height: 1 }] });
      case "previews":
        return this.send(res, 200, { data: [{ body: `<iframe src="https://www.facebook.com/ads/api/preview_iframe.php?d=mock&creative=${id}" width="335" height="450"></iframe>` }] });
      case "product_sets":
        return this.page(res, [...this.objects.values()].filter((o) => o._type === "productset" && o.catalog_id === id).map((o) => this.publicView(o, params.fields)), params, url);
    }
    return this.err(res, 400, `Unknown edge ${edge}`);
  }

  private search(params: Record<string, any>, res: ServerResponse) {
    const q = String(params.q ?? "").toLowerCase();
    if (params.type === "adinterest") {
      const hits = INTERESTS.filter((i) => i.name.toLowerCase().includes(q) || i.path.some((p) => p.toLowerCase().includes(q)));
      return this.send(res, 200, { data: hits.slice(0, Number(params.limit ?? 25)) });
    }
    if (params.type === "adgeolocation") {
      const types: string[] = Array.isArray(params.location_types) ? params.location_types : ["city"];
      const all = [KARACHI, LAHORE, ISLAMABAD, KARACHI_SUB];
      const hits = all.filter(
        (l) => l.name.toLowerCase().includes(q) && types.includes(l.type) && (!params.country_code || l.country_code === params.country_code),
      );
      return this.send(res, 200, { data: hits });
    }
    return this.err(res, 400, "Unsupported search type");
  }

  // ------------------------------------------------------------------ POST

  private post(parts: string[], p: Record<string, any>, res: ServerResponse) {
    const [id, edge] = parts;
    if (!id) return this.err(res, 400, "Missing ID");

    if (id === this.act) {
      switch (edge) {
        case "campaigns": {
          if (!p.name) return this.err(res, 400, "(#100) The parameter name is required");
          if (!OBJECTIVES.has(p.objective)) return this.err(res, 400, "(#100) Param objective must be one of {...}", 100, 1885316);
          if (p.special_ad_categories === undefined) return this.err(res, 400, "(#100) The parameter special_ad_categories is required");
          if (!p.daily_budget && p.is_adset_budget_sharing_enabled === undefined) {
            return this.err(res, 400, "Must specify True or False in is_adset_budget_sharing_enabled field", 100, 4834011);
          }
          const c = this.create("campaign", pick(p, ["name", "objective", "status", "special_ad_categories", "buying_type", "daily_budget", "bid_strategy", "promoted_object", "is_adset_budget_sharing_enabled"]));
          c.status = p.status ?? "ACTIVE";
          return this.send(res, 200, { id: c.id });
        }
        case "adsets": {
          const campaign = this.requireObj(String(p.campaign_id), "campaign");
          if (!p.name) return this.err(res, 400, "(#100) The parameter name is required");
          if (!p.targeting?.geo_locations) return this.err(res, 400, "Location targeting is required", 100, 1487756, { error_user_title: "Missing location", error_user_msg: "Your audience needs a location." });
          if (campaign.daily_budget && p.daily_budget) return this.err(res, 400, "Cannot set ad set budget when campaign budget is used", 100, 1885621);
          if (!campaign.daily_budget && !p.daily_budget && !p.lifetime_budget) return this.err(res, 400, "Budget is required", 100, 1885272);
          if (p.daily_budget && Number(p.daily_budget) < MIN_DAILY_BUDGET_MINOR) {
            return this.err(res, 400, "Budget is too low", 100, 1487007, { error_user_msg: "The minimum daily budget is PKR 100.00" });
          }
          const apps = appsForDestination(p.destination_type);
          if (p.destination_type && !DESTINATIONS.has(p.destination_type)) return this.err(res, 400, `Invalid destination_type ${p.destination_type}`, 100);
          if (apps.length) {
            if (!p.promoted_object?.page_id) return this.err(res, 400, "promoted_object with page_id is required", 100, 2446289);
            if (apps.includes("WHATSAPP") && !p.promoted_object?.whatsapp_phone_number) return this.err(res, 400, "promoted_object with page_id and whatsapp_phone_number is required", 100, 2446289);
            if (campaign.objective !== "OUTCOME_ENGAGEMENT" && campaign.objective !== "OUTCOME_SALES" && campaign.objective !== "OUTCOME_TRAFFIC") return this.err(res, 400, "Objective incompatible with messaging destination");
            if (apps.length > 1 && p.optimization_goal !== "CONVERSATIONS") return this.err(res, 400, "Multi-destination ad sets must optimize for CONVERSATIONS");
          }
          const t = p.targeting;
          // v26.0: ad sets must state the Advantage+ audience flag (Meta requires it for some setups; the mock always does).
          if (t.targeting_automation?.advantage_audience !== 0 && t.targeting_automation?.advantage_audience !== 1) {
            return this.err(res, 400, "ADS_TARGETING__REQUIRE_EXPLICIT_ADVANTAGE_AUDIENCE_FLAG: set targeting_automation.advantage_audience", 100, 3858504);
          }
          if (t.targeting_automation?.advantage_audience === 1 && t.age_min > 25) {
            // Meta: with Advantage+ audience, age_min may not be above 25.
            return this.err(res, 400, "Advantage+ audience: age_min must be 25 or lower", 100, 1870227);
          }
          const s = this.create("adset", { ...pick(p, ["name", "campaign_id", "daily_budget", "lifetime_budget", "billing_event", "optimization_goal", "bid_strategy", "bid_amount", "destination_type", "promoted_object", "targeting", "start_time", "end_time", "is_dynamic_creative"]), status: p.status ?? "ACTIVE" });
          return this.send(res, 200, { id: s.id });
        }
        case "adcreatives": {
          if (!p.name) return this.err(res, 400, "(#100) name is required");
          const oss = p.object_story_spec;
          if (oss) {
            if (oss.page_id !== this.opts.pageId) return this.err(res, 400, "Invalid page_id", 100, 1487472);
            const ld = oss.link_data;
            const vd = oss.video_data;
            if (ld && !ld.child_attachments && !ld.image_hash && !ld.picture) return this.err(res, 400, "link_data requires image_hash");
            if (ld?.image_hash && !this.images.has(ld.image_hash)) return this.err(res, 400, `Image with hash ${ld.image_hash} not found`, 100, 1487242);
            if (vd) {
              const v = this.objects.get(String(vd.video_id));
              if (!v || v._type !== "advideo") return this.err(res, 400, "Video not found", 100, 1487101);
              if (!vd.image_hash && !vd.image_url) return this.err(res, 400, "video_data requires a thumbnail (image_hash or image_url)", 100, 1443226);
            }
            const welcome = (ld ?? vd)?.page_welcome_message;
            if (welcome !== undefined) {
              // Meta's current guide nests it as an object; the older string form is still accepted.
              try {
                const w = typeof welcome === "string" ? JSON.parse(welcome) : welcome;
                if (w?.type !== "VISUAL_EDITOR" || w.version !== 2 || !w.text_format?.message?.text) throw new Error("shape");
              } catch {
                return this.err(res, 400, "Invalid page_welcome_message");
              }
            }
            const cta = (ld ?? vd)?.call_to_action;
            if (cta?.type === "WHATSAPP_MESSAGE" && cta.value?.app_destination !== "WHATSAPP") return this.err(res, 400, "WHATSAPP_MESSAGE requires app_destination WHATSAPP");
            for (const c of [cta, ...(p.asset_feed_spec?.call_to_actions ?? [])]) {
              const want = c && CTA_APP[c.type];
              if (want && c.value?.app_destination !== want) return this.err(res, 400, `${c.type} requires app_destination ${want}`);
            }
          } else if (!p.source_instagram_media_id && !p.object_id) {
            return this.err(res, 400, "object_story_spec is required");
          }
          if (p.degrees_of_freedom_spec?.creative_features_spec?.standard_enhancements) {
            return this.err(res, 400, "Invalid parameter", 100, 3858504, {
              error_user_title: "Creative should not include standard enhancements",
              error_user_msg: "Including standard enhancements field in creative has been deprecated. Please choose to set individual features instead.",
            });
          }
          const afs = p.asset_feed_spec;
          if (afs?.optimization_type === "DOF_MESSAGING_DESTINATION" && !(afs.call_to_actions?.length >= 2)) {
            return this.err(res, 400, "call_to_actions with at least two destinations is required for DOF_MESSAGING_DESTINATION");
          }
          const cr = this.create("adcreative", { ...pick(p, ["name", "object_story_spec", "asset_feed_spec", "degrees_of_freedom_spec", "object_id", "instagram_user_id", "source_instagram_media_id", "call_to_action", "product_set_id", "url_tags"]), thumbnail_url: `${this.baseUrl}/__mock/media/sample.jpg` });
          return this.send(res, 200, { id: cr.id });
        }
        case "ads": {
          const s = this.requireObj(String(p.adset_id), "adset");
          const crId = p.creative?.creative_id;
          if (!crId) return this.err(res, 400, "creative is required");
          const cr = this.requireObj(String(crId), "adcreative");
          const want = appsForDestination(s.destination_type);
          const have = creativeApps(cr);
          if (want.length && have.length && (want.length !== have.length || want.some((a) => !have.includes(a)))) {
            return this.err(res, 400, "Invalid parameter", 100, 2490279, {
              error_user_title: "Inconsistent campaign destination type with app destination",
              error_user_msg: "The campaign destination type must be consistent with app destination in call to action",
            });
          }
          const ad = this.create("ad", { name: p.name, adset_id: s.id, campaign_id: s.campaign_id, status: p.status ?? "ACTIVE", creative: { id: crId } });
          return this.send(res, 200, { id: ad.id });
        }
        case "adimages": {
          let bytes: Buffer;
          if (p.bytes) bytes = Buffer.from(String(p.bytes), "base64");
          else return this.err(res, 400, "bytes or filename required");
          if (bytes.length === 0) return this.err(res, 400, "Image data is empty", 100, 1487242);
          const hash = createHash("md5").update(bytes).digest("hex");
          const name = String(p.name ?? "image.jpg");
          this.images.set(hash, { id: `${this.opts.accountId}:${hash}`, _type: "adimage", hash, name, url: `${this.baseUrl}/__mock/media/sample.jpg`, width: 1080, height: 1080, created_time: new Date().toISOString(), status: "ACTIVE" });
          return this.send(res, 200, { images: { [name]: { hash, url: `${this.baseUrl}/__mock/media/sample.jpg` } } });
        }
        case "advideos": {
          if (!p.file_url && !p.source) return this.err(res, 400, "file_url or source required");
          const v = this.create("advideo", { title: p.name ?? p.title ?? "video", picture: `${this.baseUrl}/__mock/media/sample.jpg`, length: 15, _polls: 0 });
          return this.send(res, 200, { id: v.id });
        }
        case "customaudiences": {
          if (!p.name) return this.err(res, 400, "name required");
          if (p.subtype === "LOOKALIKE") {
            const origin = this.objects.get(String(p.origin_audience_id));
            if (!origin || origin._type !== "customaudience") return this.err(res, 400, "Origin audience not found", 100, 1713007);
          }
          const a = this.create("customaudience", { ...pick(p, ["name", "subtype", "description", "rule", "lookalike_spec", "origin_audience_id", "customer_file_source"]), subtype: p.subtype ?? "WEBSITE", approximate_count_lower_bound: 1000, approximate_count_upper_bound: 1200, operation_status: { code: 200, description: "Normal" }, delivery_status: { code: 200, description: "Ready" }, time_created: Math.floor(Date.now() / 1000) });
          return this.send(res, 200, { id: a.id });
        }
      }
      return this.err(res, 400, `Unknown edge ${edge}`);
    }

    const obj = this.requireObj(id);
    if (!edge) {
      if (p.status !== undefined && !STATUSES.has(p.status)) return this.err(res, 400, "Invalid status");
      if (obj.status === "ARCHIVED" && p.status === "ACTIVE") return this.err(res, 400, "Archived objects cannot be activated", 100, 1815694);
      if (p.daily_budget !== undefined && Number(p.daily_budget) < MIN_DAILY_BUDGET_MINOR) return this.err(res, 400, "Budget is too low", 100, 1487007);
      if (p.targeting !== undefined && !p.targeting?.geo_locations) return this.err(res, 400, "Location targeting is required", 100, 1487756);
      for (const k of ["status", "daily_budget", "targeting", "name"]) if (p[k] !== undefined) obj[k] = p[k];
      if (obj._type === "ad" && p.status === "ACTIVE") obj._pendingReview = false;
      return this.send(res, 200, { success: true });
    }
    switch (edge) {
      case "copies": {
        if (obj._type !== "campaign") return this.err(res, 400, "Only campaigns can be copied here");
        if (p.deep_copy) {
          for (const a of this.children("ad", (o) => o.campaign_id === obj.id, {})) {
            const cr = this.objects.get(String(a.creative?.id));
            if (cr?.degrees_of_freedom_spec?.creative_features_spec?.standard_enhancements) {
              return this.err(res, 400, "Invalid parameter", 100, 3858504, {
                error_user_title: "Creative should not include standard enhancements",
                error_user_msg: "Including standard enhancements field in creative has been deprecated. Please choose to set individual features instead.",
              });
            }
          }
        }
        const suffix = p.rename_options?.rename_suffix ?? " - Copy";
        const status = p.status_option === "PAUSED" ? "PAUSED" : obj.status;
        const nc = this.create("campaign", { ...strip(obj), name: `${obj.name}${suffix}`, status });
        const ids: any[] = [];
        if (p.deep_copy) {
          for (const s of this.children("adset", (o) => o.campaign_id === obj.id, {})) {
            const ns = this.create("adset", { ...strip(s), campaign_id: nc.id, name: `${s.name}${suffix}`, status });
            ids.push({ ad_object_type: "ad_set", source_id: s.id, copied_id: ns.id });
            for (const a of this.children("ad", (o) => o.adset_id === s.id, {})) {
              const na = this.create("ad", { ...strip(a), adset_id: ns.id, campaign_id: nc.id, name: `${a.name}${suffix}`, status });
              ids.push({ ad_object_type: "ad", source_id: a.id, copied_id: na.id });
            }
          }
        }
        return this.send(res, 200, { copied_campaign_id: nc.id, ad_object_ids: [{ ad_object_type: "campaign", source_id: obj.id, copied_id: nc.id }, ...ids] });
      }
      case "users": {
        const data = p.payload?.data ?? [];
        return this.send(res, 200, { audience_id: id, session_id: String(Date.now()), num_received: data.length, num_invalid_entries: 0, invalid_entry_samples: {} });
      }
      case "product_sets": {
        if (obj._type !== "catalog") return this.err(res, 400, "Not a catalog");
        const ps = this.create("productset", { name: p.name, filter: p.filter ?? null, catalog_id: id, product_count: 20 });
        return this.send(res, 200, { id: ps.id });
      }
      case "events": {
        if (obj._type !== "pixel") return this.err(res, 400, "Not a pixel");
        const events = Array.isArray(p.data) ? p.data : [];
        this.pixelEvents.push(...events);
        return this.send(res, 200, { events_received: events.length, messages: [], fbtrace_id: "MOCKCAPI" });
      }
    }
    return this.err(res, 400, `Unknown edge ${edge}`);
  }

  private del(parts: string[], res: ServerResponse) {
    const [id] = parts;
    const obj = this.requireObj(String(id));
    obj.status = "DELETED";
    return this.send(res, 200, { success: true });
  }

  // ------------------------------------------------------------------ insights

  /** Deterministic synthetic daily stats per ad. */
  dailyStats(ad: Obj, date: string) {
    const created = String(ad.created_time).slice(0, 10);
    if (date < created) return null;
    const seed = parseInt(createHash("md5").update(`${ad.id}|${date}`).digest("hex").slice(0, 8), 16);
    const rnd = (k: number) => ((seed >> k) & 0xff) / 255;
    const today = todayIn("Asia/Karachi");
    const daysAgo = Math.round((Date.parse(today) - Date.parse(date)) / 86_400_000);
    let impressions = Math.round(1500 + rnd(0) * 1500);
    let ctr = 0.012 + rnd(8) * 0.01;
    let convRate = 0.25 + rnd(16) * 0.2;
    const cpm = 180 + rnd(4) * 120;
    let reachDiv = 1.2 + rnd(12) * 0.2;
    if (ad._profile === "fatigued") {
      if (daysAgo <= 3) {
        ctr *= 0.45;
        convRate *= 0.6;
      }
      reachDiv = 4.2;
    }
    if (ad._profile === "wasted") convRate = 0;
    if (date === today) impressions = Math.round(impressions * 0.4);
    const clicks = Math.round(impressions * ctr);
    const spend = Math.round(((impressions * cpm) / 1000) * 100) / 100;
    const conversations = Math.round(clicks * convRate);
    const reach = Math.round(impressions / reachDiv);
    const linkClicks = Math.round(clicks * 0.8);
    const video = ad._video ? { p25: Math.round(impressions * 0.3), p50: Math.round(impressions * 0.18), p75: Math.round(impressions * 0.1), p100: Math.round(impressions * 0.06), plays: Math.round(impressions * 0.5) } : null;
    return { spend, impressions, clicks, conversations, reach, linkClicks, video };
  }

  private insights(objectId: string, params: Record<string, any>, res: ServerResponse, url: URL) {
    const level: string = params.level ?? "account";
    const range = params.time_range ? { since: params.time_range.since, until: params.time_range.until } : resolveRange({ date_preset: params.date_preset ?? "last_30d" });
    const obj = objectId === this.act ? null : this.requireObj(objectId, ["campaign", "adset", "ad"]);
    const rank: Record<string, number> = { account: 0, campaign: 1, adset: 2, ad: 3 };
    if (obj && rank[level]! < rank[obj._type]!) {
      return this.err(res, 400, `(#100) level ${level} is not valid for a ${obj._type}`);
    }
    const ads = [...this.objects.values()].filter(
      (o) => o._type === "ad" && o.status !== "DELETED" && (!obj || o.id === obj.id || o.adset_id === obj.id || o.campaign_id === obj.id),
    );
    const breakdowns: string[] = params.breakdowns ? String(params.breakdowns).split(",") : [];
    const inc = params.time_increment;
    const days = eachDay(range.since, range.until);
    const buckets = new Map<string, any>();
    const shares = breakdownShares(breakdowns);

    for (const ad of ads) {
      for (const d of days) {
        const s = this.dailyStats(ad, d);
        if (!s || s.impressions === 0) continue;
        for (const sh of shares) {
          const period = String(inc) === "1" ? d : "all";
          const ent = level === "account" ? this.act : level === "campaign" ? ad.campaign_id : level === "adset" ? ad.adset_id : ad.id;
          const key = `${ent}|${period}|${JSON.stringify(sh.values)}`;
          const b = buckets.get(key) ?? { ent, ad, period, values: sh.values, spend: 0, impressions: 0, clicks: 0, conversations: 0, reach: 0, link: 0, p25: 0, p50: 0, p75: 0, p100: 0, plays: 0, video: false };
          const f = sh.factor(s);
          b.spend += s.spend * f.spend;
          b.impressions += Math.round(s.impressions * f.impr);
          b.clicks += Math.round(s.clicks * f.impr);
          b.conversations += Math.round(s.conversations * f.conv);
          b.reach += Math.round(s.reach * f.impr);
          b.link += Math.round(s.linkClicks * f.impr);
          if (s.video) {
            b.video = true;
            b.p25 += Math.round(s.video.p25 * f.impr);
            b.p50 += Math.round(s.video.p50 * f.impr);
            b.p75 += Math.round(s.video.p75 * f.impr);
            b.p100 += Math.round(s.video.p100 * f.impr);
            b.plays += Math.round(s.video.plays * f.impr);
          }
          buckets.set(key, b);
        }
      }
    }
    const rows = [...buckets.values()].map((b) => {
      const camp = this.objects.get(b.ad.campaign_id);
      const set = this.objects.get(b.ad.adset_id);
      const spend = Math.round(b.spend * 100) / 100;
      const row: Record<string, any> = {
        date_start: b.period === "all" ? range.since : b.period,
        date_stop: b.period === "all" ? range.until : b.period,
        spend: spend.toFixed(2),
        impressions: String(b.impressions),
        reach: String(b.reach),
        frequency: b.reach ? (b.impressions / b.reach).toFixed(6) : "0",
        clicks: String(b.clicks),
        inline_link_clicks: String(b.link),
        ctr: b.impressions ? ((b.clicks / b.impressions) * 100).toFixed(6) : "0",
        cpm: b.impressions ? ((spend / b.impressions) * 1000).toFixed(6) : "0",
        cpc: b.clicks ? (spend / b.clicks).toFixed(6) : "0",
        actions: [
          { action_type: "link_click", value: String(b.link) },
          ...(b.conversations ? [{ action_type: "onsite_conversion.messaging_conversation_started_7d", value: String(b.conversations) }] : []),
        ],
        cost_per_action_type: b.conversations ? [{ action_type: "onsite_conversion.messaging_conversation_started_7d", value: (spend / b.conversations).toFixed(6) }] : [],
      };
      if (b.video) {
        row.video_p25_watched_actions = [{ action_type: "video_view", value: String(b.p25) }];
        row.video_p50_watched_actions = [{ action_type: "video_view", value: String(b.p50) }];
        row.video_p75_watched_actions = [{ action_type: "video_view", value: String(b.p75) }];
        row.video_p100_watched_actions = [{ action_type: "video_view", value: String(b.p100) }];
        row.video_play_actions = [{ action_type: "video_view", value: String(b.plays) }];
      }
      if (level === "account") Object.assign(row, { account_id: this.opts.accountId, account_name: "Sandalez" });
      if (level !== "account") Object.assign(row, { campaign_id: camp?.id, campaign_name: camp?.name });
      if (level === "adset" || level === "ad") Object.assign(row, { adset_id: set?.id, adset_name: set?.name });
      if (level === "ad") Object.assign(row, { ad_id: b.ad.id, ad_name: b.ad.name });
      Object.assign(row, b.values);
      return row;
    });
    rows.sort((a, b) => (a.date_start < b.date_start ? -1 : a.date_start > b.date_start ? 1 : 0));
    return this.page(res, rows, params, url);
  }
}

class MockHttpError extends Error {
  constructor(public status: number, message: string, public code = 100, public subcode?: number, public extra: Record<string, unknown> = {}) {
    super(message);
  }
}

function splitFields(f: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of f) {
    if (ch === "{") depth++;
    if (ch === "}") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function pick(o: Record<string, any>, keys: string[]): Record<string, any> {
  const out: Record<string, any> = {};
  for (const k of keys) if (o[k] !== undefined) out[k] = o[k];
  return out;
}

function strip(o: Obj): Record<string, any> {
  const { id: _id, created_time: _c, effective_status: _e, ...rest } = o;
  return rest;
}

interface Share {
  values: Record<string, string>;
  factor: (s: { spend: number }) => { spend: number; impr: number; conv: number };
}

/** Fixed audience/placement splits so breakdowns add up to the totals. */
function breakdownShares(breakdowns: string[]): Share[] {
  let shares: Share[] = [{ values: {}, factor: () => ({ spend: 1, impr: 1, conv: 1 }) }];
  const cross = (dim: { values: Record<string, string>; share: number; conv?: number }[]) => {
    const next: Share[] = [];
    for (const s of shares) {
      for (const d of dim) {
        next.push({
          values: { ...s.values, ...d.values },
          factor: (x) => {
            const f = s.factor(x);
            return { spend: f.spend * d.share, impr: f.impr * d.share, conv: f.conv * d.share * (d.conv ?? 1) };
          },
        });
      }
    }
    shares = next;
  };
  if (breakdowns.includes("age")) cross([{ values: { age: "18-24" }, share: 0.3 }, { values: { age: "25-34" }, share: 0.45, conv: 1.2 }, { values: { age: "35-44" }, share: 0.25, conv: 0.6 }]);
  if (breakdowns.includes("gender")) cross([{ values: { gender: "female" }, share: 0.8, conv: 1.1 }, { values: { gender: "male" }, share: 0.2, conv: 0.6 }]);
  if (breakdowns.includes("region")) cross([{ values: { region: "Sindh" }, share: 1 }]);
  if (breakdowns.includes("device_platform")) cross([{ values: { device_platform: "mobile_app" }, share: 0.95 }, { values: { device_platform: "desktop" }, share: 0.05 }]);
  if (breakdowns.includes("publisher_platform") || breakdowns.includes("platform_position")) {
    cross([
      { values: { publisher_platform: "facebook", platform_position: "feed" }, share: 0.3, conv: 1.1 },
      { values: { publisher_platform: "instagram", platform_position: "feed" }, share: 0.25, conv: 1.2 },
      { values: { publisher_platform: "instagram", platform_position: "instagram_stories" }, share: 0.2, conv: 1.0 },
      { values: { publisher_platform: "instagram", platform_position: "instagram_reels" }, share: 0.15, conv: 1.3 },
      { values: { publisher_platform: "facebook", platform_position: "marketplace" }, share: 0.1, conv: 0 },
    ]);
    shares = shares.map((s) => ({
      ...s,
      values: Object.fromEntries(Object.entries(s.values).filter(([k]) => breakdowns.includes(k) || !["publisher_platform", "platform_position"].includes(k))),
    }));
  }
  return shares;
}
