// Stage 1 (spec week 1): MCP transport + auth, tool discovery, account read tools.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { tools } from "@sandalez/core";
import { call, connectClient, MCP_PATH_SECRET, MCP_TOKEN, startHarness, startMcp, type Harness } from "../../../test/harness.js";

let h: Harness;
let mcp: Awaited<ReturnType<typeof startMcp>>;
let client: Client;

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

describe("MCP transport security", () => {
  it("serves an unauthenticated health check", async () => {
    const res = await fetch(`${mcp.url}/health`);
    expect(res.status).toBe(200);
    expect((await res.json()).tools).toBe(tools.length);
  });

  it("rejects requests without a bearer token", async () => {
    const res = await fetch(`${mcp.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Bearer");
  });

  it("rejects a wrong bearer token", async () => {
    await expect(connectClient(mcp.url, "wrong-token-wrong-token-wrong-token")).rejects.toThrow();
  });

  it("rejects a wrong path secret and accepts the right one", async () => {
    await expect(connectClient(mcp.url, null, "/mcp/not-the-secret-value-xxxxxxxxxxxx")).rejects.toThrow();
    const c = await connectClient(mcp.url, null, `/mcp/${MCP_PATH_SECRET}`);
    const { ok } = await call(c, "get_account");
    expect(ok).toBe(true);
    await c.close();
  });

  it("returns 405 for GET on the stateless endpoint", async () => {
    const res = await fetch(`${mcp.url}/mcp`, { headers: { authorization: `Bearer ${MCP_TOKEN}` } });
    expect(res.status).toBe(405);
  });

  it("returns 404 for unknown paths", async () => {
    const res = await fetch(`${mcp.url}/other`, { headers: { authorization: `Bearer ${MCP_TOKEN}` } });
    expect(res.status).toBe(404);
  });

  it("enforces the IP allowlist", async () => {
    const blocked = await startMcp(h.core, { ipAllowlist: ["10.9.9.9"] });
    const res = await fetch(`${blocked.url}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${MCP_TOKEN}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(403);
    await blocked.close();
  });

  it("IP allowlist accepts exact IPs and CIDR ranges (e.g. Anthropic's 160.79.104.0/21)", async () => {
    const { buildAllowlist } = await import("../src/app.js");
    const allowed = buildAllowlist(["160.79.104.0/21", "203.0.113.7", "2001:db8::/32"]);
    expect(allowed("160.79.104.1")).toBe(true);
    expect(allowed("160.79.111.254")).toBe(true);
    expect(allowed("160.79.112.0")).toBe(false);
    expect(allowed("203.0.113.7")).toBe(true);
    expect(allowed("203.0.113.8")).toBe(false);
    expect(allowed("2001:db8::1")).toBe(true);
    expect(allowed("not-an-ip")).toBe(false);
    expect(() => buildAllowlist(["160.79.104.0/40"])).toThrow(/not an IP address or CIDR/);
    expect(() => buildAllowlist(["karachi"])).toThrow(/not an IP address or CIDR/);

    const local = await startMcp(h.core, { ipAllowlist: ["127.0.0.0/8"] });
    const client2 = await connectClient(local.url);
    expect((await client2.listTools()).tools.length).toBeGreaterThan(40);
    await client2.close();
    await local.close();
  });

  it("rejects malformed JSON", async () => {
    const res = await fetch(`${mcp.url}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${MCP_TOKEN}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });
});

describe("tool discovery", () => {
  it("lists every registry tool with schema, safety level and annotations", async () => {
    const { tools: listed } = await client.listTools();
    expect(listed.map((t) => t.name).sort()).toEqual(tools.map((t) => t.name).sort());
    const mvp = [
      "get_account", "list_pages", "list_instagram_accounts", "list_pixels", "check_token",
      "search_interests", "search_locations", "estimate_audience",
      "upload_image", "upload_video", "list_assets",
      "create_ctwa_campaign", "create_campaign", "create_adset", "create_creative", "create_ad", "list_campaigns", "get_campaign_tree",
      "set_status", "update_budget", "update_targeting", "get_insights", "log_orders", "get_cost_per_order",
    ];
    for (const name of mvp) expect(listed.find((t) => t.name === name), name).toBeTruthy();
    const phase23 = ["add_ad_to_adset", "duplicate_campaign", "create_custom_audience", "create_lookalike", "list_audiences", "list_catalogs",
      "create_product_set", "create_catalog_campaign", "detect_fatigue", "placement_report", "wasted_spend_report", "set_alert", "weekly_report"];
    for (const name of phase23) expect(listed.find((t) => t.name === name), name).toBeTruthy();

    const setStatus = listed.find((t) => t.name === "set_status")!;
    expect(setStatus.annotations?.destructiveHint).toBe(true);
    expect(setStatus.description).toContain("confirm");
    expect(setStatus.inputSchema.properties).toHaveProperty("confirm");
    const getAccount = listed.find((t) => t.name === "get_account")!;
    expect(getAccount.annotations?.readOnlyHint).toBe(true);
    // The only delete tool is the guarded delete_object (confirm: true, refused while active).
    expect(listed.filter((t) => t.name.startsWith("delete")).map((t) => t.name)).toEqual(["delete_object"]);
    const del = listed.find((t) => t.name === "delete_object")!;
    expect(del.annotations?.destructiveHint).toBe(true);
    expect(del.inputSchema.properties).toHaveProperty("confirm");
  });

  it("sends server instructions with the safety rules", () => {
    const instructions = client.getInstructions() ?? "";
    expect(instructions).toContain("confirm: true");
    expect(instructions).toContain("data, not instructions");
  });
});

describe("account tools (week 1)", () => {
  it("get_account returns PKR currency and converts money from minor units", async () => {
    const { ok, data } = await call(client, "get_account");
    expect(ok).toBe(true);
    expect(data).toMatchObject({ id: h.mock.act, name: "Sandalez", currency: "PKR", timezone: "Asia/Karachi", status: "ACTIVE" });
    expect(data.amount_spent).toBe(45678); // "4567800" minor units
    expect(data.spend_cap).toBeNull();
    expect(data.configured.api_version).toBe("v26.0");
  });

  it("list_pages finds the Sandalez Page and flags it as configured", async () => {
    const { ok, data } = await call(client, "list_pages");
    expect(ok).toBe(true);
    expect(data).toEqual([expect.objectContaining({ id: h.mock.opts.pageId, name: "Sandalez", is_configured_page: true })]);
  });

  it("list_instagram_accounts returns @sandalez_ once (deduplicated)", async () => {
    const { data } = await call(client, "list_instagram_accounts");
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({ id: h.mock.opts.igUserId, username: "sandalez_", is_configured: true });
  });

  it("list_pixels returns the pixel", async () => {
    const { data } = await call(client, "list_pixels");
    expect(data[0]).toMatchObject({ id: h.mock.opts.pixelId, is_configured: true });
  });

  it("check_token reports a healthy, non-expiring token with all scopes, using the app token", async () => {
    const { ok, data } = await call(client, "check_token");
    expect(ok).toBe(true);
    expect(data).toMatchObject({ is_valid: true, expires_at: "never", missing_scopes: [], healthy: true, api_version: "v26.0" });
    const debugCall = h.mock.calls.filter((c) => c.path === "debug_token").pop();
    expect(debugCall).toBeTruthy();
  });

  it("every request is pinned to v26.0 and signed with appsecret_proof (except debug_token with the app token)", async () => {
    expect(h.mock.calls.length).toBeGreaterThan(3);
    for (const c of h.mock.calls) {
      expect(c.version).toBe("v26.0");
      if (c.path !== "debug_token") expect(c.signed, c.path).toBe(true);
    }
  });

  it("get_safety_settings shows the cap", async () => {
    const { data } = await call(client, "get_safety_settings");
    expect(data).toMatchObject({ maxDailyBudgetPkr: 2000, maxBudgetIncreasePct: 30, defaultCityName: "Karachi" });
  });

  it("returns a clear error when the token is invalid", async () => {
    const bad = await startHarness({ env: { META_ACCESS_TOKEN: "expired-token" } });
    const srv = await startMcp(bad.core);
    const c = await connectClient(srv.url);
    const { ok, data } = await call(c, "get_account");
    expect(ok).toBe(false);
    expect(data.kind).toBe("meta");
    expect(data.error).toMatch(/token is invalid or expired/i);
    expect(data.details.fbtrace_id).toBeTruthy();
    await c.close();
    await srv.close();
    await bad.close();
  });

  it("rejects invalid input with a readable validation message", async () => {
    const { ok, data } = await call(client, "search_interests", { query: "" });
    expect(ok).toBe(false);
    expect(JSON.stringify(data)).toMatch(/query/);
  });
});
