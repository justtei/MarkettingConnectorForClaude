/**
 * Reading a creative in full (to build a new version of a winning ad), and editing existing ads and ad sets:
 * rename / swap creative, bid strategy and cost cap, attribution window, schedule.
 */
import { audited } from "../audit.js";
import type { CoreContext } from "../context.js";
import { requireConfirm, resolveOwnedObject, UserInputError } from "../guards.js";
import { fromMinorUnits, toMinorUnits } from "../meta/money.js";
import { getCurrency } from "./account.js";
import { checkCreativeFitsAdset } from "./campaigns.js";
import { appsForCreative, RETIRED_CREATIVE_FEATURES, type MessagingApp } from "./creative-payload.js";
import { ADSET_FIELDS, mirrorAdSet } from "./mirror.js";

const CREATIVE_READ_FIELDS =
  "id,name,status,object_type,thumbnail_url,image_url,image_hash,video_id,object_story_spec,asset_feed_spec," +
  "degrees_of_freedom_spec,effective_object_story_id,effective_instagram_media_id,instagram_permalink_url,url_tags," +
  "call_to_action_type,source_instagram_media_id,product_set_id";

function parseWelcome(raw: unknown) {
  if (!raw) return null;
  let w: any = raw;
  if (typeof raw === "string") {
    try {
      w = JSON.parse(raw);
    } catch {
      return { text: raw, icebreakers: [], autofill_message: null, quick_replies: [] };
    }
  }
  const msg = w?.text_format?.message ?? {};
  return {
    text: msg.text ?? null,
    icebreakers: (msg.ice_breakers ?? []).map((i: any) => i?.title).filter(Boolean),
    autofill_message: msg.autofill_message?.content ?? null,
    quick_replies: (msg.quick_replies ?? []).map((q: any) => q?.title).filter(Boolean),
  };
}

