/**
 * create_ctwa_campaign: upload media -> campaign -> ad set -> creative(s) -> ad(s), all PAUSED.
 * If any Meta step fails, everything created so far is deleted (rollback) and the error is returned.
 */
import type { z } from "zod";
import { audited } from "../audit.js";
import type { CoreContext } from "../context.js";
import { checkDailyBudget, UserInputError } from "../guards.js";
import { describeError } from "../meta/errors.js";
import type { adsetDestination, createCtwaInput } from "../schemas.js";
import { getCurrency } from "./account.js";
import { getVideoThumbnail, uploadImage, uploadVideo, waitForVideoReady } from "./assets.js";
import { createAdRaw, createAdsetRaw, createCampaignRaw, createCreativeRaw } from "./campaigns.js";
import { destinationTypeForApps, sortApps, type MessagingApp, type ResolvedCreative } from "./creative-payload.js";
import { getSettings } from "./settings.js";
import { resolveCityKey } from "./targeting.js";

type CtwaInput = z.input<typeof createCtwaInput>;
type CreateAdsetDestination = z.input<typeof adsetDestination>;

interface Created {
  type: "campaign" | "adset" | "creative" | "ad";
  id: string;
}

export async function createCtwaCampaign(ctx: CoreContext, input: CtwaInput) {
  return audited(ctx, "create_ctwa_campaign", { request: input }, () => run(ctx, input), (r) => r.campaign_id);
}

