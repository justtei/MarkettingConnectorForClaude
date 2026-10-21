import type { z } from "zod";
import { audited } from "../audit.js";
import type { CoreContext } from "../context.js";
import { checkDailyBudget, forcePaused, rememberOwned, resolveOwnedObject, UserInputError } from "../guards.js";
import { fromMinorUnits, toMinorUnits } from "../meta/money.js";
import type { createAdInput, createAdsetInput, createCampaignInput, CreativeInput } from "../schemas.js";
import { getCurrency } from "./account.js";
import { getVideoThumbnail, uploadImage, uploadVideo, waitForVideoReady } from "./assets.js";
import {
  appsForCreative,
  appsForDestinationType,
  buildCreativePayload,
  destinationTypeForApps,
  type MessagingApp,
  type ResolvedCreative,
} from "./creative-payload.js";
import {
  AD_FIELDS,
  ADSET_FIELDS,
  CAMPAIGN_FIELDS,
  mirrorAd,
  mirrorAdSet,
  mirrorCampaign,
  mirrorCreative,
} from "./mirror.js";
import { REVIEW_FIELDS, reviewOf } from "./review.js";
import { getSettings } from "./settings.js";
import { buildTargeting, describePlacements, validateTargetingSpec, withExplicitAdvantageAudience } from "./targeting.js";

type CreateCampaign = z.input<typeof createCampaignInput>;
type CreateAdset = z.input<typeof createAdsetInput>;
type CreateAd = z.infer<typeof createAdInput>;

// ---------------------------------------------------------------- campaign

/** Raw create (no audit) — used by the composite flows. Always PAUSED. */
export async function createCampaignRaw(ctx: CoreContext, input: CreateCampaign) {
  const currency = await getCurrency(ctx);
  const settings = await getSettings(ctx);
  if (input.daily_budget !== undefined) checkDailyBudget(settings, input.daily_budget);
  const params = forcePaused({
    name: input.name,
    objective: input.objective ?? "OUTCOME_ENGAGEMENT",
    special_ad_categories: input.special_ad_categories ?? [],
    buying_type: "AUCTION",
    ...(input.daily_budget !== undefined
      ? { daily_budget: toMinorUnits(input.daily_budget, currency), bid_strategy: "LOWEST_COST_WITHOUT_CAP" }
      : { is_adset_budget_sharing_enabled: false }),
  });
  const res = await ctx.meta.post<{ id: string }>(`${ctx.config.META_AD_ACCOUNT_ID}/campaigns`, params);
  rememberOwned(ctx, res.id, "campaign");
  await mirrorCampaign(ctx, { id: res.id, ...params }, currency, ctx.via);
  return {
    campaign_id: res.id,
    name: input.name,
    objective: params.objective,
    status: "PAUSED" as const,
    daily_budget: input.daily_budget ?? null,
    params,
  };
}

export async function createCampaign(ctx: CoreContext, input: CreateCampaign) {
  return audited(ctx, "create_campaign", { request: input }, async () => {
    const { params: _p, ...out } = await createCampaignRaw(ctx, input);
    return out;
  }, (r) => r.campaign_id);
}

// ---------------------------------------------------------------- ad set

const DEFAULT_OPTIMIZATION: Record<string, string> = {
  WEBSITE: "LINK_CLICKS",
  ON_AD: "POST_ENGAGEMENT",
};

/** promoted_object for messaging ad sets: the Page, plus the WhatsApp number when WhatsApp is one of the apps. */
function messagingPromotedObject(ctx: CoreContext, apps: MessagingApp[], objective: string | undefined) {
  if (!ctx.config.META_PAGE_ID) throw new UserInputError("META_PAGE_ID is not configured.");
  const promoted: Record<string, unknown> = { page_id: ctx.config.META_PAGE_ID };
  if (apps.includes("whatsapp")) {
    if (!ctx.config.WHATSAPP_PHONE_NUMBER) throw new UserInputError("WHATSAPP_PHONE_NUMBER is not configured.");
    promoted.whatsapp_phone_number = ctx.config.WHATSAPP_PHONE_NUMBER;
  }
  // Sales campaigns that optimise for chats record purchases from the conversations (as Ads Manager sets it).
  if (objective === "OUTCOME_SALES") promoted.custom_event_type = "PURCHASE";
  return promoted;
}

