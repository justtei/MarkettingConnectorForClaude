/**
 * Setup checker: verifies the env file, the database, the Meta token and every Meta ID,
 * SMTP and (optionally) the running services. Read-only — it never creates or changes anything.
 *
 *   pnpm setup:check                         # checks .env
 *   pnpm setup:check --env .env.production   # checks another env file
 *   pnpm setup:check --mcp https://mcp.sandalez.pk --api http://localhost:3002 --web https://ads.sandalez.pk
 *   pnpm setup:check --production            # also flags dev/mock values (localhost, test-token, example.com)
 *
 * Exit code 1 when any check fails (warnings do not fail).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.lastIndexOf(`--${name}`); // last wins, so setup:check:stack defaults can be overridden
  return i >= 0 ? args[i + 1] : undefined;
};
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envFile = resolve(root, flag("env") ?? ".env");
const production = args.includes("--production") || /production/.test(envFile);

type Status = "ok" | "warn" | "fail" | "skip";
const results: { section: string; name: string; status: Status; detail: string }[] = [];
let section = "";
const icon: Record<Status, string> = { ok: "OK  ", warn: "WARN", fail: "FAIL", skip: "SKIP" };
function report(status: Status, name: string, detail = "") {
  results.push({ section, name, status, detail });
  console.log(`  [${icon[status]}] ${name}${detail ? ` — ${detail}` : ""}`);
}
function heading(title: string) {
  section = title;
  console.log(`\n${title}`);
}
async function check(name: string, fn: () => Promise<{ status?: Status; detail?: string } | string | void>) {
  try {
    const r = await fn();
    if (typeof r === "string") report("ok", name, r);
    else report(r?.status ?? "ok", name, r?.detail ?? "");
  } catch (err) {
    report("fail", name, (err as Error).message.split("\n")[0]);
  }
}

console.log(`Sandalez Ads — setup check (${existsSync(envFile) || flag("env") ? envFile : "process environment"}${production ? ", production mode" : ""})`);

// ------------------------------------------------------------------ 1. env file
heading("1. Environment");
// Inside a container compose already injected the env file, so the process env is what gets checked.
const useProcessEnv = !flag("env") && !existsSync(envFile) && existsSync("/.dockerenv");
if (useProcessEnv) {
  report("ok", "env", "using the container's environment (docker compose env_file)");
} else if (!existsSync(envFile)) {
  report("fail", "env file", `${envFile} not found. Run: pnpm setup:env`);
  finish();
  process.exit(1);
} else {
  // Values in the file win over the shell, so the file itself is what gets checked.
  Object.assign(process.env, parseEnv(readFileSync(envFile, "utf8")));
}
// Every problem is reported below; keep the service logs out of the way unless asked for.
if (!args.includes("--verbose")) process.env.LOG_LEVEL = "silent";
const env = process.env;
const val = (k: string) => (env[k] ?? "").trim();

const required = [
  "META_ACCESS_TOKEN", "META_APP_ID", "META_APP_SECRET", "META_AD_ACCOUNT_ID", "META_PAGE_ID",
  "META_INSTAGRAM_USER_ID", "META_PIXEL_ID", "META_BUSINESS_ID", "WHATSAPP_PHONE_NUMBER",
  "DATABASE_URL", "API_INTERNAL_SECRET", "AUTH_SECRET", "OWNER_EMAIL", "OWNER_PASSWORD",
];
const productionRequired = ["POSTGRES_PASSWORD", "DOMAIN", "MCP_DOMAIN"];
const placeholder = /^(act_0+|ads\.example\.com|mcp\.example\.com)$/;
for (const k of [...required, ...(production ? productionRequired : [])]) {
  if (!val(k)) report("fail", k, "missing");
  else if (placeholder.test(val(k))) report("fail", k, "still the .env.example placeholder");
  else report("ok", k);
}
const mcpAuth = val("MCP_BEARER_TOKEN") || val("MCP_PATH_SECRET");
report(mcpAuth ? "ok" : "fail", "MCP_BEARER_TOKEN / MCP_PATH_SECRET", mcpAuth ? "" : "set at least one");
if (production && !val("MCP_PATH_SECRET")) {
  report("warn", "MCP_PATH_SECRET", "not set; claude.ai custom connectors can only send a URL, so they need it");
}

const minLen: Record<string, number> = {
  MCP_BEARER_TOKEN: 24, MCP_PATH_SECRET: 24, API_INTERNAL_SECRET: 24, AUTH_SECRET: 32, OWNER_PASSWORD: 8,
};
for (const [k, n] of Object.entries(minLen)) {
  if (val(k) && val(k).length < n) report("fail", `${k} length`, `must be at least ${n} characters`);
}
if (val("META_AD_ACCOUNT_ID") && !/^act_\d+$/.test(val("META_AD_ACCOUNT_ID"))) {
  report("fail", "META_AD_ACCOUNT_ID format", "must look like act_1234567890");
}
for (const k of ["META_APP_ID", "META_PAGE_ID", "META_INSTAGRAM_USER_ID", "META_PIXEL_ID", "META_BUSINESS_ID"]) {
  if (val(k) && !/^\d+$/.test(val(k))) report("fail", `${k} format`, "must be digits only");
}
const wa = val("WHATSAPP_PHONE_NUMBER").replace(/[^\d]/g, "");
if (wa && !/^\d{10,15}$/.test(wa)) report("fail", "WHATSAPP_PHONE_NUMBER format", "digits with country code, e.g. 923499066816");
if (val("OWNER_EMAIL") && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(val("OWNER_EMAIL"))) report("fail", "OWNER_EMAIL format", "not an email");

if (production) {
  const devValues: [string, RegExp][] = [
    ["META_ACCESS_TOKEN", /^test-token$/],
    ["META_GRAPH_BASE_URL", /localhost|127\.0\.0\.1|meta-mock/],
    ["DOMAIN", /^localhost/],
    ["MCP_DOMAIN", /^localhost/],
    ["MCP_BEARER_TOKEN", /^dev-|change-me/],
    ["API_INTERNAL_SECRET", /^dev-/],
    ["AUTH_SECRET", /^dev-/],
    ["OWNER_PASSWORD", /^sandalez-dev-pass$/],
  ];
  for (const [k, re] of devValues) if (val(k) && re.test(val(k))) report("fail", k, "still a dev/mock value");
  if (val("DOMAIN") && val("DOMAIN") === val("MCP_DOMAIN")) report("fail", "MCP_DOMAIN", "must differ from DOMAIN");
}
for (const k of ["WHATSAPP_WEBHOOK_VERIFY_TOKEN", "SHOPIFY_WEBHOOK_SECRET"]) {
  report(val(k) ? "ok" : "skip", k, val(k) ? "" : "optional webhook not configured");
}

// ------------------------------------------------------------------ 2. database
heading("2. Database");
const dbUrl = val("DATABASE_URL");
const dockerHost = /@postgres:/.test(dbUrl);
if (!dbUrl) report("skip", "connection", "DATABASE_URL missing");
else if (dockerHost && !existsSync("/.dockerenv")) {
  report("skip", "connection", "DATABASE_URL points at the compose 'postgres' host; run inside the stack: docker compose exec api pnpm setup:check --production");
} else {
  const { getDb } = await import("@sandalez/db");
  const db = getDb();
  await check("connection", async () => {
    const r = await db.$queryRawUnsafe<{ v: string }[]>("select version() as v");
    return r[0].v.split(" on ")[0];
  });
  await check("migrations applied", async () => {
    const dir = resolve(root, "packages/db/prisma/migrations");
    const expected = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    const rows = await db.$queryRawUnsafe<{ migration_name: string; finished_at: Date | null }[]>(
      'select migration_name, finished_at from "_prisma_migrations"',
    );
    const done = new Set(rows.filter((r) => r.finished_at).map((r) => r.migration_name));
    const missing = expected.filter((m) => !done.has(m));
    if (missing.length) throw new Error(`not applied: ${missing.join(", ")} (run pnpm db:deploy)`);
    return `${expected.length}/${expected.length}`;
  });
  await check("dashboard users", async () => {
    const n = await db.user.count();
    return n > 0
      ? `${n} user(s)`
      : { status: "warn", detail: "none yet; the API creates OWNER_EMAIL on its first start" };
  });
  await db.$disconnect().catch(() => {});
}

// ------------------------------------------------------------------ 3. Meta
heading("3. Meta Marketing API");
let configOk = false;
let core: import("@sandalez/core").Core | undefined;
if (!val("META_ACCESS_TOKEN")) {
  report("skip", "all Meta checks", "META_ACCESS_TOKEN is missing (see docs/meta-setup.md)");
} else try {
  const { createCore, loadConfig } = await import("@sandalez/core");
  core = createCore({ config: loadConfig(env) });
  configOk = true;
} catch (err) {
  report("fail", "config", (err as Error).message.replace(/\n/g, " "));
}
if (configOk && core) {
  const { accountService } = await import("@sandalez/core");
  const ctx = core.context("doctor", "worker");
  const cfg = core.config;
  report("ok", "API version", `${cfg.META_API_VERSION} via ${cfg.META_GRAPH_BASE_URL}`);
  if (!cfg.META_APP_SECRET) report("warn", "appsecret_proof", "META_APP_SECRET not set; calls are sent without appsecret_proof");

  let tokenOk = false;
  await check("token", async () => {
    const t = await accountService.checkToken(ctx);
    tokenOk = t.is_valid;
    if (!t.is_valid) throw new Error("token is not valid; generate a new system user token");
    const base = `${t.type ?? "token"} for app ${t.app_id ?? "?"}, expires ${t.expires_at}`;
    if (t.missing_scopes.length) throw new Error(`missing permissions: ${t.missing_scopes.join(", ")}`);
    if (t.warnings.length) return { status: "warn", detail: `${base}; ${t.warnings.join(" ")}` };
    return base;
  });
  if (tokenOk) {
    await check("ad account", async () => {
      const a = await accountService.getAccount(ctx);
      const notes: string[] = [];
      if (a.currency !== "PKR") notes.push(`currency is ${a.currency}, not PKR: budget caps are read in ${a.currency}`);
      if (a.timezone !== "Asia/Karachi") notes.push(`timezone is ${a.timezone}, not Asia/Karachi`);
      if (a.status !== "ACTIVE") throw new Error(`account status ${a.status}${a.disable_reason ? ` (${a.disable_reason})` : ""}`);
      const detail = `${a.name} (${a.id}), ${a.currency}, ${a.timezone}, ${a.status}`;
      return notes.length ? { status: "warn", detail: `${detail}; ${notes.join("; ")}` } : detail;
    });
    await check("Facebook Page", async () => {
      if (!cfg.META_PAGE_ID) throw new Error("META_PAGE_ID missing");
      const pages = await accountService.listPages(ctx);
      const page = pages.find((p) => p.is_configured_page);
      if (!page) {
        const seen = pages.map((p) => `${p.name} (${p.id})`).join(", ") || "none";
        throw new Error(`the token cannot see Page ${cfg.META_PAGE_ID}; visible: ${seen}. Assign the Page to the system user.`);
      }
      const tasks = (page.tasks as string[] | null) ?? null;
      if (tasks && !tasks.includes("ADVERTISE")) {
        return { status: "warn", detail: `${page.name}: system user lacks the ADVERTISE task (has ${tasks.join(", ")})` };
      }
      return `${page.name} (${page.id})`;
    });
    await check("Instagram account", async () => {
      if (!cfg.META_INSTAGRAM_USER_ID) return { status: "warn", detail: "META_INSTAGRAM_USER_ID missing; ads will run on Facebook only" };
      const igs = await accountService.listInstagramAccounts(ctx);
      const ig = igs.find((a) => a.is_configured);
      if (!ig) throw new Error(`not usable by the ad account; available: ${igs.map((a) => `@${a.username} (${a.id})`).join(", ") || "none"}`);
      return `@${ig.username ?? "?"} (${ig.id})`;
    });
    await check("Pixel", async () => {
      if (!cfg.META_PIXEL_ID) return { status: "warn", detail: "META_PIXEL_ID missing; sales campaigns and Conversions API are off" };
      const pixels = await accountService.listPixels(ctx);
      const px = pixels.find((p) => p.is_configured);
      if (!px) throw new Error(`not shared with the ad account; available: ${pixels.map((p) => `${p.name} (${p.id})`).join(", ") || "none"}`);
      if (px.is_unavailable) throw new Error(`${px.name} is unavailable`);
      return px.last_fired_time ? `${px.name}, last fired ${px.last_fired_time}` : { status: "warn", detail: `${px.name} has never fired; install it on the Shopify store` };
    });
    await check("Business", async () => {
      if (!cfg.META_BUSINESS_ID) return { status: "warn", detail: "META_BUSINESS_ID missing; catalog tools are off" };
      await ctx.meta.get(`${cfg.META_BUSINESS_ID}/owned_pages`, { fields: "id", limit: 1 });
      return cfg.META_BUSINESS_ID;
    });
    report(wa ? "ok" : "fail", "WhatsApp number", wa ? `wa.me/${wa}; Meta checks the Page link when the first ad is created` : "missing");
  } else {
    report("skip", "account, Page, Instagram, Pixel", "token check failed");
  }
}

// ------------------------------------------------------------------ 4. email
heading("4. Email (alerts + Monday report)");
if (!val("SMTP_HOST")) report("skip", "SMTP", "not configured; alerts stay in the dashboard, reports are saved in the DB");
else {
  await check("SMTP login", async () => {
    const { verifyEmail } = await import("@sandalez/core");
    await verifyEmail();
    return `${val("SMTP_HOST")}:${val("SMTP_PORT") || 587}`;
  });
  report(val("REPORT_EMAIL_TO") ? "ok" : "warn", "REPORT_EMAIL_TO", val("REPORT_EMAIL_TO") || "missing; nobody receives the report");
}

// ------------------------------------------------------------------ 4b. Shopify orders (optional)
heading("4b. Shopify orders (cost per order from real sales)");
if (!val("SHOPIFY_STORE_DOMAIN") && !val("SHOPIFY_ADMIN_TOKEN")) {
  report("skip", "Shopify", "not configured; orders come only from log_orders (docs/orders.md)");
} else if (!val("SHOPIFY_STORE_DOMAIN") || !val("SHOPIFY_ADMIN_TOKEN")) {
  report("fail", "Shopify", "set both SHOPIFY_STORE_DOMAIN and SHOPIFY_ADMIN_TOKEN");
} else {
  await check("Shopify Admin API", async () => {
    const domain = val("SHOPIFY_STORE_DOMAIN").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    const version = val("SHOPIFY_API_VERSION") || "2026-07";
    const r = await fetch(`${val("SHOPIFY_BASE_URL") || `https://${domain}`}/admin/api/${version}/graphql.json`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-shopify-access-token": val("SHOPIFY_ADMIN_TOKEN") },
      body: JSON.stringify({ query: "{ shop { name } orders(first: 1) { nodes { name phone } } }" }),
      signal: AbortSignal.timeout(15_000),
    });
    const body: any = await r.json().catch(() => ({}));
    if (r.status === 401 || r.status === 403) throw new Error(`the token was refused (HTTP ${r.status}); check SHOPIFY_ADMIN_TOKEN`);
    if (body.errors) {
      const msg = JSON.stringify(body.errors);
      if (/read_orders|access denied/i.test(msg)) throw new Error("the app needs the read_orders scope");
      throw new Error(msg.slice(0, 200));
    }
    const first = body.data?.orders?.nodes?.[0];
    if (first && first.phone === null) {
      return { status: "warn", detail: `${body.data.shop.name}: connected, but phone numbers are hidden. Turn on protected customer data (phone) for the app, or orders can't be linked to ads.` };
    }
    return `${body.data?.shop?.name ?? domain}: connected, orders readable`;
  });
}

// ------------------------------------------------------------------ 5. running services (optional)
const mcpUrl = flag("mcp");
const apiUrl = flag("api");
const webUrl = flag("web");
if (mcpUrl || apiUrl || webUrl) {
  heading("5. Running services");
  const get = async (url: string, init?: RequestInit) => {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
    return r;
  };
  if (apiUrl) {
    await check("API /health", async () => {
      const r = await get(`${apiUrl.replace(/\/$/, "")}/health`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return apiUrl;
    });
  }
  if (webUrl) {
    await check("dashboard", async () => {
      const r = await get(`${webUrl.replace(/\/$/, "")}/login`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return webUrl;
    });
  }
  if (mcpUrl) {
    // Accepts https://host, https://host/mcp or the full connector URL; checks run against the origin.
    const base = new URL(mcpUrl).origin;
    await check("MCP /health", async () => {
      const r = await get(`${base}/health`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return base;
    });
    await check("MCP rejects requests without a secret", async () => {
      const r = await get(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      if (r.status !== 401 && r.status !== 403 && r.status !== 404) throw new Error(`expected 401, got HTTP ${r.status}`);
      return `HTTP ${r.status}`;
    });
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
    const tryClient = async (url: string, headers?: Record<string, string>) => {
      const client = new Client({ name: "sandalez-doctor", version: "1.0.0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
      try {
        const { tools } = await client.listTools();
        const res: any = await client.callTool({ name: "check_token", arguments: {} });
        const text = res.content?.[0]?.text ?? "";
        if (res.isError) throw new Error(`check_token failed: ${text.slice(0, 200)}`);
        return `${tools.length} tools; check_token: ${/"healthy":\s*true/.test(text) ? "healthy" : "see output"}`;
      } finally {
        await client.close();
      }
    };
    if (val("MCP_BEARER_TOKEN")) {
      await check("MCP with bearer token", () => tryClient(`${base}/mcp`, { authorization: `Bearer ${val("MCP_BEARER_TOKEN")}` }));
    }
    if (val("MCP_PATH_SECRET")) {
      await check("MCP with path secret (claude.ai URL)", () => tryClient(`${base}/mcp/${val("MCP_PATH_SECRET")}`));
    }
  }
}

finish();

function finish(): void {
  const fails = results.filter((r) => r.status === "fail");
  const warns = results.filter((r) => r.status === "warn");
  console.log(`\n${fails.length ? "NOT READY" : "READY"}: ${results.filter((r) => r.status === "ok").length} ok, ${warns.length} warning(s), ${fails.length} failure(s).`);
  if (fails.length) {
    console.log("Fix:");
    for (const f of fails) console.log(`  - [${f.section}] ${f.name}${f.detail ? `: ${f.detail}` : ""}`);
  }
  // exitCode instead of process.exit(): exiting with sockets still closing aborts Node on Windows.
  process.exitCode = fails.length ? 1 : 0;
}
