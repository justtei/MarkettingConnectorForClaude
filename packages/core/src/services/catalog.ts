/** Phase 3: product catalogs and dynamic product ads (catalog sales campaigns). All created PAUSED. */
import { z } from "zod";
import { audited } from "../audit.js";
import type { CoreContext } from "../context.js";
import { checkDailyBudget, forcePaused, rememberOwned, UserInputError } from "../guards.js";
import { toMinorUnits } from "../meta/money.js";
import { targetingInput } from "../schemas.js";
import { getCurrency } from "./account.js";
import { rollbackCreated } from "./ctwa.js";
import { mirrorAd, mirrorAdSet, mirrorCampaign, mirrorCreative } from "./mirror.js";
import { getSettings } from "./settings.js";
import { buildTargeting, validateTargetingSpec, withExplicitAdvantageAudience } from "./targeting.js";

export const productSetInput = z.object({
  catalog_id: z.string().regex(/^\d+$/),
  name: z.string().min(1).max(200),
  filter: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Meta product filter, e.g. {"product_type":{"i_contains":"flats"}}. Omit for all products.'),
});

export const catalogCampaignInput = z.object({
  name: z.string().min(1).max(400),
  catalog_id: z.string().regex(/^\d+$/),
  product_set_id: z.string().regex(/^\d+$/),
  daily_budget: z.number().positive().describe("PKR per day"),
  mode: z
    .enum(["retargeting", "broad"])
    .default("retargeting")
    .describe("retargeting = people who viewed/added to cart but did not buy; broad = new people likely to buy."),
  retargeting_days: z.number().int().min(1).max(180).default(14),
  targeting: targetingInput.optional().describe("Location/age for broad mode (default: Pakistan)."),
  primary_text: z.string().max(2200),
  headline: z.string().max(255).default("{{product.name}}"),
  description: z.string().max(255).default("{{product.price}}"),
  link: z.string().url().optional().describe("Fallback store URL. Product URLs come from the catalog."),
});

function requireBusiness(ctx: CoreContext): string {
  if (!ctx.config.META_BUSINESS_ID) throw new UserInputError("META_BUSINESS_ID is not configured; it is needed to list catalogs.");
  return ctx.config.META_BUSINESS_ID;
}

export async function listCatalogs(ctx: CoreContext) {
  const business = requireBusiness(ctx);
  const rows = await ctx.meta.getAll<any>(`${business}/owned_product_catalogs`, { fields: "id,name,product_count,vertical" }, 100);
  const out = [];
  for (const c of rows) {
    let sets: any[] = [];
    try {
      sets = await ctx.meta.getAll<any>(`${c.id}/product_sets`, { fields: "id,name,product_count,filter" }, 100);
    } catch (err) {
      ctx.log.warn({ err: String(err), catalog: c.id }, "Could not list product sets");
    }
    out.push({
      id: c.id,
      name: c.name,
      product_count: c.product_count ?? null,
      vertical: c.vertical ?? null,
      product_sets: sets.map((s) => ({ id: s.id, name: s.name, product_count: s.product_count ?? null, filter: s.filter ?? null })),
    });
  }
  return out;
}

export async function createProductSet(ctx: CoreContext, raw: z.input<typeof productSetInput>) {
  const input = productSetInput.parse(raw);
  return audited(ctx, "create_product_set", { request: input }, async () => {
    const res = await ctx.meta.post<{ id: string }>(`${input.catalog_id}/product_sets`, {
      name: input.name,
      ...(input.filter ? { filter: input.filter } : {}),
    });
    return { product_set_id: res.id, name: input.name, catalog_id: input.catalog_id };
  }, (r) => r.product_set_id);
}