export async function createAdsetRaw(ctx: CoreContext, input: CreateAdset) {
  const type = await resolveOwnedObject(ctx, input.campaign_id);
  if (type !== "campaign" && type !== "unknown") throw new UserInputError(`${input.campaign_id} is a ${type}, not a campaign.`);
  const currency = await getCurrency(ctx);
  const settings = await getSettings(ctx);

  const campaign = await ctx.meta.get<any>(input.campaign_id, { fields: "id,objective,daily_budget,lifetime_budget" });
  const campaignHasBudget = Boolean(Number(campaign.daily_budget ?? 0) || Number(campaign.lifetime_budget ?? 0));
  if (!campaignHasBudget && input.daily_budget === undefined) {
    throw new UserInputError("Give the ad set a daily_budget (the campaign has no campaign budget).");
  }
  if (campaignHasBudget && input.daily_budget !== undefined) {
    throw new UserInputError("This campaign uses a campaign budget; leave the ad set's daily_budget out.");
  }
  if (input.daily_budget !== undefined) checkDailyBudget(settings, input.daily_budget);

  const targeting = withExplicitAdvantageAudience(await buildTargeting(ctx, input.targeting));
  validateTargetingSpec(targeting);

  const destination = input.destination ?? "WHATSAPP";
  const apps = appsForDestinationType(destination);
  const optimization = input.optimization_goal ?? (apps.length ? "CONVERSATIONS" : DEFAULT_OPTIMIZATION[destination] ?? "LINK_CLICKS");
  if (apps.length > 1) {
    if (optimization !== "CONVERSATIONS") throw new UserInputError("Ad sets for several messaging apps must optimise for CONVERSATIONS.");
    if (!["OUTCOME_ENGAGEMENT", "OUTCOME_SALES", "OUTCOME_TRAFFIC"].includes(campaign.objective)) {
      throw new UserInputError(`Several messaging apps need an Engagement, Sales or Traffic campaign (this one is ${campaign.objective}).`);
    }
  }
  let promoted = input.promoted_object;
  if (!promoted) {
    if (apps.length) {
      promoted = messagingPromotedObject(ctx, apps, campaign.objective);
    } else if (destination === "ON_AD") {
      if (!ctx.config.META_PAGE_ID) throw new UserInputError("META_PAGE_ID is not configured.");
      promoted = { page_id: ctx.config.META_PAGE_ID };
    } else if (optimization === "OFFSITE_CONVERSIONS" || optimization === "VALUE") {
      if (!ctx.config.META_PIXEL_ID) throw new UserInputError("META_PIXEL_ID is not configured.");
      promoted = { pixel_id: ctx.config.META_PIXEL_ID, custom_event_type: "PURCHASE" };
    }
  }
  const bidStrategy = input.bid_strategy ?? "LOWEST_COST_WITHOUT_CAP";
  if (bidStrategy !== "LOWEST_COST_WITHOUT_CAP" && input.bid_amount === undefined) {
    throw new UserInputError(`${bidStrategy} needs a bid_amount in PKR.`);
  }

  const params = forcePaused({
    name: input.name,
    campaign_id: input.campaign_id,
    ...(input.daily_budget !== undefined ? { daily_budget: toMinorUnits(input.daily_budget, currency) } : {}),
    billing_event: input.billing_event ?? "IMPRESSIONS",
    optimization_goal: optimization,
    ...(campaignHasBudget ? {} : { bid_strategy: bidStrategy }),
    ...(input.bid_amount !== undefined ? { bid_amount: toMinorUnits(input.bid_amount, currency) } : {}),
    destination_type: destination,
    ...(promoted ? { promoted_object: promoted } : {}),
    targeting,
    ...(input.start_time ? { start_time: input.start_time } : {}),
    ...(input.end_time ? { end_time: input.end_time } : {}),
    ...(input.is_dynamic_creative ? { is_dynamic_creative: true } : {}),
  });
  const res = await ctx.meta.post<{ id: string }>(`${ctx.config.META_AD_ACCOUNT_ID}/adsets`, params);
  rememberOwned(ctx, res.id, "adset");
  await mirrorAdSet(ctx, { id: res.id, ...params }, currency);
  return {
    adset_id: res.id,
    name: input.name,
    status: "PAUSED" as const,
    daily_budget: input.daily_budget ?? null,
    optimization_goal: optimization,
    destination_type: destination,
    targeting,
  };
}

export async function createAdset(ctx: CoreContext, input: CreateAdset) {
  return audited(ctx, "create_adset", { request: input }, () => createAdsetRaw(ctx, input), (r) => r.adset_id);
}

// ---------------------------------------------------------------- creative