/** Everything needed to understand or rebuild an ad's creative. Give creative_id, or ad_id to read the ad's creative. */
export async function getCreative(ctx: CoreContext, input: { creative_id?: string; ad_id?: string }) {
  let creativeId = input.creative_id;
  let ad: { id: string; name: string; adset_id: string; status: string } | null = null;
  if (!creativeId) {
    if (!input.ad_id) throw new UserInputError("Give creative_id or ad_id.");
    const type = await resolveOwnedObject(ctx, input.ad_id);
    if (type !== "ad") throw new UserInputError(`${input.ad_id} is a ${type}, not an ad.`);
    const a = await ctx.meta.get<any>(input.ad_id, { fields: "id,name,adset_id,status,creative{id}" });
    ad = { id: a.id, name: a.name, adset_id: a.adset_id, status: a.status };
    creativeId = a.creative?.id;
    if (!creativeId) throw new UserInputError(`Ad ${input.ad_id} has no creative.`);
  } else {
    const type = await resolveOwnedObject(ctx, creativeId);
    if (type !== "adcreative" && type !== "unknown") throw new UserInputError(`${creativeId} is a ${type}, not a creative.`);
  }
  const cr = await ctx.meta.get<any>(creativeId!, { fields: CREATIVE_READ_FIELDS });
  const oss = cr.object_story_spec ?? {};
  const video = oss.video_data;
  const link = oss.link_data;
  const feed = cr.asset_feed_spec;
  const format = video
    ? "video"
    : link?.child_attachments?.length
      ? "carousel"
      : link
        ? "image"
        : cr.source_instagram_media_id
          ? "instagram_post"
          : feed?.images?.length || feed?.videos?.length
            ? "dynamic"
            : String(cr.object_type ?? "unknown").toLowerCase();
  const main = video ?? link ?? {};
  const apps = appsForCreative(cr);
  const texts = (list: any[] | undefined) => (list ?? []).map((t) => t?.text).filter(Boolean) as string[];
  const bodies = texts(feed?.bodies);
  const titles = texts(feed?.titles);
  const features: Record<string, string> = {};
  for (const [k, v] of Object.entries(cr.degrees_of_freedom_spec?.creative_features_spec ?? {})) features[k] = String((v as any)?.enroll_status ?? v);
  const welcome = parseWelcome(main.page_welcome_message);
  const primaryText = main.message ?? bodies[0] ?? null;
  const headline = main.title ?? main.name ?? titles[0] ?? null;

  const asNewCreative: Record<string, unknown> = {
    name: `${cr.name ?? "Creative"} v2`,
    format: format === "carousel" || format === "instagram_post" || format === "dynamic" ? format : format === "video" ? "video" : "image",
    ...(apps.length > 1 ? { messaging_apps: apps } : { destination: apps[0] ?? (main.call_to_action ? "website" : "whatsapp") }),
    ...(video ? { video_id: video.video_id, ...(video.image_hash ? { thumbnail_hash: video.image_hash } : { thumbnail_url: video.image_url }) } : {}),
    ...(link && !link.child_attachments ? { image_hash: link.image_hash } : {}),
    ...(link?.child_attachments
      ? { cards: link.child_attachments.map((c: any) => ({ image_hash: c.image_hash, video_id: c.video_id, headline: c.name, description: c.description, link: c.link })) }
      : {}),
    ...(cr.source_instagram_media_id ? { instagram_media_id: cr.source_instagram_media_id } : {}),
    ...(primaryText ? { primary_text: primaryText } : {}),
    ...(bodies.length > 1 ? { primary_texts: bodies.filter((b) => b !== primaryText) } : {}),
    ...(headline ? { headline } : {}),
    ...(titles.length > 1 ? { headlines: titles.filter((t) => t !== headline) } : {}),
    ...((main.link_description ?? main.description) ? { description: main.link_description ?? main.description } : {}),
    ...(apps.length === 0 && main.link && !String(main.link).includes("api.whatsapp.com") ? { link: main.link, cta_type: main.call_to_action?.type } : {}),
    ...(welcome?.text ? { welcome_message: welcome.text } : {}),
    ...(welcome?.icebreakers.length ? { icebreakers: welcome.icebreakers.slice(0, 4) } : {}),
    ...(welcome?.autofill_message ? { autofill_message: welcome.autofill_message } : {}),
    ...(Object.keys(features).length
      ? {
          creative_features: Object.fromEntries(
            Object.entries(features)
              .filter(([k]) => !RETIRED_CREATIVE_FEATURES.has(k))
              .map(([k, v]) => [k, v === "OPT_IN"]),
          ),
        }
      : {}),
  };

  return {
    creative_id: cr.id,
    name: cr.name ?? null,
    ad,
    format,
    media: {
      video_id: video?.video_id ?? cr.video_id ?? null,
      image_hash: link?.image_hash ?? cr.image_hash ?? null,
      thumbnail_hash: video?.image_hash ?? null,
      thumbnail_url: cr.thumbnail_url ?? video?.image_url ?? null,
      cards: link?.child_attachments?.length ?? 0,
    },
    primary_text: primaryText,
    headline,
    description: main.link_description ?? main.description ?? null,
    text_versions: { primary_texts: bodies, headlines: titles, descriptions: texts(feed?.descriptions) },
    buttons: {
      messaging_apps: apps as MessagingApp[],
      main: main.call_to_action ?? null,
      all: feed?.call_to_actions ?? (main.call_to_action ? [main.call_to_action] : []),
      multi_destination: feed?.optimization_type === "DOF_MESSAGING_DESTINATION",
    },
    welcome_message: welcome,
    creative_features: features,
    retired_features: Object.keys(features).filter((k) => RETIRED_CREATIVE_FEATURES.has(k)),
    post: {
      facebook_post_id: cr.effective_object_story_id ?? null,
      instagram_media_id: cr.effective_instagram_media_id ?? cr.source_instagram_media_id ?? null,
      instagram_permalink: cr.instagram_permalink_url ?? null,
    },
    url_tags: cr.url_tags ?? null,
    as_new_creative: asNewCreative,
    note: "as_new_creative is ready for create_creative / add_ad_to_adset: change the parts you want (e.g. the text or video) and keep the rest.",
  };
}

