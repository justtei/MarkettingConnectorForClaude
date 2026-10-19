/** Phase 3: custom and lookalike audiences. Creating an audience never spends money. */
import { createHash } from "node:crypto";
import { z } from "zod";
import { audited } from "../audit.js";
import type { CoreContext } from "../context.js";
import { rememberOwned, resolveOwnedObject, UserInputError } from "../guards.js";

export const customAudienceInput = z.object({
  name: z.string().min(1).max(200),
  source: z.enum(["website", "engagement", "customer_list"]),
  retention_days: z.number().int().min(1).max(180).default(30).describe("Website: max 180. Engagement: max 365 (capped at 180 here)."),
  website_event: z
    .enum(["all_visitors", "PageView", "ViewContent", "AddToCart", "InitiateCheckout", "Purchase"])
    .default("all_visitors")
    .describe("Website audiences: which pixel event."),
  engagement_source: z.enum(["page", "instagram"]).default("instagram").describe("Engagement audiences: Facebook Page or Instagram."),
  customers: z
    .array(z.object({ email: z.string().max(320).optional(), phone: z.string().max(40).optional() }))
    .max(10_000)
    .optional()
    .describe("Customer list: emails and/or phones (hashed with SHA-256 before upload)."),
  description: z.string().max(500).optional(),
});

