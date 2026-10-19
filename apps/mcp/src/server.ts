import { createCore, logger } from "@sandalez/core";
import { createMcpHttpServer } from "./app.js";

const core = createCore();
const port = Number(process.env.MCP_PORT ?? 3001);
const server = createMcpHttpServer(core, {
  bearerToken: process.env.MCP_BEARER_TOKEN?.trim() || undefined,
  pathSecret: process.env.MCP_PATH_SECRET?.trim() || undefined,
  ipAllowlist: (process.env.MCP_IP_ALLOWLIST ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  trustProxy: process.env.TRUST_PROXY !== "false",
});

server.listen(port, "0.0.0.0", () => {
  logger.info({ port, account: core.config.META_AD_ACCOUNT_ID, apiVersion: core.config.META_API_VERSION }, "Sandalez MCP server listening on /mcp");
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    logger.info({ sig }, "Shutting down MCP server");
    server.close(() => void core.db.$disconnect().finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
