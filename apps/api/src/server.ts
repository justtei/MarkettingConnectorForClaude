import { createCore, logger } from "@sandalez/core";
import { buildApi } from "./app.js";
import { bootstrapOwner } from "./routes/auth.js";

const core = createCore();
const app = buildApi(core, {
  internalSecret: process.env.API_INTERNAL_SECRET ?? "",
  whatsappVerifyToken: process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN?.trim() || undefined,
  shopifySecret: process.env.SHOPIFY_WEBHOOK_SECRET?.trim() || undefined,
});

const created = await bootstrapOwner(core, process.env.OWNER_EMAIL?.trim(), process.env.OWNER_PASSWORD);
if (created) logger.info({ email: created }, "Created the first owner user from OWNER_EMAIL");

const port = Number(process.env.API_PORT ?? 3002);
// LISTEN_HOST=127.0.0.1 on a bare Windows/Linux install keeps it off the local network; Docker needs 0.0.0.0.
await app.listen({ port, host: process.env.LISTEN_HOST?.trim() || "0.0.0.0" });

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    void app.close().then(() => core.db.$disconnect()).finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
