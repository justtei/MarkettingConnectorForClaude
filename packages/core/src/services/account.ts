import type { CoreContext } from "../context.js";
import { fromMinorUnits } from "../meta/money.js";

const ACCOUNT_STATUS: Record<number, string> = {
  1: "ACTIVE",
  2: "DISABLED",
  3: "UNSETTLED",
  7: "PENDING_RISK_REVIEW",
  8: "PENDING_SETTLEMENT",
  9: "IN_GRACE_PERIOD",
  100: "PENDING_CLOSURE",
  101: "CLOSED",
  201: "ANY_ACTIVE",
  202: "ANY_CLOSED",
};

const currencyCache = new Map<string, string>();

/** The ad account currency (read once per process, then cached). */
export async function getCurrency(ctx: CoreContext): Promise<string> {
  const key = ctx.config.META_AD_ACCOUNT_ID;
  const hit = currencyCache.get(key);
  if (hit) return hit;
  const res = await ctx.meta.get<{ currency: string }>(key, { fields: "currency" });
  currencyCache.set(key, res.currency);
  return res.currency;
}

export function clearCurrencyCache(): void {
  currencyCache.clear();
}

/** Meta's ad account disable_reason codes. */
const DISABLE_REASON: Record<number, string> = {
  1: "ad policy (integrity) violation",
  2: "intellectual property review",
  3: "payment risk (failed or suspicious payment)",
  4: "account shut down",
  5: "advertiser review",
  6: "business integrity review",
  7: "permanently closed",
  8: "unused reseller account",
  9: "unused account",
  10: "umbrella account",
  11: "business manager integrity policy",
  12: "misrepresented ad account",
  13: "ad account policy review",
};

const ACCOUNT_FIELDS =
  "id,account_id,name,currency,timezone_name,account_status,disable_reason,amount_spent,spend_cap,balance,business_name";

export type AccountWarning = { severity: "critical" | "warning"; code: string; message: string };

/** Problems that stop or will stop delivery: disabled, unpaid, in review, spend limit reached, rejected ads. */
export function warningsFor(a: any, rejected = 0): AccountWarning[] {
  const cur = String(a.currency ?? "PKR");
  const out: AccountWarning[] = [];
  const status = Number(a.account_status);
  const reason = DISABLE_REASON[Number(a.disable_reason)];
  if (status === 2) out.push({ severity: "critical", code: "disabled", message: `The ad account is disabled${reason ? ` (${reason})` : ""}. Request a review in Account Quality.` });
  if (status === 3) out.push({ severity: "critical", code: "payment_failed", message: "A payment failed (account unsettled): nothing delivers until the balance is paid in Billing." });
  if (status === 9) out.push({ severity: "critical", code: "grace_period", message: "A payment failed; ads run for a short grace period. Fix the payment method in Billing." });
  if (status === 7) out.push({ severity: "warning", code: "risk_review", message: "The account is in a payment risk review." });
  if (status === 8) out.push({ severity: "warning", code: "pending_settlement", message: "A payment is being settled." });
  if (status === 100 || status === 101) out.push({ severity: "critical", code: "closed", message: "The ad account is closed or closing." });
  const cap = fromMinorUnits(a.spend_cap, cur);
  const spent = fromMinorUnits(a.amount_spent, cur);
  if (cap && cap > 0 && spent !== null) {
    if (spent >= cap) out.push({ severity: "critical", code: "spend_cap_reached", message: `The account spending limit (${cur} ${cap}) is reached: raise or reset it in Billing.` });
    else if (spent >= cap * 0.9) out.push({ severity: "warning", code: "spend_cap_near", message: `${Math.round((spent / cap) * 100)}% of the account spending limit (${cur} ${cap}) is used.` });
  }
  if (rejected > 0) out.push({ severity: "warning", code: "ads_rejected", message: `${rejected} ad(s) are disapproved or have issues (get_campaign_tree shows the reasons).` });
  return out;
}

export async function accountWarnings(ctx: CoreContext): Promise<AccountWarning[]> {
  const a = await ctx.meta.get<any>(ctx.config.META_AD_ACCOUNT_ID, { fields: ACCOUNT_FIELDS });
  return warningsFor(a);
}

export async function getAccount(ctx: CoreContext) {
  const [a, rejected] = await Promise.all([
    ctx.meta.get<any>(ctx.config.META_AD_ACCOUNT_ID, { fields: ACCOUNT_FIELDS }),
    ctx.meta
      .getAll<any>(`${ctx.config.META_AD_ACCOUNT_ID}/ads`, { fields: "id", effective_status: ["DISAPPROVED", "WITH_ISSUES"] }, 500)
      .then((r) => r.length)
      .catch(() => 0),
  ]);
  currencyCache.set(ctx.config.META_AD_ACCOUNT_ID, a.currency);
  const cur = a.currency as string;
  return {
    warnings: warningsFor(a, rejected),
    id: a.id as string,
    name: a.name as string,
    business_name: a.business_name ?? null,
    currency: cur,
    timezone: a.timezone_name as string,
    status: ACCOUNT_STATUS[a.account_status] ?? String(a.account_status),
    disable_reason: a.disable_reason ? DISABLE_REASON[Number(a.disable_reason)] ?? String(a.disable_reason) : null,
    amount_spent: fromMinorUnits(a.amount_spent, cur),
    spend_cap: a.spend_cap && a.spend_cap !== "0" ? fromMinorUnits(a.spend_cap, cur) : null,
    balance: fromMinorUnits(a.balance, cur),
    configured: {
      page_id: ctx.config.META_PAGE_ID ?? null,
      instagram_user_id: ctx.config.META_INSTAGRAM_USER_ID ?? null,
      pixel_id: ctx.config.META_PIXEL_ID ?? null,
      whatsapp_number: ctx.config.WHATSAPP_PHONE_NUMBER ?? null,
      api_version: ctx.config.META_API_VERSION,
    },
    rate_limit_usage: ctx.meta.lastUsage ? { max_pct: ctx.meta.lastUsage.maxPct, at: ctx.meta.lastUsage.at } : null,
  };
}

