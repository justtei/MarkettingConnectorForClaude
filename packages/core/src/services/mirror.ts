/** Keeps the Postgres mirror of Meta objects up to date after creates, edits and syncs. */
import type { CoreContext } from "../context.js";
import { fromMinorUnits } from "../meta/money.js";

export const CAMPAIGN_FIELDS =
  "id,name,objective,status,effective_status,daily_budget,lifetime_budget,created_time,start_time,stop_time,buying_type";
export const ADSET_FIELDS =
  "id,name,campaign_id,status,effective_status,daily_budget,lifetime_budget,targeting,destination_type,optimization_goal,billing_event,bid_strategy,bid_amount,attribution_spec,promoted_object,is_dynamic_creative,start_time,end_time";
export const AD_FIELDS =
  "id,name,adset_id,campaign_id,status,effective_status,creative{id,name,thumbnail_url,object_type,title,body,image_hash,video_id,object_story_spec,asset_feed_spec}";

function int(n: number | null): number | null {
  return n === null ? null : Math.round(n);
}

export async function mirrorCampaign(ctx: CoreContext, c: any, currency: string, createdVia?: string) {
  const data = {
    name: c.name ?? "",
    objective: c.objective ?? "",
    status: c.status ?? "PAUSED",
    effectiveStatus: c.effective_status ?? null,
    dailyBudget: int(fromMinorUnits(c.daily_budget, currency)),
  };
  await ctx.db.campaign.upsert({
    where: { id: c.id },
    create: { id: c.id, ...data, createdVia: createdVia ?? "ads_manager" },
    update: data,
  });
}

export async function mirrorAdSet(ctx: CoreContext, s: any, currency: string) {
  const data = {
    campaignId: s.campaign_id,
    name: s.name ?? "",
    status: s.status ?? "PAUSED",
    effectiveStatus: s.effective_status ?? null,
    dailyBudget: int(fromMinorUnits(s.daily_budget, currency)),
    targeting: (s.targeting ?? {}) as object,
    destination: s.destination_type ?? null,
    optimization: s.optimization_goal ?? null,
  };
  await ctx.db.adSet.upsert({ where: { id: s.id }, create: { id: s.id, ...data }, update: data });
}

export function creativeSummary(cr: any): {
  type: string;
  mediaRef: string | null;
  headline: string | null;
  primaryText: string | null;
} {
  const oss = cr?.object_story_spec ?? {};
  const link = oss.link_data;
  const video = oss.video_data;
  // A real dynamic creative keeps its media in asset_feed_spec. Multi-destination and text-version creatives
  // keep media in object_story_spec and only add buttons / texts there, so they fall through to video / image.
  if (cr?.asset_feed_spec && !video && !link) {
    const f = cr.asset_feed_spec;
    return {
      type: "dynamic",
      mediaRef: f.images?.[0]?.hash ?? f.videos?.[0]?.video_id ?? null,
      headline: f.titles?.[0]?.text ?? null,
      primaryText: f.bodies?.[0]?.text ?? null,
    };
  }
  if (oss.template_data) {
    return { type: "catalog", mediaRef: cr.product_set_id ?? null, headline: oss.template_data.name ?? null, primaryText: oss.template_data.message ?? null };
  }
  if (video) {
    return { type: "video", mediaRef: video.video_id ?? null, headline: video.title ?? null, primaryText: video.message ?? null };
  }
  if (link?.child_attachments?.length) {
    return {
      type: "carousel",
      mediaRef: link.child_attachments[0]?.image_hash ?? null,
      headline: link.child_attachments[0]?.name ?? null,
      primaryText: link.message ?? null,
    };
  }
  if (link) {
    return { type: "image", mediaRef: link.image_hash ?? null, headline: link.name ?? null, primaryText: link.message ?? null };
  }
  if (cr?.source_instagram_media_id || cr?.object_type === "INSTAGRAM_MEDIA") {
    return { type: "instagram_post", mediaRef: cr.source_instagram_media_id ?? null, headline: cr.title ?? null, primaryText: cr.body ?? null };
  }
  return {
    type: cr?.video_id ? "video" : "image",
    mediaRef: cr?.video_id ?? cr?.image_hash ?? null,
    headline: cr?.title ?? null,
    primaryText: cr?.body ?? null,
  };
}

export async function mirrorCreative(ctx: CoreContext, cr: any, extra: { sourceUrl?: string | null } = {}) {
  if (!cr?.id) return;
  const s = creativeSummary(cr);
  const data = {
    name: cr.name ?? null,
    type: s.type,
    mediaRef: s.mediaRef,
    headline: s.headline,
    primaryText: s.primaryText,
    thumbnailUrl: cr.thumbnail_url ?? null,
    ...(extra.sourceUrl !== undefined ? { sourceUrl: extra.sourceUrl } : {}),
  };
  await ctx.db.creative.upsert({ where: { id: cr.id }, create: { id: cr.id, ...data }, update: data });
}

export async function mirrorAd(ctx: CoreContext, a: any) {
  if (a.creative?.id) await mirrorCreative(ctx, a.creative);
  const data = {
    adSetId: a.adset_id,
    name: a.name ?? "",
    status: a.status ?? "PAUSED",
    effectiveStatus: a.effective_status ?? null,
    creativeId: a.creative?.id ?? null,
  };
  await ctx.db.ad.upsert({ where: { id: a.id }, create: { id: a.id, ...data }, update: data });
}

/** Makes sure an ad (and its ad set + campaign) exists in the mirror, fetching from Meta if needed. */
export async function ensureAdMirrored(ctx: CoreContext, adId: string, currency: string): Promise<boolean> {
  const existing = await ctx.db.ad.findUnique({ where: { id: adId }, select: { id: true } });
  if (existing) return true;
  const ad = await ctx.meta.get<any>(adId, { fields: `${AD_FIELDS},account_id` });
  if (String(ad.account_id ?? "").replace(/^act_/, "") !== ctx.config.META_AD_ACCOUNT_ID.replace(/^act_/, "")) {
    return false;
  }
  const [campaign, adset] = await Promise.all([
    ctx.meta.get<any>(ad.campaign_id, { fields: CAMPAIGN_FIELDS }),
    ctx.meta.get<any>(ad.adset_id, { fields: ADSET_FIELDS }),
  ]);
  await mirrorCampaign(ctx, campaign, currency);
  await mirrorAdSet(ctx, adset, currency);
  await mirrorAd(ctx, ad);
  return true;
}

/** Updates the status columns of whichever mirrored object has this ID. */
export async function mirrorStatus(ctx: CoreContext, id: string, status: string) {
  await Promise.all([
    ctx.db.campaign.updateMany({ where: { id }, data: { status, effectiveStatus: status } }),
    ctx.db.adSet.updateMany({ where: { id }, data: { status, effectiveStatus: status } }),
    ctx.db.ad.updateMany({ where: { id }, data: { status, effectiveStatus: status } }),
  ]);
}
