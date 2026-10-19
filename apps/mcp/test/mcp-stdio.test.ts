// The local stdio transport (Claude Desktop / Claude Code on the same machine) works end to end.
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MetaMock } from "@sandalez/meta-mock";

let mock: MetaMock;
let client: Client;

beforeAll(async () => {
  mock = new MetaMock();
  const base = await mock.start();
  const cwd = fileURLToPath(new URL("..", import.meta.url));
  client = new Client({ name: "stdio-test", version: "1" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "src/stdio.ts"],
      cwd,
      env: {
        ...(process.env as Record<string, string>),
        META_ACCESS_TOKEN: mock.opts.token,
        META_APP_ID: mock.opts.appId,
        META_APP_SECRET: mock.opts.appSecret,
        META_AD_ACCOUNT_ID: mock.act,
        META_PAGE_ID: mock.opts.pageId,
        META_GRAPH_BASE_URL: base,
        LOG_LEVEL: "info",
      },
      stderr: "pipe",
    }),
  );
}, 60_000);

afterAll(async () => {
  await client?.close();
  await mock?.stop();
});

it("lists tools and runs one over stdio (logs stay on stderr)", async () => {
  const { tools } = await client.listTools();
  expect(tools.length).toBeGreaterThan(40);
  const r = (await client.callTool({ name: "get_account", arguments: {} })) as any;
  expect(r.isError).toBeFalsy();
  expect(JSON.parse(r.content[0].text).currency).toBe("PKR");
});
