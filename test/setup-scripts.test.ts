/** pnpm setup:env and pnpm setup:check, run as the user runs them (child processes). */
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MCP_PATH_SECRET, MCP_TOKEN, startHarness, startMcp, type Harness } from "./harness.js";

const run = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const dir = mkdtempSync(join(tmpdir(), "sz-setup-"));

// Async (not execFileSync): the MCP server these scripts call runs in this same process.
async function script(name: string, args: string[]) {
  try {
    const r = await run(process.execPath, ["--import", "tsx", join(root, "scripts", name), ...args], {
      cwd: root,
      env: { ...process.env, LOG_LEVEL: "silent" },
      timeout: 60_000,
    });
    return { code: 0, out: r.stdout };
  } catch (err: any) {
    return { code: err.code as number, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

function parse(text: string) {
  return Object.fromEntries([...text.matchAll(/^([A-Z0-9_]+)=(.*)$/gm)].map(([, k, v]) => [k, v]));
}

describe("setup:env", () => {
  const out = join(dir, "prod.env");

  it("generates every internal secret, never prints them, and lists what is left", async () => {
    const r = await script("setup-env.mts", ["--out", out, "--owner-email", "owner@sandalez.pk", "--domain", "ads.sandalez.pk"]);
    expect(r.code).toBe(0);
    const env = parse(readFileSync(out, "utf8"));
    expect(env.MCP_BEARER_TOKEN).toMatch(/^[0-9a-f]{64}$/);
    expect(env.MCP_PATH_SECRET).toMatch(/^[0-9a-f]{48}$/);
    expect(env.API_INTERNAL_SECRET).toMatch(/^[0-9a-f]{64}$/);
    expect(env.AUTH_SECRET).toMatch(/^[0-9a-f]{64}$/);
    expect(env.POSTGRES_PASSWORD).toMatch(/^[0-9a-f]{48}$/);
    expect(env.OWNER_PASSWORD).toHaveLength(16);
    expect(env.OWNER_EMAIL).toBe("owner@sandalez.pk");
    expect(env.DOMAIN).toBe("ads.sandalez.pk");
    expect(env.DATABASE_URL).toBe(`postgresql://sandalez:${env.POSTGRES_PASSWORD}@postgres:5432/sandalez?schema=public`);
    for (const k of ["MCP_BEARER_TOKEN", "AUTH_SECRET", "OWNER_PASSWORD", "POSTGRES_PASSWORD"]) expect(r.out).not.toContain(env[k]);
    expect(r.out).toMatch(/still to fill \(required\): META_ACCESS_TOKEN.*MCP_DOMAIN/);
    expect(r.out).not.toMatch(/required\):.*DOMAIN, MCP/);
  });

  it("is safe to re-run: keeps existing values, fills only what is empty", async () => {
    const before = readFileSync(out, "utf8");
    writeFileSync(out, before.replace(/^META_PAGE_ID=.*$/m, "META_PAGE_ID=100200300400500").replace(/^SMTP_PASS=.*$/m, "SMTP_PASS="));
    const r = await script("setup-env.mts", ["--out", out]);
    expect(r.code).toBe(0);
    const a = parse(before);
    const b = parse(readFileSync(out, "utf8"));
    for (const k of ["MCP_BEARER_TOKEN", "AUTH_SECRET", "OWNER_PASSWORD", "POSTGRES_PASSWORD", "DATABASE_URL"]) expect(b[k]).toBe(a[k]);
    expect(b.META_PAGE_ID).toBe("100200300400500");
    expect(r.out).toContain("generated/set: nothing");
  });

  it("--local fills the localhost addresses the laptop compose file needs", async () => {
    const file = join(dir, "local.env");
    const r = await script("setup-env.mts", ["--local", "--out", file, "--owner-email", "owner@sandalez.pk"]);
    expect(r.code).toBe(0);
    const env = parse(readFileSync(file, "utf8"));
    expect(env.DOMAIN).toBe("localhost:3000");
    expect(env.MCP_DOMAIN).toBe("localhost:3001");
    expect(env.MCP_BEARER_TOKEN).toMatch(/^[0-9a-f]{64}$/);
    expect(r.out).toMatch(/still to fill \(required\): META_ACCESS_TOKEN/);
    expect(r.out).not.toMatch(/required\):.*(DOMAIN|CLOUDFLARE_TUNNEL_TOKEN)/);
  });
});

describe("setup:check", () => {
  let h: Harness;
  let mcp: Awaited<ReturnType<typeof startMcp>>;
  let good: string;

  beforeAll(async () => {
    h = await startHarness();
    mcp = await startMcp(h.core);
    const c = h.core.config;
    good = join(dir, "good.env");
    writeFileSync(
      good,
      [
        `META_ACCESS_TOKEN=${c.META_ACCESS_TOKEN}`, `META_APP_ID=${c.META_APP_ID}`, `META_APP_SECRET=${c.META_APP_SECRET}`,
        `META_AD_ACCOUNT_ID=${c.META_AD_ACCOUNT_ID}`, `META_PAGE_ID=${c.META_PAGE_ID}`, `META_INSTAGRAM_USER_ID=${c.META_INSTAGRAM_USER_ID}`,
        `META_PIXEL_ID=${c.META_PIXEL_ID}`, `META_BUSINESS_ID=${c.META_BUSINESS_ID}`, "WHATSAPP_PHONE_NUMBER=923499066816",
        `META_GRAPH_BASE_URL=${c.META_GRAPH_BASE_URL}`, `DATABASE_URL=${process.env.DATABASE_URL}`,
        `MCP_BEARER_TOKEN=${MCP_TOKEN}`, `MCP_PATH_SECRET=${MCP_PATH_SECRET}`,
        "API_INTERNAL_SECRET=test-internal-secret-0123456789abcdef", "AUTH_SECRET=test-auth-secret-0123456789abcdef0123456789",
        "OWNER_EMAIL=owner@sandalez.pk", "OWNER_PASSWORD=long-enough-pass",
      ].join("\n"),
    );
  });
  afterAll(async () => {
    await mcp?.close();
    await h?.close();
  });

  it("READY when the env, database, every Meta ID and the MCP server (both auth modes) check out", async () => {
    const r = await script("setup-check.mts", ["--env", good, "--mcp", `${mcp.url}/mcp`]);
    expect(r.out).toContain("[OK  ] token — SYSTEM_USER");
    expect(r.out).toContain("[OK  ] ad account — Sandalez (act_1234567890), PKR, Asia/Karachi, ACTIVE");
    expect(r.out).toContain("[OK  ] Facebook Page");
    expect(r.out).toContain("[OK  ] Instagram account — @sandalez_");
    expect(r.out).toContain("[OK  ] migrations applied");
    expect(r.out).toContain("[OK  ] MCP rejects requests without a secret — HTTP 401");
    expect(r.out).toMatch(/\[OK  \] MCP with bearer token — \d+ tools; check_token: healthy/);
    expect(r.out).toMatch(/\[OK  \] MCP with path secret .* check_token: healthy/);
    expect(r.out).toMatch(/READY: \d+ ok/);
    expect(r.code).toBe(0);
  });

  it("names the exact problem: invalid token, wrong Page/pixel IDs, short secrets", async () => {
    const bad = join(dir, "bad.env");
    const text = readFileSync(good, "utf8");
    writeFileSync(bad, text.replace(/^META_ACCESS_TOKEN=.*$/m, "META_ACCESS_TOKEN=revoked"));
    let r = await script("setup-check.mts", ["--env", bad]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("[FAIL] token — token is not valid");

    writeFileSync(bad, text.replace(/^META_PAGE_ID=.*$/m, "META_PAGE_ID=999").replace(/^META_PIXEL_ID=.*$/m, "META_PIXEL_ID=888").replace(/^AUTH_SECRET=.*$/m, "AUTH_SECRET=short"));
    r = await script("setup-check.mts", ["--env", bad]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/\[FAIL\] Facebook Page — the token cannot see Page 999; visible: Sandalez \(100200300400500\)/);
    expect(r.out).toMatch(/\[FAIL\] Pixel — not shared with the ad account; available: .*555666777888999/);
    expect(r.out).toContain("[FAIL] AUTH_SECRET length — must be at least 32 characters");
    expect(r.out).toContain("NOT READY");
  });

  it("in production mode flags mock/dev values and the generated-but-unfilled file", async () => {
    let r = await script("setup-check.mts", ["--env", good, "--production"]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/\[FAIL\] META_GRAPH_BASE_URL — still a dev\/mock value/);
    expect(r.out).toContain("[FAIL] POSTGRES_PASSWORD — missing");

    r = await script("setup-check.mts", ["--env", join(dir, "prod.env"), "--production"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("[FAIL] META_ACCESS_TOKEN — missing");
    expect(r.out).toContain("[FAIL] MCP_DOMAIN — still the .env.example placeholder");
    expect(r.out).toContain("[SKIP] all Meta checks");
  });
});
