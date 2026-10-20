/**
 * Rebuilds a copy of a campaign object by object (all PAUSED), for when Meta's own /copies endpoint refuses
 * the source: e.g. its creative still carries the retired standard_enhancements bundle, or its post was
 * made by an app in development mode. Ads reuse the source creative when Meta allows it; otherwise a clean
 * copy of the creative is made without retired fields. Everything created is deleted again if a step fails.
 */
import type { CoreContext } from "../context.js";
import { checkDailyBudget, forcePaused, rememberOwned, UserInputError } from "../guards.js";
import { describeError } from "../meta/errors.js";
import { fromMinorUnits } from "../meta/money.js";
import { getCurrency } from "./account.js";
import { sanitizeDegreesOfFreedom } from "./creative-payload.js";
import { rollbackCreated } from "./ctwa.js";
import { getSettings } from "./settings.js";
import { mergeTargeting, withExplicitAdvantageAudience } from "./targeting.js";

const CAMPAIGN_COPY_FIELDS =
  "id,name,objective,special_ad_categories,daily_budget,lifetime_budget,bid_strategy,promoted_object";
const ADSET_COPY_FIELDS =
  "id,name,status,destination_type,optimization_goal,billing_event,bid_strategy,bid_amount,promoted_object,targeting," +
  "daily_budget,lifetime_budget,attribution_spec,is_dynamic_creative,end_time";
const CREATIVE_COPY_FIELDS =
  "id,name,object_story_spec,asset_feed_spec,degrees_of_freedom_spec,url_tags,product_set_id,object_id," +
  "instagram_user_id,source_instagram_media_id,call_to_action";

export interface RebuildOptions {
  name: string;
  cityKey?: string;
  cityName?: string;
  /** New daily budget per ad set, in Meta minor units. */
  dailyBudgetMinor?: number;
}

type Created = { type: "campaign" | "adset" | "creative" | "ad"; id: string };

export async function rebuildCampaignCopy(ctx: CoreContext, sourceId: string, opts: RebuildOptions) {
  const currency = await getCurrency(ctx);
  const settings = await getSettings(ctx);
  const acc = ctx.config.META_AD_ACCOUNT_ID;
  const source = await ctx.meta.get<any>(sourceId, { fields: CAMPAIGN_COPY_FIELDS });
  if (Number(source.lifetime_budget ?? 0) > 0) throw new UserInputError("Campaigns with a lifetime budget can't be rebuilt; copy it in Ads Manager.");
  if (Number(source.daily_budget ?? 0) > 0) checkDailyBudget(settings, fromMinorUnits(source.daily_budget, currency)!);

  const created: Created[] = [];
  const notes: string[] = [];
  try {
    const campaignBudget = Number(source.daily_budget ?? 0) > 0;
    const campaignParams = forcePaused({
      name: opts.name,
      objective: source.objective,
      special_ad_categories: source.special_ad_categories ?? [],
      buying_type: "AUCTION",
      ...(Number(source.daily_budget ?? 0) > 0
        ? { daily_budget: source.daily_budget, bid_strategy: source.bid_strategy ?? "LOWEST_COST_WITHOUT_CAP" }
        : { is_adset_budget_sharing_enabled: false }),
      ...(source.promoted_object ? { promoted_object: source.promoted_object } : {}),
    });
    const campaign = await ctx.meta.post<{ id: string }>(`${acc}/campaigns`, campaignParams);
    created.push({ type: "campaign", id: campaign.id });
    rememberOwned(ctx, campaign.id, "campaign");

    const adsets = (await ctx.meta.getAll<any>(`${sourceId}/adsets`, { fields: ADSET_COPY_FIELDS }, 500)).filter(
      (s) => s.status !== "ARCHIVED" && s.status !== "DELETED",
    );
    for (const s of adsets) {
      let targeting = withExplicitAdvantageAudience(mergeTargeting(s.targeting ?? {}, {}));
      if (opts.cityKey) {
        targeting = {
          ...targeting,
          geo_locations: { cities: [{ key: opts.cityKey }], location_types: targeting.geo_locations?.location_types ?? ["home", "recent"] },
        };
      }
      const daily = opts.dailyBudgetMinor ?? (Number(s.daily_budget ?? 0) > 0 ? Number(s.daily_budget) : undefined);
      if (daily !== undefined) checkDailyBudget(settings, fromMinorUnits(daily, currency)!);
      const endTime = s.end_time && Date.parse(s.end_time) > Date.now() ? s.end_time : undefined;
      const params = forcePaused({
        name: opts.cityName ? `${s.name} | ${opts.cityName}` : s.name,
        campaign_id: campaign.id,
        ...(daily !== undefined && !campaignBudget ? { daily_budget: daily } : {}),
        billing_event: s.billing_event ?? "IMPRESSIONS",
        optimization_goal: s.optimization_goal,
        ...(campaignBudget ? {} : { bid_strategy: s.bid_strategy ?? "LOWEST_COST_WITHOUT_CAP" }),
        ...(s.bid_amount ? { bid_amount: s.bid_amount } : {}),
        ...(s.destination_type ? { destination_type: s.destination_type } : {}),
        ...(s.promoted_object ? { promoted_object: s.promoted_object } : {}),
        // Chat-optimised ad sets only accept Meta's default window (1-day click) since 2026; older ones still carry 7 days.
        ...(s.attribution_spec && s.optimization_goal !== "CONVERSATIONS" ? { attribution_spec: s.attribution_spec } : {}),
        ...(s.is_dynamic_creative ? { is_dynamic_creative: true } : {}),
        ...(endTime ? { end_time: endTime } : {}),
        targeting,
      });
      let adset: { id: string };
      try {
        adset = await ctx.meta.post<{ id: string }>(`${acc}/adsets`, params);
      } catch (err) {
        // Meta: "The click attribution window is optional. For the selected objective and performance goal, use one of
        // these supported windows: 1 days." Retry once with Meta's default window.
        if (!("attribution_spec" in params) || !/attribution/i.test(describeError(err).message)) throw err;
        const { attribution_spec: _dropped, ...rest } = params as Record<string, unknown>;
        adset = await ctx.meta.post<{ id: string }>(`${acc}/adsets`, rest);
        notes.push(`ad set "${s.name}": Meta refused the old attribution window, so it uses Meta's default`);
      }
      created.push({ type: "adset", id: adset.id });
      rememberOwned(ctx, adset.id, "adset");

      const ads = (await ctx.meta.getAll<any>(`${s.id}/ads`, { fields: "id,name,status,creative{id}" }, 500)).filter(
        (a) => a.status !== "ARCHIVED" && a.status !== "DELETED" && a.creative?.id,
      );
      for (const a of ads) {
        const adParams = (creativeId: string) => forcePaused({ name: a.name, adset_id: adset.id, creative: { creative_id: creativeId } });
        let ad: { id: string };
        try {
          ad = await ctx.meta.post<{ id: string }>(`${acc}/ads`, adParams(a.creative.id));
        } catch (reuseErr) {
          const creativeId = await copyCreative(ctx, a.creative.id);
          created.push({ type: "creative", id: creativeId });
          notes.push(`ad "${a.name}": made a clean copy of its creative (${describeError(reuseErr).message})`);
          ad = await ctx.meta.post<{ id: string }>(`${acc}/ads`, adParams(creativeId));
        }
        created.push({ type: "ad", id: ad.id });
        rememberOwned(ctx, ad.id, "ad");
      }
    }
    return { campaign_id: campaign.id, notes };
  } catch (err) {
    const rollback = await rollbackCreated(ctx, created);
    const d = describeError(err);
    const e = new Error(
      `Copying the campaign failed: ${d.message} Rollback: ${rollback.deleted.length} object(s) deleted` +
        `${rollback.failed.length ? `, ${rollback.failed.length} could not be deleted (${rollback.failed.map((f) => `${f.type} ${f.id}`).join(", ")}) — pause them in Ads Manager` : ""}.`,
    );
    (e as any).details = { ...d.details, rollback };
    throw e;
  }
}