/** Uploads any media given by URL and fills in defaults, producing a ResolvedCreative. */
export async function resolveCreative(ctx: CoreContext, input: CreativeInput): Promise<ResolvedCreative> {
  const pageId = input.page_id ?? ctx.config.META_PAGE_ID;
  if (!pageId) throw new UserInputError("No page_id given and META_PAGE_ID is not configured.");
  const r: ResolvedCreative = {
    name: input.name,
    format: input.format,
    destination: input.destination ?? "whatsapp",
    messaging_apps: input.messaging_apps,
    primary_texts: input.primary_texts,
    headlines: input.headlines,
    creative_features: input.creative_features,
    page_id: pageId,
    instagram_user_id: input.instagram_user_id ?? ctx.config.META_INSTAGRAM_USER_ID,
    headline: input.headline,
    primary_text: input.primary_text,
    description: input.description,
    link: input.link,
    cta_type: input.cta_type,
    instagram_media_id: input.instagram_media_id,
    welcome: {
      welcome_message: input.welcome_message,
      autofill_message: input.autofill_message,
      icebreakers: input.icebreakers,
    },
  };

  if (input.format === "image") {
    r.image_hash = input.image_hash ?? (input.image_url ? (await uploadImage(ctx, { url: input.image_url })).image_hash : undefined);
  }
  if (input.format === "video") {
    r.video_id = input.video_id ?? (input.video_url ? (await uploadVideo(ctx, { url: input.video_url })).video_id : undefined);
    if (r.video_id) {
      await waitForVideoReady(ctx, r.video_id);
      r.thumbnail_hash =
        input.thumbnail_hash ??
        (input.thumbnail_url ? (await uploadImage(ctx, { url: input.thumbnail_url })).image_hash : undefined);
      if (!r.thumbnail_hash) {
        r.thumbnail_url = (await getVideoThumbnail(ctx, r.video_id)) ?? undefined;
      }
    }
  }
  if (input.format === "carousel") {
    if (!input.cards) throw new UserInputError("Carousel creatives need cards (2 to 10).");
    r.cards = [];
    for (const card of input.cards) {
      const hash = card.image_hash ?? (card.image_url ? (await uploadImage(ctx, { url: card.image_url })).image_hash : undefined);
      r.cards.push({ image_hash: hash, video_id: card.video_id, headline: card.headline, description: card.description, link: card.link });
    }
  }
  if (input.format === "dynamic") {
    if (!input.dynamic) throw new UserInputError("Dynamic creatives need the `dynamic` asset lists.");
    const hashes = [...(input.dynamic.image_hashes ?? [])];
    for (const url of input.dynamic.image_urls ?? []) hashes.push((await uploadImage(ctx, { url })).image_hash);
    r.dynamic = {
      image_hashes: hashes,
      video_ids: input.dynamic.video_ids ?? [],
      headlines: input.dynamic.headlines,
      primary_texts: input.dynamic.primary_texts,
      descriptions: input.dynamic.descriptions ?? [],
    };
  }
  return r;
}

export async function createCreativeRaw(ctx: CoreContext, resolved: ResolvedCreative, sourceUrl?: string) {
  let payload: Record<string, unknown>;
  try {
    payload = buildCreativePayload(resolved);
  } catch (err) {
    throw new UserInputError((err as Error).message);
  }
  const res = await ctx.meta.post<{ id: string }>(`${ctx.config.META_AD_ACCOUNT_ID}/adcreatives`, payload);
  rememberOwned(ctx, res.id, "adcreative");
  await mirrorCreative(ctx, { id: res.id, ...payload }, { sourceUrl: sourceUrl ?? null });
  return { creative_id: res.id, name: resolved.name, format: resolved.format, payload };
}

export async function createCreative(ctx: CoreContext, input: CreativeInput) {
  return audited(ctx, "create_creative", { request: input }, async () => {
    const resolved = await resolveCreative(ctx, input);
    const { payload: _p, ...out } = await createCreativeRaw(ctx, resolved, input.image_url ?? input.video_url);
    return out;
  }, (r) => r.creative_id);
}

// ---------------------------------------------------------------- ad