export async function listPages(ctx: CoreContext) {
  const fields = "id,name,category,link,instagram_business_account{id,username},tasks";
  let pages: any[] = [];
  try {
    pages = await ctx.meta.getAll("me/accounts", { fields }, 100);
  } catch (err) {
    if (!ctx.config.META_BUSINESS_ID) throw err;
  }
  if (pages.length === 0 && ctx.config.META_BUSINESS_ID) {
    pages = await ctx.meta.getAll(`${ctx.config.META_BUSINESS_ID}/owned_pages`, { fields }, 100);
  }
  return pages.map((p) => ({
    id: p.id,
    name: p.name,
    category: p.category ?? null,
    link: p.link ?? null,
    instagram: p.instagram_business_account ?? null,
    tasks: p.tasks ?? null,
    is_configured_page: p.id === ctx.config.META_PAGE_ID,
  }));
}

export async function listInstagramAccounts(ctx: CoreContext) {
  const out = new Map<string, { id: string; username: string | null; source: string }>();
  const fromAccount = await ctx.meta.getAll<any>(`${ctx.config.META_AD_ACCOUNT_ID}/instagram_accounts`, {
    fields: "id,username",
  });
  for (const a of fromAccount) out.set(a.id, { id: a.id, username: a.username ?? null, source: "ad_account" });
  if (ctx.config.META_PAGE_ID) {
    try {
      const page = await ctx.meta.get<any>(ctx.config.META_PAGE_ID, {
        fields: "instagram_business_account{id,username}",
      });
      const ig = page.instagram_business_account;
      if (ig?.id && !out.has(ig.id)) out.set(ig.id, { id: ig.id, username: ig.username ?? null, source: "page" });
    } catch (err) {
      ctx.log.warn({ err }, "Could not read the Page's Instagram account");
    }
  }
  return [...out.values()].map((a) => ({ ...a, is_configured: a.id === ctx.config.META_INSTAGRAM_USER_ID }));
}

export async function listPixels(ctx: CoreContext) {
  const pixels = await ctx.meta.getAll<any>(`${ctx.config.META_AD_ACCOUNT_ID}/adspixels`, {
    fields: "id,name,last_fired_time,is_unavailable,creation_time",
  });
  return pixels.map((p) => ({
    id: p.id,
    name: p.name,
    last_fired_time: p.last_fired_time ?? null,
    is_unavailable: p.is_unavailable ?? false,
    is_configured: p.id === ctx.config.META_PIXEL_ID,
  }));
}

export const REQUIRED_SCOPES = [
  "ads_management",
  "ads_read",
  "business_management",
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_ads",
];

/** Token health: validity, expiry (warn within 14 days) and missing permissions. */
export async function checkToken(ctx: CoreContext) {
  const appToken =
    ctx.config.META_APP_ID && ctx.config.META_APP_SECRET
      ? `${ctx.config.META_APP_ID}|${ctx.config.META_APP_SECRET}`
      : undefined;
  // Inspecting with the app token is preferred; a token may also inspect itself.
  const res = await ctx.meta.get<{ data: any }>("debug_token", {
    input_token: ctx.config.META_ACCESS_TOKEN,
    ...(appToken ? { access_token: appToken } : {}),
  });
  const d = res.data ?? {};
  const scopes: string[] = d.scopes ?? [];
  const expiresAt = Number(d.expires_at ?? 0);
  const dataAccessExpiresAt = Number(d.data_access_expires_at ?? 0);
  const now = Date.now() / 1000;
  const daysLeft = expiresAt > 0 ? Math.floor((expiresAt - now) / 86400) : null;
  const missing = REQUIRED_SCOPES.filter((s) => !scopes.includes(s));
  const warnings: string[] = [];
  if (!d.is_valid) warnings.push("Token is NOT valid. Generate a new system user token.");
  if (daysLeft !== null && daysLeft <= 14) warnings.push(`Token expires in ${daysLeft} day(s). Renew it soon.`);
  if (missing.length) warnings.push(`Token is missing permissions: ${missing.join(", ")}.`);
  if (d.app_id && ctx.config.META_APP_ID && String(d.app_id) !== ctx.config.META_APP_ID) {
    warnings.push(`Token belongs to app ${d.app_id}, but META_APP_ID is ${ctx.config.META_APP_ID}.`);
  }
  return {
    is_valid: Boolean(d.is_valid),
    type: d.type ?? null,
    app_id: d.app_id ?? null,
    application: d.application ?? null,
    user_id: d.user_id ?? null,
    expires_at: expiresAt > 0 ? new Date(expiresAt * 1000).toISOString() : "never",
    days_left: daysLeft,
    data_access_expires_at: dataAccessExpiresAt > 0 ? new Date(dataAccessExpiresAt * 1000).toISOString() : null,
    scopes,
    missing_scopes: missing,
    warnings,
    healthy: Boolean(d.is_valid) && missing.length === 0 && (daysLeft === null || daysLeft > 14),
    api_version: ctx.meta.apiVersion,
  };
}