/** Posts a copy of a creative without the fields Meta no longer accepts. Returns the new creative ID. */
export async function copyCreative(ctx: CoreContext, creativeId: string): Promise<string> {
  const cr = await ctx.meta.get<any>(creativeId, { fields: CREATIVE_COPY_FIELDS });
  const body: Record<string, unknown> = { name: `${cr.name ?? "Creative"} (copy)` };
  if (cr.object_story_spec) {
    body.object_story_spec = cleanStorySpec(cr.object_story_spec);
  } else if (cr.source_instagram_media_id) {
    Object.assign(body, {
      object_id: cr.object_id,
      instagram_user_id: cr.instagram_user_id,
      source_instagram_media_id: cr.source_instagram_media_id,
      ...(cr.call_to_action ? { call_to_action: cr.call_to_action } : {}),
    });
  } else {
    throw new UserInputError(`Creative ${creativeId} can't be copied (no story spec or Instagram post).`);
  }
  if (cr.asset_feed_spec) body.asset_feed_spec = cr.asset_feed_spec;
  const dof = sanitizeDegreesOfFreedom(cr.degrees_of_freedom_spec);
  if (dof) body.degrees_of_freedom_spec = dof;
  if (cr.url_tags) body.url_tags = cr.url_tags;
  if (cr.product_set_id) body.product_set_id = cr.product_set_id;
  const res = await ctx.meta.post<{ id: string }>(`${ctx.config.META_AD_ACCOUNT_ID}/adcreatives`, body);
  rememberOwned(ctx, res.id, "adcreative");
  return res.id;
}

/** Meta returns both image_hash and a generated image_url for video thumbnails; send back only the hash. */
function cleanStorySpec(oss: any): Record<string, unknown> {
  const out = structuredClone(oss);
  for (const key of ["video_data", "link_data"]) {
    const d = out[key];
    if (d?.image_hash) {
      delete d.image_url;
      if (key === "link_data") delete d.picture;
    }
  }
  return out;
}