async function run(ctx: CoreContext, input: CtwaInput) {
  // ---- pre-flight checks (no Meta writes yet)
  if (!ctx.config.META_PAGE_ID) throw new UserInputError("META_PAGE_ID is not configured; click-to-WhatsApp needs the Page.");
  const apps: MessagingApp[] = sortApps(input.messaging_apps?.length ? input.messaging_apps : ["whatsapp"]);
  if (apps.includes("whatsapp") && !ctx.config.WHATSAPP_PHONE_NUMBER) throw new UserInputError("WHATSAPP_PHONE_NUMBER is not configured.");
  if (apps.includes("instagram_direct") && !ctx.config.META_INSTAGRAM_USER_ID) {
    throw new UserInputError("META_INSTAGRAM_USER_ID is not configured; Instagram DMs need the Instagram account.");
  }
  const settings = await getSettings(ctx);
  checkDailyBudget(settings, input.daily_budget);
  await getCurrency(ctx);

  const ageMin = input.age_min ?? settings.defaultAgeMin;
  const ageMax = input.age_max ?? settings.defaultAgeMax;
  if (ageMin > ageMax) throw new UserInputError(`age_min (${ageMin}) is greater than age_max (${ageMax}).`);
  const gender = input.gender ?? settings.defaultGender;

  let cityKey = input.city_key;
  let cityName = input.city ?? settings.defaultCityName ?? undefined;
  if (!cityKey) {
    if (!input.city && settings.defaultCityKey) {
      cityKey = settings.defaultCityKey;
    } else {
      if (!cityName) throw new UserInputError("Give a city (e.g. Karachi).");
      const c = await resolveCityKey(ctx, cityName);
      cityKey = c.key;
      cityName = c.name;
    }
  }

  for (const [i, c] of input.creatives.entries()) {
    if (c.type === "image" && !c.image_hash && !c.image_url) throw new UserInputError(`Creative ${i + 1}: give image_url or image_hash.`);
    if (c.type === "video" && !c.video_id && !c.video_url) throw new UserInputError(`Creative ${i + 1}: give video_url or video_id.`);
    if (!(c.primary_text ?? input.primary_text)) throw new UserInputError(`Creative ${i + 1}: give primary_text (or a default primary_text).`);
  }

  // ---- step 1: upload media (not rolled back: harmless and reusable)
  const steps: string[] = [];
  const media: { image_hash?: string; video_id?: string; thumbnail_hash?: string; thumbnail_url?: string; source?: string }[] = [];
  for (const c of input.creatives) {
    if (c.type === "image") {
      const hash = c.image_hash ?? (await uploadImage(ctx, { url: c.image_url!, name: c.name })).image_hash;
      media.push({ image_hash: hash, source: c.image_url });
    } else {
      const videoId = c.video_id ?? (await uploadVideo(ctx, { url: c.video_url!, name: c.name })).video_id;
      await waitForVideoReady(ctx, videoId);
      let thumbHash = c.thumbnail_hash;
      if (!thumbHash && c.thumbnail_url) thumbHash = (await uploadImage(ctx, { url: c.thumbnail_url })).image_hash;
      const thumbUrl = thumbHash ? undefined : (await getVideoThumbnail(ctx, videoId)) ?? undefined;
      if (!thumbHash && !thumbUrl) throw new UserInputError(`No thumbnail available for video ${videoId}; give thumbnail_url.`);
      media.push({ video_id: videoId, thumbnail_hash: thumbHash, thumbnail_url: thumbUrl, source: c.video_url });
    }
  }
  steps.push(`uploaded ${media.length} media file(s)`);

  // ---- steps 2-5 with rollback
  const created: Created[] = [];
  try {
    const campaign = await createCampaignRaw(ctx, { name: input.name, objective: input.objective ?? "OUTCOME_ENGAGEMENT", special_ad_categories: [] });
    created.push({ type: "campaign", id: campaign.campaign_id });
    steps.push(`campaign ${campaign.campaign_id}`);

    const adsetName = input.adset_name ?? `${input.name} | ${cityName ?? "City"} ${genderLabel(gender)} ${ageMin}-${ageMax}`;
    const adset = await createAdsetRaw(ctx, {
      campaign_id: campaign.campaign_id,
      name: adsetName,
      daily_budget: input.daily_budget,
      destination: destinationTypeForApps(apps) as CreateAdsetDestination,
      optimization_goal: "CONVERSATIONS",
      billing_event: "IMPRESSIONS",
      bid_strategy: "LOWEST_COST_WITHOUT_CAP",
      targeting: {
        city_keys: [cityKey!],
        radius_km: input.radius_km,
        location_types: ["home", "recent"],
        age_min: ageMin,
        age_max: ageMax,
        gender,
        interests: input.interests,
        // Advantage+ audience cannot hold a minimum age above 25, so a stricter age turns it off.
        advantage_audience: input.advantage_audience ?? ageMin <= 25,
      },
    });
    created.push({ type: "adset", id: adset.adset_id });
    steps.push(`ad set ${adset.adset_id}`);

    const ads: { ad_id: string; creative_id: string; name: string; format: string }[] = [];
    for (const [i, c] of input.creatives.entries()) {
      const m = media[i]!;
      const name = c.name ?? `${input.name} - ${c.type} ${i + 1}`;
      const resolved: ResolvedCreative = {
        name,
        format: c.type,
        destination: apps[0]!,
        messaging_apps: apps,
        page_id: ctx.config.META_PAGE_ID,
        instagram_user_id: ctx.config.META_INSTAGRAM_USER_ID,
        image_hash: m.image_hash,
        video_id: m.video_id,
        thumbnail_hash: m.thumbnail_hash,
        thumbnail_url: m.thumbnail_url,
        headline: c.headline ?? input.headline,
        primary_text: c.primary_text ?? input.primary_text,
        primary_texts: c.primary_texts ?? input.primary_texts,
        headlines: c.headlines ?? input.headlines,
        creative_features: input.creative_features,
        welcome: {
          welcome_message: input.welcome_message,
          autofill_message: input.autofill_message,
          icebreakers: input.icebreakers,
        },
      };
      const creative = await createCreativeRaw(ctx, resolved, m.source);
      created.push({ type: "creative", id: creative.creative_id });
      const ad = await createAdRaw(ctx, { adset_id: adset.adset_id, creative_id: creative.creative_id, name });
      created.push({ type: "ad", id: ad.ad_id });
      ads.push({ ad_id: ad.ad_id, creative_id: creative.creative_id, name, format: c.type });
      steps.push(`creative ${creative.creative_id} + ad ${ad.ad_id}`);
    }

    return {
      campaign_id: campaign.campaign_id,
      adset_id: adset.adset_id,
      ads,
      status: "PAUSED" as const,
      daily_budget_pkr: input.daily_budget,
      messaging_apps: apps,
      targeting_summary: { city: cityName ?? cityKey, city_key: cityKey, age_min: ageMin, age_max: ageMax, gender },
      steps,
      next_step:
        "Everything is PAUSED. Review it in Ads Manager, then activate with set_status(object_id=<campaign_id>, status=ACTIVE, confirm=true) after the user confirms.",
    };
  } catch (err) {
    const rollback = await rollbackCreated(ctx, created);
    const d = describeError(err);
    const e = new Error(
      `Click-to-WhatsApp campaign failed while creating the ${stepName(created)}: ${d.message} ` +
        `Rollback: ${rollback.deleted.length} object(s) deleted${rollback.failed.length ? `, ${rollback.failed.length} could not be deleted (${rollback.failed.map((f) => `${f.type} ${f.id}`).join(", ")}) — pause/delete them in Ads Manager` : ""}.`,
    );
    (e as any).details = { ...d.details, rollback };
    throw e;
  }
}

function stepName(created: Created[]): string {
  const last = created[created.length - 1]?.type;
  if (!last) return "campaign";
  if (last === "campaign") return "ad set";
  if (last === "adset" || last === "ad") return "creative";
  return "ad";
}

/** Deletes created objects in reverse order. Internal use only — no delete tool is exposed. */
export async function rollbackCreated(ctx: CoreContext, created: Created[]) {
  const deleted: Created[] = [];
  const failed: (Created & { error: string })[] = [];
  for (const obj of [...created].reverse()) {
    try {
      await ctx.meta.delete(obj.id);
      deleted.push(obj);
      if (obj.type === "ad") await ctx.db.ad.deleteMany({ where: { id: obj.id } });
      if (obj.type === "adset") await ctx.db.adSet.deleteMany({ where: { id: obj.id } });
      if (obj.type === "campaign") await ctx.db.campaign.deleteMany({ where: { id: obj.id } });
      if (obj.type === "creative") await ctx.db.creative.deleteMany({ where: { id: obj.id } });
    } catch (err) {
      failed.push({ ...obj, error: describeError(err).message });
    }
  }
  ctx.log.warn({ deleted, failed }, "create_ctwa_campaign rolled back");
  return { deleted, failed };
}

function genderLabel(g: string): string {
  return g === "female" ? "Women" : g === "male" ? "Men" : "All";
}
