/**
 * Creates (or completes) a production env file from .env.example and fills every secret the
 * tool can generate itself. Existing non-empty values are never changed, so it is safe to re-run.
 * Secrets are written to the file only — never printed.
 *
 *   pnpm setup:env                                       # writes .env.production
 *   pnpm setup:env --out .env --owner-email you@x.com --domain ads.sandalez.pk --mcp-domain mcp.sandalez.pk
 *   pnpm setup:env --local --owner-email you@x.com        # laptop: writes .env, DOMAIN=localhost:3000, MCP_DOMAIN=localhost:3001
 *
 * The Meta values (token, app, IDs) cannot be generated: get them from Business Manager
 * (docs/meta-setup.md), paste them in, then run `pnpm setup:check --env <file>`.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const local = args.includes("--local");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outName = flag("out") ?? (local ? ".env" : ".env.production");
const out = resolve(root, outName);

const hex = (bytes: number) => randomBytes(bytes).toString("hex");
// Readable password: no look-alike characters.
const password = (n: number) => {
  const alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
  return [...randomBytes(n)].map((b) => alphabet[b % alphabet.length]).join("");
};

const pgPassword = hex(24);
const generated: Record<string, () => string> = {
  MCP_BEARER_TOKEN: () => hex(32),
  MCP_PATH_SECRET: () => hex(24),
  API_INTERNAL_SECRET: () => hex(32),
  AUTH_SECRET: () => hex(32),
  POSTGRES_PASSWORD: () => pgPassword,
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: () => hex(16),
  OWNER_PASSWORD: () => password(16),
};
const given: Record<string, string | undefined> = {
  OWNER_EMAIL: flag("owner-email"),
  DOMAIN: flag("domain") ?? (local ? "localhost:3000" : undefined),
  MCP_DOMAIN: flag("mcp-domain") ?? (local ? "localhost:3001" : undefined),
  REPORT_EMAIL_TO: flag("owner-email"),
};
const placeholders = new Set(["act_0000000000", "ads.example.com", "mcp.example.com"]);

const template = readFileSync(resolve(root, ".env.example"), "utf8");
const existing = existsSync(out) ? readFileSync(out, "utf8") : "";
const current = new Map<string, string>();
for (const line of existing.split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
  if (m) current.set(m[1], m[2]);
}

const filled: string[] = [];
const kept: string[] = [];
const lines = template.split(/\r?\n/).map((line) => {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
  if (!m) return line;
  const [, key, def] = m;
  const have = current.get(key);
  if (have !== undefined && have !== "" && !placeholders.has(have)) {
    kept.push(key);
    return `${key}=${have}`;
  }
  const value = given[key] ?? generated[key]?.();
  if (value !== undefined) {
    filled.push(key);
    return `${key}=${value}`;
  }
  return `${key}=${have ?? def}`;
});

// Production defaults that differ from the dev template.
const finalText = lines
  .join("\n")
  .replace(/^DATABASE_URL=postgresql:\/\/sandalez:sandalez@localhost:5432\/(.*)$/m, () => {
    const pw = current.get("POSTGRES_PASSWORD") || pgPassword;
    return `# Overridden by docker-compose; used only when running tools on the server outside Docker.\nDATABASE_URL=postgresql://sandalez:${pw}@postgres:5432/sandalez?schema=public`;
  });

// Laptop: make plain `docker compose ...` pick up the local overlay (no -f flags to remember).
const localBlock = [
  "",
  "# ---------------------------------------------------------------- Docker Compose on a laptop (written by setup:env --local)",
  `COMPOSE_PATH_SEPARATOR=${current.get("COMPOSE_PATH_SEPARATOR") || ","}`,
  `COMPOSE_FILE=${current.get("COMPOSE_FILE") || "docker-compose.yml,docker-compose.local.yml"}`,
  "# Add a tunnel with COMPOSE_PROFILES=quick-tunnel or COMPOSE_PROFILES=tunnel (docs/local-laptop.md)",
  `COMPOSE_PROFILES=${current.get("COMPOSE_PROFILES") ?? ""}`,
].join("\n");
// Re-runs keep the block (and its values) even without --local.
const withLocal = local || current.has("COMPOSE_FILE");
const body = withLocal ? `${finalText.trimEnd()}\n${localBlock}` : finalText;
if (local && !current.has("COMPOSE_FILE")) filled.push("COMPOSE_FILE");

writeFileSync(out, body.endsWith("\n") ? body : `${body}\n`, { mode: 0o600 });
try {
  chmodSync(out, 0o600);
} catch {
  /* Windows */
}

const stillEmpty = [...finalText.matchAll(/^([A-Z0-9_]+)=(.*)$/gm)]
  .filter(([, , v]) => v.trim() === "" || placeholders.has(v.trim()))
  .map(([, k]) => k);

console.log(`Wrote ${out}`);
console.log(`  generated/set: ${filled.join(", ") || "nothing (all already set)"}`);
if (kept.length) console.log(`  kept existing: ${kept.length} value(s)`);
const optional = /^(META_CAPI_TEST_EVENT_CODE|MCP_IP_ALLOWLIST|SHOPIFY_WEBHOOK_SECRET|SMTP_.*|CLOUDFLARE_TUNNEL_TOKEN|DASHBOARD_URL)$/;
console.log(`  still to fill (required): ${stillEmpty.filter((k) => !optional.test(k)).join(", ") || "nothing"}`);
console.log(`  optional, empty: ${stillEmpty.filter((k) => optional.test(k)).join(", ") || "none"}`);
console.log(`Next: fill the Meta values (docs/meta-setup.md), then run: pnpm setup:check --env ${outName}`);