export async function createCatalogCampaign(ctx: CoreContext, raw: z.input<typeof catalogCampaignInput>) {
  const input = catalogCampaignInput.parse(raw);
  if (!ctx.config.META_PAGE_ID) throw new UserInputError("META_PAGE_ID is not configured.");
  if (!ctx.config.META_PIXEL_ID) throw new UserInputError("META_PIXEL_ID is not configured; catalog ads optimize for purchases.");
  const settings = await getSettings(ctx);
  checkDailyBudget(settings, input.daily_budget);
  const currency = await getCurrency(ctx);

  let targeting: Record<string, any>;
  if (input.mode === "retargeting") {
    const retention = input.retargeting_days * 86400;
    targeting = {
      geo_locations: { countries: ["PK"] },
      product_audience_specs: [
        {
          product_set_id: input.product_set_id,
          inclusions: [
            { retention_seconds: retention, rule: { event: { eq: "ViewContent" } } },
            { retention_seconds: retention, rule: { event: { eq: "AddToCart" } } },
          ],
          exclusions: [{ retention_seconds: retention, rule: { event: { eq: "Purchase" } } }],
        },
      ],
      // Retargeting is a fixed audience; v26.0 wants the flag stated either way.
      targeting_automation: { advantage_audience: 0 },
    };
  } else {
    targeting = withExplicitAdvantageAudience(await buildTargeting(ctx, input.targeting ?? { countries: ["PK"] }));
    validateTargetingSpec(targeting);
  }

  return audited(ctx, "create_catalog_campaign", { request: input }, async () => {
    const created: { type: "campaign" | "adset" | "creative" | "ad"; id: string }[] = [];
    try {
      const campaignParams = forcePaused({
        name: input.name,
        objective: "OUTCOME_SALES",
        special_ad_categories: [],
        buying_type: "AUCTION",
        promoted_object: { product_catalog_id: input.catalog_id },
        is_adset_budget_sharing_enabled: false,
      });
      const campaign = await ctx.meta.post<{ id: string }>(`${ctx.config.META_AD_ACCOUNT_ID}/campaigns`, campaignParams);
      created.push({ type: "campaign", id: campaign.id });
      rememberOwned(ctx, campaign.id, "campaign");
      await mirrorCampaign(ctx, { id: campaign.id, ...campaignParams }, currency, ctx.via);

      const adsetParams = forcePaused({
        name: `${input.name} | ${input.mode === "retargeting" ? `Retarget ${input.retargeting_days}d` : "Broad"}`,
        campaign_id: campaign.id,
        daily_budget: toMinorUnits(input.daily_budget, currency),
        billing_event: "IMPRESSIONS",
        optimization_goal: "OFFSITE_CONVERSIONS",
        bid_strategy: "LOWEST_COST_WITHOUT_CAP",
        promoted_object: { product_set_id: input.product_set_id, custom_event_type: "PURCHASE" },
        targeting,
      });
      const adset = await ctx.meta.post<{ id: string }>(`${ctx.config.META_AD_ACCOUNT_ID}/adsets`, adsetParams);
      created.push({ type: "adset", id: adset.id });
      rememberOwned(ctx, adset.id, "adset");
      await mirrorAdSet(ctx, { id: adset.id, ...adsetParams, optimization_goal: "OFFSITE_CONVERSIONS", destination_type: "WEBSITE" }, currency);

      const creativePayload = {
        name: `${input.name} - catalog creative`,
        product_set_id: input.product_set_id,
        object_story_spec: {
          page_id: ctx.config.META_PAGE_ID,
          ...(ctx.config.META_INSTAGRAM_USER_ID ? { instagram_user_id: ctx.config.META_INSTAGRAM_USER_ID } : {}),
          template_data: {
            message: input.primary_text,
            name: input.headline,
            description: input.description,
            ...(input.link ? { link: input.link } : {}),
            call_to_action: { type: "SHOP_NOW" },
          },
        },
      };
      const creative = await ctx.meta.post<{ id: string }>(`${ctx.config.META_AD_ACCOUNT_ID}/adcreatives`, creativePayload);
      created.push({ type: "creative", id: creative.id });
      await mirrorCreative(ctx, { id: creative.id, ...creativePayload, object_type: "CATALOG" });

      const adParams = forcePaused({ name: `${input.name} - DPA`, adset_id: adset.id, creative: { creative_id: creative.id } });
      const ad = await ctx.meta.post<{ id: string }>(`${ctx.config.META_AD_ACCOUNT_ID}/ads`, adParams);
      created.push({ type: "ad", id: ad.id });
      rememberOwned(ctx, ad.id, "ad");
      await mirrorAd(ctx, { id: ad.id, name: adParams.name, adset_id: adset.id, status: "PAUSED", creative: { id: creative.id } });

      return {
        campaign_id: campaign.id,
        adset_id: adset.id,
        creative_id: creative.id,
        ad_id: ad.id,
        status: "PAUSED",
        mode: input.mode,
        next_step: "Review in Ads Manager, then activate with set_status(confirm=true) after the user confirms.",
      };
    } catch (err) {
      const rollback = await rollbackCreated(ctx, created);
      (err as any).rollback = rollback;
      throw err;
    }
  }, (r) => r.campaign_id);
}
