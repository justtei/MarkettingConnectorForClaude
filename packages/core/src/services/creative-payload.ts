/**
 * Pure builders for Meta ad creative payloads (no I/O), so the exact payloads can be unit-tested
 * and kept as fixtures. Field placement follows Meta's click-to-WhatsApp guide:
 * page_welcome_message is an object inside link_data / video_data (current guide, checked October 2026).
 * The client form-encodes object_story_spec as JSON, so the welcome message is nested JSON, not a string.
 */

export const WHATSAPP_LINK = "https://api.whatsapp.com/send";

export const DEFAULT_WELCOME = "Assalam o Alaikum! Sandalez mein khush aamdeed.";
export const DEFAULT_AUTOFILL = "Hi Sandalez! Mujhe yeh design chahiye. Size:";

export interface WelcomeOptions {
  welcome_message?: string;
  autofill_message?: string;
  icebreakers?: string[];
}

/** The page_welcome_message object (visual editor v2). Icebreakers take precedence over autofill. */
export function buildWelcomeMessage(o: WelcomeOptions): Record<string, unknown> {
  const text = o.welcome_message?.trim() || DEFAULT_WELCOME;
  if (o.icebreakers?.length) {
    return {
      type: "VISUAL_EDITOR",
      version: 2,
      landing_screen_type: "welcome_message",
      media_type: "text",
      text_format: {
        customer_action_type: "ice_breakers",
        message: {
          text,
          ice_breakers: o.icebreakers.slice(0, 4).map((title) => ({ title })),
        },
      },
    };
  }
  return {
    type: "VISUAL_EDITOR",
    version: 2,
    landing_screen_type: "welcome_message",
    media_type: "text",
    text_format: {
      customer_action_type: "autofill_message",
      message: {
        text,
        autofill_message: { content: o.autofill_message?.trim() || DEFAULT_AUTOFILL },
      },
    },
  };
}

export function whatsappCta(): Record<string, unknown> {
  return { type: "WHATSAPP_MESSAGE", value: { app_destination: "WHATSAPP", link: WHATSAPP_LINK } };
}

// ---------------------------------------------------------------- messaging destinations

export type MessagingApp = "whatsapp" | "instagram_direct" | "messenger";

/** One button per app, as in Meta's click-to-message guides (multi-destination page, checked October 2026). */
const APP_CTA: Record<MessagingApp, { type: string; app_destination: string; link: string; destination: string }> = {
  whatsapp: { type: "WHATSAPP_MESSAGE", app_destination: "WHATSAPP", link: WHATSAPP_LINK, destination: "WHATSAPP" },
  instagram_direct: { type: "INSTAGRAM_MESSAGE", app_destination: "INSTAGRAM_DIRECT", link: "https://www.instagram.com", destination: "INSTAGRAM_DIRECT" },
  messenger: { type: "MESSAGE_PAGE", app_destination: "MESSENGER", link: "https://fb.com/messenger_doc/", destination: "MESSENGER" },
};

/** WhatsApp first: it becomes the main button when several apps are used. */
const APP_ORDER: MessagingApp[] = ["whatsapp", "instagram_direct", "messenger"];

export function sortApps(apps: MessagingApp[]): MessagingApp[] {
  const set = new Set(apps);
  return APP_ORDER.filter((a) => set.has(a));
}

/** Ad set destination_type for a set of messaging apps, e.g. [whatsapp, instagram_direct] -> MESSAGING_INSTAGRAM_DIRECT_WHATSAPP. */
export function destinationTypeForApps(apps: MessagingApp[]): string {
  const set = new Set(apps);
  if (set.size === 1) return APP_CTA[[...set][0]!].destination;
  const parts = [set.has("instagram_direct") && "INSTAGRAM_DIRECT", set.has("messenger") && "MESSENGER", set.has("whatsapp") && "WHATSAPP"];
  return `MESSAGING_${parts.filter(Boolean).join("_")}`;
}

/** Messaging apps an ad set destination_type sends people to ([] for website / on-ad). */
export function appsForDestinationType(destination: string | null | undefined): MessagingApp[] {
  const d = String(destination ?? "");
  const single = APP_ORDER.find((a) => APP_CTA[a].destination === d);
  if (single) return [single];
  if (!d.startsWith("MESSAGING_")) return [];
  return APP_ORDER.filter((a) => d.includes(APP_CTA[a].destination));
}

/** Messaging apps a creative's buttons send people to, read from the creative as Meta returns it. */
export function appsForCreative(cr: any): MessagingApp[] {
  const ctas: any[] = [...(cr?.asset_feed_spec?.call_to_actions ?? [])];
  const oss = cr?.object_story_spec ?? {};
  for (const d of [oss.link_data, oss.video_data]) if (d?.call_to_action) ctas.push(d.call_to_action);
  if (cr?.call_to_action) ctas.push(cr.call_to_action);
  const apps = new Set<MessagingApp>();
  for (const c of ctas) {
    for (const app of APP_ORDER) {
      if (c?.value?.app_destination === APP_CTA[app].app_destination || c?.type === APP_CTA[app].type) apps.add(app);
    }
  }
  return APP_ORDER.filter((a) => apps.has(a));
}

