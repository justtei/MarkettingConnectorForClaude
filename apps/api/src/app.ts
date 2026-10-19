import { timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import {
  formatZodError,
  logger,
  runAction,
  runTool,
  toolMap,
  tools,
  type Core,
  type CoreContext,
  type ToolDef,
  type ToolOutcome,
} from "@sandalez/core";
import { registerDashboardRoutes } from "./routes/dashboard.js";
import { registerWebhookRoutes } from "./routes/webhooks.js";
import { registerAuthRoutes } from "./routes/auth.js";

export type Role = "owner" | "staff";

export interface ApiUser {
  email: string;
  role: Role;
}

declare module "fastify" {
  interface FastifyRequest {
    user?: ApiUser;
    rawBody?: string;
  }
}

export interface ApiOptions {
  internalSecret: string;
  whatsappVerifyToken?: string;
  shopifySecret?: string;
  bodyLimit?: number;
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

const STATUS_FOR: Record<Exclude<ToolOutcome, { ok: true }>["kind"], number> = {
  validation: 400,
  input: 400,
  guard: 409,
  meta: 502,
  not_found: 404,
  internal: 500,
};

/** Sends a tool outcome as an HTTP response. */
export function sendOutcome(reply: FastifyReply, outcome: ToolOutcome) {
  if (outcome.ok) return reply.send(outcome.result);
  return reply.code(STATUS_FOR[outcome.kind]).send({ error: outcome.error, kind: outcome.kind, rule: outcome.rule, details: outcome.details });
}

/** Runs a handler and converts thrown errors into the same shape as tool errors. */
export async function handle<T>(req: FastifyRequest, reply: FastifyReply, ctx: CoreContext, fn: () => Promise<T>) {
  return sendOutcome(reply, await runAction(ctx, `${req.method} ${req.routeOptions.url}`, fn));
}

export function parseBody<S extends z.ZodTypeAny>(schema: S, body: unknown): z.output<S> {
  const r = schema.safeParse(body ?? {});
  if (!r.success) throw Object.assign(new Error(`Invalid input — ${formatZodError(r.error)}`), { statusCode: 400 });
  return r.data;
}

export function buildApi(core: Core, opts: ApiOptions): FastifyInstance {
  if (!opts.internalSecret || opts.internalSecret.length < 24) {
    throw new Error("API_INTERNAL_SECRET must be set (at least 24 characters).");
  }
  const app = Fastify({ loggerInstance: logger.child({ component: "api" }) as unknown as FastifyBaseLogger, bodyLimit: opts.bodyLimit ?? 60 * 1024 * 1024, trustProxy: true });

  // Keep the raw body for webhook signature checks.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    req.rawBody = body as string;
    if (!body) return done(null, {});
    try {
      done(null, JSON.parse(body as string));
    } catch {
      done(Object.assign(new Error("Invalid JSON body"), { statusCode: 400 }), undefined);
    }
  });

  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    const status = err.statusCode ?? 500;
    if (status >= 500) req.log.error({ err }, "API error");
    reply.code(status).send({ error: status >= 500 ? "Internal server error" : err.message });
  });

  app.get("/health", async () => ({ ok: true, service: "sandalez-api" }));

  // Public, signature-checked webhooks.
  registerWebhookRoutes(app, core, opts);

  // Everything under /api requires the internal secret (only the dashboard server knows it).
  app.register(async (api) => {
    api.addHook("onRequest", async (req, reply) => {
      const secret = req.headers["x-internal-secret"];
      if (typeof secret !== "string" || !safeEqual(secret, opts.internalSecret)) {
        return reply.code(401).send({ error: "Unauthorized" });
      }
      if (req.url.startsWith("/api/auth/")) return;
      const email = req.headers["x-user-email"];
      const role = req.headers["x-user-role"];
      if (typeof email !== "string" || !email || (role !== "owner" && role !== "staff")) {
        return reply.code(401).send({ error: "Missing user" });
      }
      req.user = { email: email.toLowerCase(), role };
    });

    registerAuthRoutes(api, core);
    registerDashboardRoutes(api, core);

    api.get("/api/me", async (req) => req.user);

    api.get("/api/tools", async (req) =>
      tools
        .filter((t) => req.user!.role === "owner" || (t as ToolDef).staffAllowed)
        .map((t) => ({ name: t.name, title: t.title, description: t.description, level: t.level, group: t.group, phase: t.phase })),
    );

    // Every Meta action from the dashboard goes through the same tool registry and guards as MCP.
    api.post<{ Params: { name: string } }>("/api/tools/:name", async (req, reply) => {
      const def = toolMap.get(req.params.name) as ToolDef | undefined;
      if (!def) return reply.code(404).send({ error: `Unknown tool "${req.params.name}"` });
      if (req.user!.role !== "owner" && !def.staffAllowed) {
        return reply.code(403).send({ error: "Only the owner can do this." });
      }
      const ctx = core.context(req.user!.email, "dashboard");
      return sendOutcome(reply, await runTool(ctx, def.name, req.body ?? {}));
    });
  });

  return app;
}

export function requireOwner(req: FastifyRequest, reply: FastifyReply): boolean {
  if (req.user?.role !== "owner") {
    void reply.code(403).send({ error: "Only the owner can do this." });
    return false;
  }
  return true;
}

export { logger };
