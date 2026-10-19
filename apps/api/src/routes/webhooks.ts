import type { FastifyInstance } from "fastify";
import { webhooksService, type Core } from "@sandalez/core";
import type { ApiOptions } from "../app.js";
import { safeEqual } from "../app.js";

/** Public webhooks. Each one verifies its signature before touching anything. */
export function registerWebhookRoutes(app: FastifyInstance, core: Core, opts: ApiOptions) {
  // ---- WhatsApp Cloud API: subscription verification
  app.get("/webhooks/whatsapp", async (req, reply) => {
    const q = req.query as Record<string, string>;
    if (!opts.whatsappVerifyToken) return reply.code(404).send({ error: "WhatsApp webhook not configured" });
    if (q["hub.mode"] === "subscribe" && q["hub.verify_token"] && safeEqual(q["hub.verify_token"], opts.whatsappVerifyToken)) {
      return reply.type("text/plain").send(q["hub.challenge"] ?? "");
    }
    return reply.code(403).send({ error: "Verification failed" });
  });

  // ---- WhatsApp Cloud API: messages (signed with the app secret)
  app.post("/webhooks/whatsapp", async (req, reply) => {
    const secret = core.config.META_APP_SECRET;
    if (!opts.whatsappVerifyToken || !secret) return reply.code(404).send({ error: "WhatsApp webhook not configured" });
    const sig = req.headers["x-hub-signature-256"];
    if (!webhooksService.verifyMetaSignature(req.rawBody ?? "", typeof sig === "string" ? sig : undefined, secret)) {
      req.log.warn("WhatsApp webhook with a bad signature");
      return reply.code(401).send({ error: "Bad signature" });
    }
    const ctx = core.context("whatsapp-webhook", "webhook");
    try {
      const result = await webhooksService.handleWhatsappWebhook(ctx, req.body);
      return { ok: true, recorded: result.recorded.length };
    } catch (err) {
      req.log.error({ err }, "WhatsApp webhook processing failed");
      // 200 so Meta does not retry forever; the error is logged.
      return { ok: false };
    }
  });

  // ---- Shopify orders/create -> Conversions API Purchase
  app.post("/webhooks/shopify/orders-create", async (req, reply) => {
    if (!opts.shopifySecret) return reply.code(404).send({ error: "Shopify webhook not configured" });
    const sig = req.headers["x-shopify-hmac-sha256"];
    if (!webhooksService.verifyShopifySignature(req.rawBody ?? "", typeof sig === "string" ? sig : undefined, opts.shopifySecret)) {
      req.log.warn("Shopify webhook with a bad signature");
      return reply.code(401).send({ error: "Bad signature" });
    }
    const ctx = core.context("shopify-webhook", "webhook");
    try {
      const res = await webhooksService.sendShopifyPurchase(ctx, req.body);
      return { ok: true, ...res };
    } catch (err) {
      req.log.error({ err }, "Conversions API send failed");
      return reply.code(500).send({ ok: false });
    }
  });
}