export async function createAdRaw(ctx: CoreContext, input: CreateAd) {
  const type = await resolveOwnedObject(ctx, input.adset_id);
  if (type !== "adset" && type !== "unknown") throw new UserInputError(`${input.adset_id} is a ${type}, not an ad set.`);
  await checkCreativeFitsAdset(ctx, input.adset_id, input.creative_id);
  const params = forcePaused({ name: input.name, adset_id: input.adset_id, creative: { creative_id: input.creative_id } });
  const res = await ctx.meta.post<{ id: string }>(`${ctx.config.META_AD_ACCOUNT_ID}/ads`, params);
  rememberOwned(ctx, res.id, "ad");
  await ensureAdSetMirrored(ctx, input.adset_id);
  const creativeKnown = await ctx.db.creative.findUnique({ where: { id: input.creative_id }, select: { id: true } });
  if (!creativeKnown) {
    const cr = await ctx.meta.get<any>(input.creative_id, { fields: "id,name,thumbnail_url,object_story_spec,asset_feed_spec,object_type" }).catch(() => null);
    if (cr) await mirrorCreative(ctx, cr);
  }
  await mirrorAd(ctx, { id: res.id, name: input.name, adset_id: input.adset_id, status: "PAUSED", creative: { id: input.creative_id } });
  return { ad_id: res.id, name: input.name, adset_id: input.adset_id, creative_id: input.creative_id, status: "PAUSED" as const };
}

const APP_LABEL: Record<MessagingApp, string> = { whatsapp: "WhatsApp", instagram_direct: "Instagram DMs", messenger: "Messenger" };
const appList = (apps: MessagingApp[]) => (apps.length ? apps.map((a) => APP_LABEL[a]).join(" + ") : "a website / no messaging app");

/**
 * Meta refuses an ad whose buttons don't match its ad set's messaging destination
 * ("The campaign destination type must be consistent with app destination in call to action").
 * Checked first so the error says exactly what to change.
 */
export async function checkCreativeFitsAdset(ctx: CoreContext, adsetId: string, creativeId: string) {
  const [adset, creative] = await Promise.all([
    ctx.meta.get<any>(adsetId, { fields: "id,destination_type" }),
    ctx.meta.get<any>(creativeId, { fields: "id,object_story_spec,asset_feed_spec,call_to_action_type" }),
  ]);
  const want = appsForDestinationType(adset.destination_type);
  if (!want.length) return;
  const have = appsForCreative(creative);
  if (!have.length) return; // e.g. an Instagram post creative whose buttons Meta doesn't return; let Meta decide
  if (want.length === have.length && want.every((a) => have.includes(a))) return;
  throw new UserInputError(
    `This creative's buttons go to ${appList(have)}, but the ad set (destination ${adset.destination_type}) sends people to ${appList(want)}. ` +
      `Either create a creative with messaging_apps ${JSON.stringify(want)}, or put this creative in an ad set with destination ` +
      `${destinationTypeForApps(have)}.`,
  );
}

export async function createAd(ctx: CoreContext, input: CreateAd) {
  return audited(ctx, "create_ad", { request: input }, () => createAdRaw(ctx, input), (r) => r.ad_id);
}

/** Phase 2: new creative + ad inside an existing ad set, in one call (PAUSED). */
export async function addAdToAdset(
  ctx: CoreContext,
  input: { adset_id: string; name: string; creative_id?: string; creative?: CreativeInput },
) {
  return audited(ctx, "add_ad_to_adset", { request: input }, async () => {
    let creativeId = input.creative_id;
    if (!creativeId) {
      if (!input.creative) throw new UserInputError("Give creative_id or a new creative.");
      const resolved = await resolveCreative(ctx, input.creative);
      creativeId = (await createCreativeRaw(ctx, resolved, input.creative.image_url ?? input.creative.video_url)).creative_id;
    }
    return createAdRaw(ctx, { adset_id: input.adset_id, creative_id: creativeId, name: input.name });
  }, (r) => r.ad_id);
}

async function ensureAdSetMirrored(ctx: CoreContext, adsetId: string) {
  const exists = await ctx.db.adSet.findUnique({ where: { id: adsetId }, select: { id: true } });
  if (exists) return;
  const currency = await getCurrency(ctx);
  const adset = await ctx.meta.get<any>(adsetId, { fields: ADSET_FIELDS });
  const campaignExists = await ctx.db.campaign.findUnique({ where: { id: adset.campaign_id }, select: { id: true } });
  if (!campaignExists) {
    const c = await ctx.meta.get<any>(adset.campaign_id, { fields: CAMPAIGN_FIELDS });
    await mirrorCampaign(ctx, c, currency);
  }
  await mirrorAdSet(ctx, adset, currency);
}

// ---------------------------------------------------------------- reads

