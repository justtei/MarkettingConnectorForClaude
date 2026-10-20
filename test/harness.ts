/** Shared test harness: Meta mock + test DB + core + (optionally) the MCP HTTP server and an MCP client. */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createCore, loadConfig, type Core } from "@sandalez/core";
import { accountService } from "@sandalez/core";
import { getDb } from "@sandalez/db";
import { MetaMock } from "@sandalez/meta-mock";
import { createMcpHttpServer } from "../apps/mcp/src/app.js";

export const MCP_TOKEN = "test-mcp-bearer-token-0123456789abcdef";
export const MCP_PATH_SECRET = "test-path-secret-0123456789abcdefgh";

export async function resetDb() {
  const db = getDb();
  await db.$executeRawUnsafe(
    'TRUNCATE "AlertEvent","Alert","AuditLog","OrderLog","ShopOrder","WhatsappChat","DailyStat","Ad","Creative","AdSet","Campaign","Asset","Setting","User","Report" CASCADE',
  );
}

export interface Harness {
  mock: MetaMock;
  core: Core;
  close(): Promise<void>;
}

export async function startHarness(opts: { seed?: boolean; env?: Record<string, string> } = {}): Promise<Harness> {
  const mock = new MetaMock({ seed: opts.seed ?? true, videoReadyAfterPolls: 1 });
  const base = await mock.start();
  const config = loadConfig({
    NODE_ENV: "test",
    META_ACCESS_TOKEN: mock.opts.token,
    META_APP_ID: mock.opts.appId,
    META_APP_SECRET: mock.opts.appSecret,
    META_AD_ACCOUNT_ID: mock.act,
    META_PAGE_ID: mock.opts.pageId,
    META_INSTAGRAM_USER_ID: mock.opts.igUserId,
    META_PIXEL_ID: mock.opts.pixelId,
    META_BUSINESS_ID: mock.opts.businessId,
    WHATSAPP_PHONE_NUMBER: "923499066816",
    META_GRAPH_BASE_URL: base,
    META_RETRY_BASE_MS: "5",
    META_VIDEO_READY_TIMEOUT_MS: "20000",
    MAX_DAILY_BUDGET_PKR: "2000",
    MAX_BUDGET_INCREASE_PCT: "30",
    ...opts.env,
  });
  accountService.clearCurrencyCache();
  await resetDb();
  const core = createCore({ config, meta: { sleep: async () => {} } });
  return {
    mock,
    core,
    async close() {
      await mock.stop();
    },
  };
}

export async function startMcp(core: Core, extra: { ipAllowlist?: string[] } = {}) {
  const server: Server = createMcpHttpServer(core, { bearerToken: MCP_TOKEN, pathSecret: MCP_PATH_SECRET, ...extra });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    server,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

export async function connectClient(url: string, token: string | null = MCP_TOKEN, path = "/mcp") {
  const client = new Client({ name: "sandalez-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${url}${path}`), {
    requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
  });
  await client.connect(transport);
  return client;
}

/** Calls a tool and returns { ok, data } with the JSON body parsed. */
export async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = (await client.callTool({ name, arguments: args })) as { content: { type: string; text: string }[]; isError?: boolean };
  const text = res.content?.[0]?.text ?? "null";
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { ok: !res.isError, data };
}