export const lookalikeInput = z.object({
  name: z.string().min(1).max(200),
  origin_audience_id: z.string().regex(/^\d+$/),
  ratio: z.number().min(0.01).max(0.2).default(0.01).describe("0.01 = top 1% most similar people."),
  country: z.string().length(2).default("PK"),
});

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Meta normalization: lowercase/trim emails; phones as digits with country code (Pakistani 03xx -> 923xx). */
export function normalizePhone(phone: string): string {
  let d = phone.replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  if (d.startsWith("0") && d.length === 11) d = `92${d.slice(1)}`;
  if (d.length === 10 && d.startsWith("3")) d = `92${d}`;
  return d;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Hashes one customer row; unusable emails/phones become "" (Meta treats empty as missing). */
export function hashCustomer(c: { email?: string; phone?: string }): [string, string] {
  const email = c.email?.trim().toLowerCase() ?? "";
  const phone = c.phone ? normalizePhone(c.phone) : "";
  return [EMAIL_RE.test(email) ? sha256(email) : "", phone.length >= 10 && phone.length <= 15 ? sha256(phone) : ""];
}

export async function listAudiences(ctx: CoreContext) {
  const rows = await ctx.meta.getAll<any>(`${ctx.config.META_AD_ACCOUNT_ID}/customaudiences`, {
    fields: "id,name,subtype,description,approximate_count_lower_bound,approximate_count_upper_bound,operation_status,delivery_status,retention_days,time_created,lookalike_spec",
  }, 500);
  for (const a of rows) rememberOwned(ctx, a.id, "customaudience");
  return rows.map((a) => ({
    id: a.id,
    name: a.name,
    subtype: a.subtype,
    description: a.description ?? null,
    size_lower: a.approximate_count_lower_bound ?? null,
    size_upper: a.approximate_count_upper_bound ?? null,
    status: a.operation_status?.description ?? null,
    delivery: a.delivery_status?.description ?? null,
    retention_days: a.retention_days ?? null,
    lookalike: a.lookalike_spec ?? null,
    created: a.time_created ? new Date(Number(a.time_created) * 1000).toISOString() : null,
  }));
}

export async function createCustomAudience(ctx: CoreContext, raw: z.input<typeof customAudienceInput>) {
  const input = customAudienceInput.parse(raw);
  const retentionSeconds = input.retention_days * 86400;
  let params: Record<string, unknown>;

  if (input.source === "website") {
    if (!ctx.config.META_PIXEL_ID) throw new UserInputError("META_PIXEL_ID is not configured.");
    const filter =
      input.website_event === "all_visitors"
        ? { operator: "and", filters: [{ field: "url", operator: "i_contains", value: "" }] }
        : { operator: "and", filters: [{ field: "event", operator: "eq", value: input.website_event }] };
    params = {
      name: input.name,
      description: input.description,
      prefill: true,
      rule: {
        inclusions: {
          operator: "or",
          rules: [{ event_sources: [{ id: ctx.config.META_PIXEL_ID, type: "pixel" }], retention_seconds: retentionSeconds, filter }],
        },
      },
    };
  } else if (input.source === "engagement") {
    const ig = input.engagement_source === "instagram";
    const sourceId = ig ? ctx.config.META_INSTAGRAM_USER_ID : ctx.config.META_PAGE_ID;
    if (!sourceId) throw new UserInputError(ig ? "META_INSTAGRAM_USER_ID is not configured." : "META_PAGE_ID is not configured.");
    params = {
      name: input.name,
      description: input.description,
      prefill: true,
      rule: {
        inclusions: {
          operator: "or",
          rules: [
            {
              event_sources: [{ id: sourceId, type: ig ? "ig_business" : "page" }],
              retention_seconds: retentionSeconds,
              filter: { operator: "and", filters: [{ field: "event", operator: "eq", value: ig ? "ig_business_profile_all" : "page_engaged" }] },
            },
          ],
        },
      },
    };
  } else {
    if (!input.customers?.length) throw new UserInputError("A customer list audience needs customers (emails and/or phones).");
    if (!input.customers.some((c) => hashCustomer(c).some(Boolean))) {
      throw new UserInputError("None of the customers has a usable email or phone number.");
    }
    params = { name: input.name, description: input.description, subtype: "CUSTOM", customer_file_source: "USER_PROVIDED_ONLY" };
  }

  return audited(ctx, "create_custom_audience", { request: { ...input, customers: input.customers?.length } }, async () => {
    const res = await ctx.meta.post<{ id: string }>(`${ctx.config.META_AD_ACCOUNT_ID}/customaudiences`, params);
    rememberOwned(ctx, res.id, "customaudience");
    let uploaded: { received: number; invalid: number; skipped: number } | null = null;
    if (input.source === "customer_list" && input.customers) {
      const rows = input.customers.map(hashCustomer).filter(([e, p]) => e || p);
      const skipped = input.customers.length - rows.length;
      let received = 0;
      let invalid = 0;
      for (let i = 0; i < rows.length; i += 10_000) {
        const chunk = rows.slice(i, i + 10_000);
        const r = await ctx.meta.post<{ num_received?: number; num_invalid_entries?: number }>(`${res.id}/users`, {
          payload: { schema: ["EMAIL_SHA256", "PHONE_SHA256"], data: chunk },
        });
        received += r.num_received ?? chunk.length;
        invalid += r.num_invalid_entries ?? 0;
      }
      uploaded = { received, invalid, skipped };
    }
    return {
      audience_id: res.id,
      name: input.name,
      source: input.source,
      uploaded,
      note: "Audiences take a few hours to fill. Use list_audiences to check the size.",
    };
  }, (r) => r.audience_id);
}

export async function createLookalike(ctx: CoreContext, raw: z.input<typeof lookalikeInput>) {
  const input = lookalikeInput.parse(raw);
  await resolveOwnedObject(ctx, input.origin_audience_id);
  return audited(ctx, "create_lookalike", { request: input }, async () => {
    const res = await ctx.meta.post<{ id: string }>(`${ctx.config.META_AD_ACCOUNT_ID}/customaudiences`, {
      name: input.name,
      subtype: "LOOKALIKE",
      origin_audience_id: input.origin_audience_id,
      lookalike_spec: { ratio: input.ratio, country: input.country.toUpperCase(), type: "similarity" },
    });
    rememberOwned(ctx, res.id, "customaudience");
    return {
      audience_id: res.id,
      name: input.name,
      ratio: input.ratio,
      country: input.country.toUpperCase(),
      note: "The source audience needs at least 100 people in the country. Lookalikes take up to a day to fill.",
    };
  }, (r) => r.audience_id);
}