const STATUS_FILTERS: Record<string, string[] | undefined> = {
  ACTIVE: ["ACTIVE"],
  PAUSED: ["PAUSED", "CAMPAIGN_PAUSED", "ADSET_PAUSED"],
  ARCHIVED: ["ARCHIVED"],
  IN_REVIEW: ["IN_PROCESS", "PENDING_REVIEW", "PREAPPROVED"],
  ISSUES: ["DISAPPROVED", "WITH_ISSUES", "PENDING_BILLING_INFO"],
  ALL: undefined,
};

export async function listCampaigns(ctx: CoreContext, status: keyof typeof STATUS_FILTERS = "ALL", limit = 100) {
  const currency = await getCurrency(ctx);
  const filter = STATUS_FILTERS[status];
  const rows = await ctx.meta.getAll<any>(`${ctx.config.META_AD_ACCOUNT_ID}/campaigns`, {
    fields: CAMPAIGN_FIELDS,
    ...(filter ? { effective_status: filter } : {}),
  }, limit);
  for (const c of rows) {
    rememberOwned(ctx, c.id, "campaign");
    await mirrorCampaign(ctx, c, currency);
  }
  return rows.map((c) => ({
    id: c.id,
    name: c.name,
    objective: c.objective,
    status: c.status,
    effective_status: c.effective_status,
    daily_budget: fromMinorUnits(c.daily_budget, currency),
    lifetime_budget: fromMinorUnits(c.lifetime_budget, currency),
    created_time: c.created_time ?? null,
  }));
}

export async function getCampaignTree(ctx: CoreContext, campaignId: string) {
  const type = await resolveOwnedObject(ctx, campaignId);
  if (type !== "campaign" && type !== "unknown") throw new UserInputError(`${campaignId} is a ${type}, not a campaign.`);
  const currency = await getCurrency(ctx);
  const [campaign, adsets, ads] = await Promise.all([
    ctx.meta.get<any>(campaignId, { fields: `${CAMPAIGN_FIELDS},issues_info` }),
    ctx.meta.getAll<any>(`${campaignId}/adsets`, { fields: `${ADSET_FIELDS},issues_info` }, 500),
    ctx.meta.getAll<any>(`${campaignId}/ads`, { fields: `${AD_FIELDS},${REVIEW_FIELDS}` }, 500),
  ]);
  await mirrorCampaign(ctx, campaign, currency);
  for (const s of adsets) {
    rememberOwned(ctx, s.id, "adset");
    await mirrorAdSet(ctx, s, currency);
  }
  for (const a of ads) {
    rememberOwned(ctx, a.id, "ad");
    if (adsets.some((s) => s.id === a.adset_id)) await mirrorAd(ctx, a);
  }
  return {
    id: campaign.id,
    name: campaign.name,
    objective: campaign.objective,
    status: campaign.status,
    effective_status: campaign.effective_status,
    daily_budget: fromMinorUnits(campaign.daily_budget, currency),
    issues: reviewOf(campaign)?.reasons ?? [],
    adsets: adsets.map((s) => ({
      id: s.id,
      name: s.name,
      status: s.status,
      effective_status: s.effective_status,
      daily_budget: fromMinorUnits(s.daily_budget, currency),
      optimization_goal: s.optimization_goal,
      destination_type: s.destination_type ?? null,
      bid_strategy: s.bid_strategy ?? null,
      bid_amount: fromMinorUnits(s.bid_amount, currency),
      attribution_spec: s.attribution_spec ?? null,
      start_time: s.start_time ?? null,
      end_time: s.end_time ?? null,
      issues: reviewOf(s)?.reasons ?? [],
      placements: describePlacements(s.targeting),
      targeting: s.targeting,
      ads: ads
        .filter((a) => a.adset_id === s.id)
        .map((a) => ({
          id: a.id,
          name: a.name,
          status: a.status,
          effective_status: a.effective_status,
          review: reviewOf(a),
          creative: a.creative
            ? { id: a.creative.id, name: a.creative.name ?? null, thumbnail_url: a.creative.thumbnail_url ?? null }
            : null,
        })),
    })),
  };
}

/** Reads one campaign / ad set / ad with the fields needed for status & budget changes. */
export async function readObject(ctx: CoreContext, id: string) {
  const type = await resolveOwnedObject(ctx, id);
  const fields =
    type === "campaign" ? CAMPAIGN_FIELDS : type === "adset" ? ADSET_FIELDS : type === "ad" ? AD_FIELDS : "id,name,status";
  const obj = await ctx.meta.get<any>(id, { fields });
  return { type, obj };
}

