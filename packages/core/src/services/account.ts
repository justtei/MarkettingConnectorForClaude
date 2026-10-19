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

export async function getAccount(ctx: CoreContext) {
  const a = await ctx.meta.get<any>(ctx.config.META_AD_ACCOUNT_ID, {
    fields: "id,account_id,name,currency,timezone_name,account_status,disable_reason,amount_spent,spend_cap,balance,business_name",
  });
  currencyCache.set(ctx.config.META_AD_ACCOUNT_ID, a.currency);
  const cur = a.currency as string;
  return {
    id: a.id as string,
    name: a.name as string,
    business_name: a.business_name ?? null,
    currency: cur,
    timezone: a.timezone_name as string,
    status: ACCOUNT_STATUS[a.account_status] ?? String(a.account_status),
    disable_reason: a.disable_reason ?? null,
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