/** Rename an ad and/or swap its creative. Swapping the creative of an active ad sends it back to review, so that needs confirm. */
export async function updateAd(ctx: CoreContext, input: { ad_id: string; name?: string; creative_id?: string; confirm?: boolean }) {
  const type = await resolveOwnedObject(ctx, input.ad_id);
  if (type !== "ad") throw new UserInputError(`${input.ad_id} is a ${type}, not an ad.`);
  if (input.name === undefined && input.creative_id === undefined) throw new UserInputError("Nothing to change: give name and/or creative_id.");
  const ad = await ctx.meta.get<any>(input.ad_id, { fields: "id,name,adset_id,status,effective_status,creative{id}" });
  if (input.creative_id) {
    if (input.creative_id === ad.creative?.id) throw new UserInputError("The ad already uses this creative.");
    await checkCreativeFitsAdset(ctx, ad.adset_id, input.creative_id);
    if (ad.status === "ACTIVE") {
      requireConfirm(input.confirm, `swap the creative of active ad "${ad.name}" (${ad.id}) to ${input.creative_id}; the ad goes back into review and its learning restarts`);
    }
  }
  const before = { name: ad.name, creative_id: ad.creative?.id ?? null, status: ad.status };
  return audited(ctx, "update_ad", { objectId: ad.id, request: input, before }, async () => {
    const params: Record<string, unknown> = {};
    if (input.name !== undefined) params.name = input.name;
    if (input.creative_id) params.creative = { creative_id: input.creative_id };
    await ctx.meta.post(ad.id, params);
    await ctx.db.ad.updateMany({
      where: { id: ad.id },
      data: { ...(input.name !== undefined ? { name: input.name } : {}), ...(input.creative_id ? { creativeId: null } : {}) },
    });
    return {
      ad_id: ad.id,
      name: input.name ?? ad.name,
      creative_id: input.creative_id ?? ad.creative?.id ?? null,
      previous_creative_id: before.creative_id,
      ...(input.creative_id && ad.status === "ACTIVE" ? { note: "The ad is back in Meta's review; it delivers again once approved." } : {}),
    };
  });
}

export interface UpdateAdsetInput {
  adset_id: string;
  name?: string;
  bid_strategy?: "LOWEST_COST_WITHOUT_CAP" | "LOWEST_COST_WITH_BID_CAP" | "COST_CAP";
  bid_amount?: number;
  attribution?: { click_days: 1 | 7; view_days?: 0 | 1; engaged_view_days?: 0 | 1 };
  start_time?: string;
  end_time?: string | null;
  confirm?: boolean;
}

