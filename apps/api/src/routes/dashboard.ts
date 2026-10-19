import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  accountService,
  alertsService,
  assetsService,
  audiencesService,
  dashboardService,
  isoDate,
  logOrdersInput,
  orderPatchInput,
  ordersService,
  reportsService,
  settingsService,
  syncService,
  targetingService,
  webhooksService,
  addDays,
  todayIn,
  type Core,
} from "@sandalez/core";
import { handle, parseBody, requireOwner } from "../app.js";

const intQ = (def: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).default(def);

export function registerDashboardRoutes(api: FastifyInstance, core: Core) {
  const ctxOf = (email: string) => core.context(email, "dashboard");

  // ------------------------------------------------------------ overview / campaigns / ads / creatives (DB reads)
  api.get("/api/overview", async (req, reply) => {
    const q = parseBody(z.object({ days: intQ(30, 1, 365) }), req.query);
    return handle(req, reply, ctxOf(req.user!.email), () => dashboardService.overview(ctxOf(req.user!.email), q.days));
  });

  api.get("/api/campaigns", async (req, reply) => {
    const q = parseBody(z.object({ days: intQ(7, 1, 90), archived: z.enum(["0", "1"]).default("0") }), req.query);
    const ctx = ctxOf(req.user!.email);
    return handle(req, reply, ctx, () => dashboardService.campaignTreeFromDb(ctx, q.days, q.archived === "1"));
  });

  api.get<{ Params: { id: string } }>("/api/ads/:id", async (req, reply) => {
    const q = parseBody(z.object({ days: intQ(30, 1, 90) }), req.query);
    const ctx = ctxOf(req.user!.email);
    return handle(req, reply, ctx, () => dashboardService.adDetail(ctx, req.params.id, q.days));
  });

  api.get("/api/creatives", async (req, reply) => {
    const q = parseBody(z.object({ days: intQ(30, 1, 90) }), req.query);
    const ctx = ctxOf(req.user!.email);
    return handle(req, reply, ctx, () => dashboardService.creativePerformance(ctx, q.days));
  });

  // ------------------------------------------------------------ media
  api.get("/api/assets", async (req, reply) => {
    const q = parseBody(z.object({ type: z.enum(["image", "video", "all"]).default("all"), archived: z.enum(["0", "1"]).default("0") }), req.query);
    const ctx = ctxOf(req.user!.email);
    return handle(req, reply, ctx, () => assetsService.listAssets(ctx, q.type, q.archived === "1"));
  });

  api.post("/api/assets/upload", async (req, reply) => {
    if (!requireOwner(req, reply)) return;
    const body = parseBody(
      z.object({ type: z.enum(["image", "video"]), base64: z.string().optional(), url: z.string().url().optional(), name: z.string().max(200).optional() }).refine((b) => b.base64 || b.url, "Give a file or a URL"),
      req.body,
    );
    const ctx = ctxOf(req.user!.email);
    return handle(req, reply, ctx, async (): Promise<unknown> =>
      body.type === "image" ? assetsService.uploadImage(ctx, body) : assetsService.uploadVideo(ctx, body),
    );
  });

  api.post<{ Params: { ref: string } }>("/api/assets/:ref/archive", async (req, reply) => {
    if (!requireOwner(req, reply)) return;
    const body = parseBody(z.object({ archived: z.boolean().default(true) }), req.body);
    const ctx = ctxOf(req.user!.email);
    return handle(req, reply, ctx, () => assetsService.setAssetArchived(ctx, req.params.ref, body.archived));
  });

  // ------------------------------------------------------------ orders (staff allowed)
  api.get("/api/orders", async (req, reply) => {
    const q = parseBody(z.object({ since: isoDate.optional(), until: isoDate.optional(), ad_id: z.string().regex(/^\d+$/).optional(), limit: intQ(500, 1, 5000) }), req.query);
    const ctx = ctxOf(req.user!.email);
    return handle(req, reply, ctx, () => ordersService.listOrders(ctx, q));
  });

  api.post("/api/orders", async (req, reply) => {
    const body = parseBody(logOrdersInput, req.body);
    const ctx = ctxOf(req.user!.email);
    return handle(req, reply, ctx, () => ordersService.logOrders(ctx, body));
  });

  api.patch<{ Params: { id: string } }>("/api/orders/:id", async (req, reply) => {
    const body = parseBody(orderPatchInput, req.body);
    const ctx = ctxOf(req.user!.email);
    return handle(req, reply, ctx, () => ordersService.updateOrder(ctx, req.params.id, body));
  });

  api.delete<{ Params: { id: string } }>("/api/orders/:id", async (req, reply) => {
    const ctx = ctxOf(req.user!.email);
    return handle(req, reply, ctx, () => ordersService.deleteOrder(ctx, req.params.id));
  });

  api.post("/api/orders/import", async (req, reply) => {
    const body = parseBody(z.object({ csv: z.string().min(1).max(5_000_000) }), req.body);
    const ctx = ctxOf(req.user!.email);
    return handle(req, reply, ctx, () => ordersService.importOrdersCsv(ctx, body.csv));
  });

  api.get("/api/orders/summary", async (req, reply) => {
    const q = parseBody(z.object({ since: isoDate.optional(), until: isoDate.optional(), date_preset: z.string().optional(), group_by: z.enum(["total", "day", "ad"]).default("day") }), req.query);
    const ctx = ctxOf(req.user!.email);
    return handle(req, reply, ctx, () => ordersService.getCostPerOrder(ctx, { ...q, date_preset: q.date_preset as any, source: "db" }));
  });

  api.get("/api/orders/chats", async (req, reply) => {
    const q = parseBody(z.object({ since: isoDate.optional(), until: isoDate.optional() }), req.query);
    const ctx = ctxOf(req.user!.email);
    return handle(req, reply, ctx, async () => {
      // Own data includes today (unlike Meta's last_30d, which ends yesterday).
      const until = q.until ?? todayIn(core.config.DEFAULT_TIMEZONE);
      const since = q.since ?? addDays(until, -29);
      return webhooksService.chatCounts(ctx, since, until);
    });
  });

  // ------------------------------------------------------------ alerts
  api.get("/api/alerts", async (req, reply) => {
    const ctx = ctxOf(req.user!.email);
    return handle(req, reply, ctx, () => alertsService.listAlerts(ctx, { withEvents: 5 }));
  });

  api.get("/api/alerts/events", async (req, reply) => {
    const q = parseBody(z.object({ limit: intQ(50, 1, 500) }), req.query);
    const ctx = ctxOf(req.user!.email);
    return handle(req, reply, ctx, () => alertsService.recentAlertEvents(ctx, q.limit));
  });

  api.post("/api/alerts", async (req, reply) => {
    if (!requireOwner(req, reply)) return;
    const ctx = ctxOf(req.user!.email);
    return handle(req, reply, ctx, () => alertsService.setAlert(ctx, req.body as any));
  });

  api.patch<{ Params: { id: string } }>("/api/alerts/:id", async (req, reply) => {
    if (!requireOwner(req, reply)) return;
    const body = parseBody(z.object({ active: z.boolean().optional(), mute_hours: z.number().min(0).max(24 * 30).nullable().optional() }), req.body);
    const ctx = ctxOf(req.user!.email);
    return handle(req, reply, ctx, () => alertsService.updateAlert(ctx, req.params.id, body));
  });

  api.delete<{ Params: { id: string } }>("/api/alerts/:id", async (req, reply) => {
    if (!requireOwner(req, reply)) return;
    const ctx = ctxOf(req.user!.email);
    return handle(req, reply, ctx, () => alertsService.deleteAlert(ctx, req.params.id));
  });

  // ------------------------------------------------------------ activity log
  api.get("/api/activity", async (req, reply) => {
    const q = parseBody(
      z.object({ limit: intQ(50, 1, 200), before: z.string().datetime().optional(), object_id: z.string().optional(), actor: z.string().optional(), action: z.string().optional() }),
      req.query,
    );
    const ctx = ctxOf(req.user!.email);
    return handle(req, reply, ctx, () => dashboardService.activityLog(ctx, q));
  });

  // ------------------------------------------------------------ settings / sync / token
  api.get("/api/settings", async (req, reply) => {
    const ctx = ctxOf(req.user!.email);
    return handle(req, reply, ctx, async () => {
      const [settings, lastSync] = await Promise.all([settingsService.getSettings(ctx), syncService.lastSync(ctx)]);
      return {
        settings,
        api_version: core.config.META_API_VERSION,
        ad_account_id: core.config.META_AD_ACCOUNT_ID,
        page_id: core.config.META_PAGE_ID ?? null,
        whatsapp_number: core.config.WHATSAPP_PHONE_NUMBER ?? null,
        last_sync: lastSync,
        rate_limit_usage: core.meta.lastUsage ? { max_pct: core.meta.lastUsage.maxPct, at: core.meta.lastUsage.at } : null,
      };
    });
  });

  api.get("/api/settings/token", async (req, reply) => {
    const ctx = ctxOf(req.user!.email);
    return handle(req, reply, ctx, () => accountService.checkToken(ctx));
  });

  api.get("/api/account", async (req, reply) => {
    const ctx = ctxOf(req.user!.email);
    return handle(req, reply, ctx, () => accountService.getAccount(ctx));
  });

  api.put("/api/settings", async (req, reply) => {
    if (!requireOwner(req, reply)) return;
    const body = parseBody(settingsService.settingsSchema.partial(), req.body);
    const ctx = ctxOf(req.user!.email);
    return handle(req, reply, ctx, () => settingsService.updateSettings(ctx, body));
  });

  api.post("/api/sync", async (req, reply) => {
    if (!requireOwner(req, reply)) return;
    const body = parseBody(z.object({ days: z.number().int().min(1).max(90).default(7) }), req.body);
    const ctx = ctxOf(req.user!.email);
    return handle(req, reply, ctx, () => syncService.syncAll(ctx, body));
  });

  // ------------------------------------------------------------ reports
  api.get("/api/reports", async (req, reply) => {
    const ctx = ctxOf(req.user!.email);
    return handle(req, reply, ctx, () => reportsService.listReports(ctx));
  });

  // ------------------------------------------------------------ audiences
  api.get("/api/audiences", async (req, reply) => {
    const ctx = ctxOf(req.user!.email);
    return handle(req, reply, ctx, () => audiencesService.listAudiences(ctx));
  });

  // ------------------------------------------------------------ targeting search (wizard)
  api.get("/api/targeting/locations", async (req, reply) => {
    const q = parseBody(z.object({ q: z.string().min(1).max(100) }), req.query);
    const ctx = ctxOf(req.user!.email);
    return handle(req, reply, ctx, () => targetingService.searchLocations(ctx, q.q, ["city"], "PK"));
  });

  api.get("/api/targeting/interests", async (req, reply) => {
    const q = parseBody(z.object({ q: z.string().min(1).max(100) }), req.query);
    const ctx = ctxOf(req.user!.email);
    return handle(req, reply, ctx, () => targetingService.searchInterests(ctx, q.q, 20));
  });
}