export function messagingCta(app: MessagingApp): Record<string, unknown> {
  const c = APP_CTA[app];
  // Meta's Messenger example sends no link in the main button; the others carry their app link.
  return app === "messenger"
    ? { type: c.type, value: { app_destination: c.app_destination } }
    : { type: c.type, value: { app_destination: c.app_destination, link: c.link } };
}

function feedCta(app: MessagingApp): Record<string, unknown> {
  const c = APP_CTA[app];
  return { type: c.type, value: { app_destination: c.app_destination, link: c.link } };
}

/** Meta retired the standard_enhancements bundle (v22.0): features must be named one by one. */
export const RETIRED_CREATIVE_FEATURES = new Set(["standard_enhancements"]);

export function creativeFeaturesSpec(features: Record<string, boolean>): Record<string, unknown> {
  const spec: Record<string, unknown> = {};
  for (const [name, on] of Object.entries(features)) {
    if (RETIRED_CREATIVE_FEATURES.has(name)) {
      throw new Error(
        `Meta retired '${name}'. Name the features one by one instead, e.g. text_optimizations, image_touchups, video_auto_crop, inline_comment.`,
      );
    }
    spec[name] = { enroll_status: on ? "OPT_IN" : "OPT_OUT" };
  }
  return { creative_features_spec: spec };
}

/** A creative's degrees_of_freedom_spec read back from Meta, without retired features (used for copies). */
export function sanitizeDegreesOfFreedom(dof: any): Record<string, unknown> | undefined {
  const features = dof?.creative_features_spec;
  if (!features || typeof features !== "object") return undefined;
  const kept = Object.fromEntries(Object.entries(features).filter(([k]) => !RETIRED_CREATIVE_FEATURES.has(k)));
  return Object.keys(kept).length ? { creative_features_spec: kept } : undefined;
}

export function websiteCta(type: string, link: string): Record<string, unknown> {
  return { type, value: { link } };
}

export interface ResolvedCreative {
  name: string;
  format: "image" | "video" | "carousel" | "instagram_post" | "dynamic";
  destination: "whatsapp" | "instagram_direct" | "messenger" | "website";
  /** Several messaging apps, one button each (Meta picks per person). Overrides destination. */
  messaging_apps?: MessagingApp[];
  page_id: string;
  instagram_user_id?: string;
  image_hash?: string;
  video_id?: string;
  thumbnail_hash?: string;
  thumbnail_url?: string;
  headline?: string;
  primary_text?: string;
  description?: string;
  link?: string;
  cta_type?: string;
  cards?: { image_hash?: string; video_id?: string; headline: string; description?: string; link?: string }[];
  instagram_media_id?: string;
  dynamic?: {
    image_hashes: string[];
    video_ids: string[];
    headlines: string[];
    primary_texts: string[];
    descriptions: string[];
  };
  welcome?: WelcomeOptions;
  /** Extra text versions; Meta shows the best one per person. */
  primary_texts?: string[];
  headlines?: string[];
  creative_features?: Record<string, boolean>;
}

/** Messaging apps this creative sends people to ([] for website creatives). */
export function creativeApps(c: Pick<ResolvedCreative, "destination" | "messaging_apps">): MessagingApp[] {
  if (c.messaging_apps?.length) return sortApps(c.messaging_apps);
  return c.destination === "website" ? [] : [c.destination];
}

function uniqueTexts(first: string | undefined, more: string[] | undefined): string[] {
  const all = [first, ...(more ?? [])].map((t) => t?.trim()).filter((t): t is string => Boolean(t));
  return [...new Set(all)].slice(0, 5);
}

/**
 * Builds the POST /act_{id}/adcreatives body. Throws on missing required pieces.
 * Several messaging apps or several text versions add an asset_feed_spec next to object_story_spec,
 * the shape Meta uses for click-to-multidestination ads (optimization_type DOF_MESSAGING_DESTINATION).
 */
export function buildCreativePayload(c: ResolvedCreative): Record<string, unknown> {
  const apps = creativeApps(c);
  const multi = apps.length > 1;
  const bodies = uniqueTexts(c.primary_text, c.primary_texts);
  const titles = uniqueTexts(c.headline, c.headlines);
  const variations = bodies.length > 1 || titles.length > 1;
  if ((multi || variations) && c.format !== "image" && c.format !== "video") {
    throw new Error(
      `${multi ? "Several messaging apps" : "Several text versions"} work with image and video creatives only (this one is ${c.format}).`,
    );
  }
  const payload = buildBase(c, apps);
  if (multi || variations) {
    payload.asset_feed_spec = compact({
      optimization_type: multi ? "DOF_MESSAGING_DESTINATION" : "DEGREES_OF_FREEDOM",
      call_to_actions: multi ? apps.map(feedCta) : undefined,
      bodies: variations ? bodies.map((text) => ({ text })) : undefined,
      titles: variations && titles.length ? titles.map((text) => ({ text })) : undefined,
      descriptions: variations && c.description ? [{ text: c.description }] : undefined,
    });
  }
  if (c.creative_features && Object.keys(c.creative_features).length) {
    payload.degrees_of_freedom_spec = creativeFeaturesSpec(c.creative_features);
  }
  return payload;
}