/** Non-targeting ad set settings. Anything beyond a rename changes delivery, so it needs confirm. */
export async function updateAdset(ctx: CoreContext, input: UpdateAdsetInput) {
  const type = await resolveOwnedObject(ctx, input.adset_id);
  if (type !== "adset") throw new UserInputError(`${input.adset_id} is a ${type}, not an ad set.`);
  const keys = (["name", "bid_strategy", "bid_amount", "attribution", "start_time", "end_time"] as const).filter((k) => input[k] !== undefined);
  if (!keys.length) throw new UserInputError("Nothing to change.");
  const currency = await getCurrency(ctx);
  const s = await ctx.meta.get<any>(input.adset_id, { fields: `${ADSET_FIELDS},campaign{id,name,daily_budget,lifetime_budget,bid_strategy}` });
  const campaignBudget = Number(s.campaign?.daily_budget ?? 0) > 0 || Number(s.campaign?.lifetime_budget ?? 0) > 0;
  const nextStrategy = input.bid_strategy ?? (campaignBudget ? s.campaign?.bid_strategy : s.bid_strategy) ?? "LOWEST_COST_WITHOUT_CAP";
  const nextAmount = input.bid_amount ?? fromMinorUnits(s.bid_amount, currency);
  if (nextStrategy !== "LOWEST_COST_WITHOUT_CAP" && !nextAmount) {
    throw new UserInputError(`${nextStrategy} needs bid_amount: the PKR you want to pay per result (e.g. your target cost per chat).`);
  }
  if (input.end_time && Date.parse(input.end_time) <= Date.now()) throw new UserInputError("end_time must be in the future.");
  if (input.start_time && input.end_time && Date.parse(input.end_time) <= Date.parse(input.start_time)) {
    throw new UserInputError("end_time must be after start_time.");
  }
  if (keys.some((k) => k !== "name")) {
    const parts = keys.filter((k) => k !== "name").map((k) => (k === "bid_amount" ? `bid_amount PKR ${input.bid_amount}` : k === "attribution" ? `attribution ${JSON.stringify(input.attribution)}` : `${k} ${String(input[k])}`));
    requireConfirm(input.confirm, `change ad set "${s.name}" (${s.id}): ${parts.join(", ")}`);
  }

  const adsetParams: Record<string, unknown> = {};
  const campaignParams: Record<string, unknown> = {};
  if (input.name !== undefined) adsetParams.name = input.name;
  if (input.bid_strategy) {
    // With a campaign budget, the bid strategy belongs to the campaign (it then applies to all its ad sets).
    if (campaignBudget) campaignParams.bid_strategy = input.bid_strategy;
    else adsetParams.bid_strategy = input.bid_strategy;
  }
  if (input.bid_amount !== undefined) adsetParams.bid_amount = toMinorUnits(input.bid_amount, currency);
  if (input.attribution) {
    adsetParams.attribution_spec = [
      { event_type: "CLICK_THROUGH", window_days: input.attribution.click_days },
      ...(input.attribution.view_days ? [{ event_type: "VIEW_THROUGH", window_days: input.attribution.view_days }] : []),
      ...(input.attribution.engaged_view_days ? [{ event_type: "ENGAGED_VIDEO_VIEW", window_days: input.attribution.engaged_view_days }] : []),
    ];
  }
  if (input.start_time) adsetParams.start_time = input.start_time;
  if (input.end_time !== undefined) adsetParams.end_time = input.end_time ?? 0;

  const before = {
    name: s.name,
    bid_strategy: campaignBudget ? s.campaign?.bid_strategy ?? null : s.bid_strategy ?? null,
    bid_amount: fromMinorUnits(s.bid_amount, currency),
    attribution_spec: s.attribution_spec ?? null,
    start_time: s.start_time ?? null,
    end_time: s.end_time ?? null,
  };
  return audited(ctx, "update_adset", { objectId: s.id, request: input, before }, async () => {
    if (Object.keys(campaignParams).length) await ctx.meta.post(s.campaign.id, campaignParams);
    if (Object.keys(adsetParams).length) await ctx.meta.post(s.id, adsetParams);
    const after = await ctx.meta.get<any>(s.id, { fields: ADSET_FIELDS });
    await mirrorAdSet(ctx, after, currency);
    return {
      adset_id: s.id,
      name: after.name,
      bid_strategy: campaignBudget ? input.bid_strategy ?? before.bid_strategy : after.bid_strategy ?? null,
      bid_amount: fromMinorUnits(after.bid_amount, currency),
      attribution_spec: after.attribution_spec ?? null,
      start_time: after.start_time ?? null,
      end_time: after.end_time ?? null,
      previous: before,
      ...(campaignParams.bid_strategy ? { note: `The campaign "${s.campaign.name}" uses a campaign budget, so the bid strategy was set on the campaign (all its ad sets).` } : {}),
    };
  });
}