function buildBase(c: ResolvedCreative, apps: MessagingApp[]): Record<string, unknown> {
  const wa = apps.length > 0; // a messaging creative (any app)
  if (!wa && !c.link && c.format !== "instagram_post") throw new Error("Website creatives need a link.");
  const main = apps[0];
  const link = main ? APP_CTA[main].link : c.link!;
  const cta = main ? messagingCta(main) : websiteCta(c.cta_type ?? "SHOP_NOW", link);
  const welcome = wa ? buildWelcomeMessage(c.welcome ?? {}) : undefined;
  const identity: Record<string, unknown> = { page_id: c.page_id };
  if (c.instagram_user_id) identity.instagram_user_id = c.instagram_user_id;

  switch (c.format) {
    case "image": {
      if (!c.image_hash) throw new Error("Image creatives need an image (image_hash or image_url).");
      return {
        name: c.name,
        object_story_spec: {
          ...identity,
          link_data: compact({
            image_hash: c.image_hash,
            name: c.headline,
            message: c.primary_text,
            description: c.description,
            link,
            call_to_action: cta,
            page_welcome_message: welcome,
          }),
        },
      };
    }
    case "video": {
      if (!c.video_id) throw new Error("Video creatives need a video (video_id or video_url).");
      if (!c.thumbnail_hash && !c.thumbnail_url) throw new Error("Video creatives need a thumbnail.");
      return {
        name: c.name,
        object_story_spec: {
          ...identity,
          video_data: compact({
            video_id: c.video_id,
            image_hash: c.thumbnail_hash,
            image_url: c.thumbnail_hash ? undefined : c.thumbnail_url,
            title: c.headline,
            message: c.primary_text,
            link_description: c.description,
            call_to_action: cta,
            page_welcome_message: welcome,
          }),
        },
      };
    }
    case "carousel": {
      if (!c.cards || c.cards.length < 2) throw new Error("Carousel creatives need 2 to 10 cards.");
      return {
        name: c.name,
        object_story_spec: {
          ...identity,
          link_data: compact({
            link,
            message: c.primary_text,
            child_attachments: c.cards.map((card) => {
              if (!card.image_hash && !card.video_id) throw new Error("Every carousel card needs an image or video.");
              return compact({
                link: wa ? link : card.link ?? link,
                image_hash: card.image_hash,
                video_id: card.video_id,
                name: card.headline,
                description: card.description,
                call_to_action: wa ? cta : websiteCta(c.cta_type ?? "SHOP_NOW", card.link ?? link),
              });
            }),
            multi_share_optimized: true,
            multi_share_end_card: false,
            call_to_action: cta,
            page_welcome_message: welcome,
          }),
        },
      };
    }
    case "instagram_post": {
      if (!c.instagram_media_id) throw new Error("Reusing an Instagram post needs instagram_media_id.");
      if (!c.instagram_user_id) throw new Error("Reusing an Instagram post needs the Instagram account (instagram_user_id).");
      return {
        name: c.name,
        object_id: c.page_id,
        instagram_user_id: c.instagram_user_id,
        source_instagram_media_id: c.instagram_media_id,
        call_to_action: cta,
      };
    }
    case "dynamic": {
      const d = c.dynamic;
      if (!d || (d.image_hashes.length === 0 && d.video_ids.length === 0)) {
        throw new Error("Dynamic creatives need at least one image or video.");
      }
      return {
        name: c.name,
        object_story_spec: identity,
        asset_feed_spec: compact({
          images: d.image_hashes.length ? d.image_hashes.map((hash) => ({ hash })) : undefined,
          videos: d.video_ids.length ? d.video_ids.map((video_id) => ({ video_id })) : undefined,
          bodies: d.primary_texts.map((text) => ({ text })),
          titles: d.headlines.map((text) => ({ text })),
          descriptions: d.descriptions.length ? d.descriptions.map((text) => ({ text })) : undefined,
          ad_formats: [d.video_ids.length && !d.image_hashes.length ? "SINGLE_VIDEO" : "SINGLE_IMAGE"],
          call_to_action_types: [main ? APP_CTA[main].type : c.cta_type ?? "SHOP_NOW"],
          link_urls: [{ website_url: link }],
        }),
      };
    }
  }
}

function compact<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== "")) as Partial<T>;
}
