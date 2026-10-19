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

export function websiteCta(type: string, link: string): Record<string, unknown> {
  return { type, value: { link } };
}

export interface ResolvedCreative {
  name: string;
  format: "image" | "video" | "carousel" | "instagram_post" | "dynamic";
  destination: "whatsapp" | "website";
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
}

/** Builds the POST /act_{id}/adcreatives body. Throws on missing required pieces. */
export function buildCreativePayload(c: ResolvedCreative): Record<string, unknown> {
  const wa = c.destination === "whatsapp";
  if (!wa && !c.link && c.format !== "instagram_post") throw new Error("Website creatives need a link.");
  const link = wa ? WHATSAPP_LINK : c.link!;
  const cta = wa ? whatsappCta() : websiteCta(c.cta_type ?? "SHOP_NOW", link);
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
                link: wa ? WHATSAPP_LINK : card.link ?? link,
                image_hash: card.image_hash,
                video_id: card.video_id,
                name: card.headline,
                description: card.description,
                call_to_action: wa ? whatsappCta() : websiteCta(c.cta_type ?? "SHOP_NOW", card.link ?? link),
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
          call_to_action_types: [wa ? "WHATSAPP_MESSAGE" : c.cta_type ?? "SHOP_NOW"],
          link_urls: [{ website_url: link }],
        }),
      };
    }
  }
}

function compact<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== "")) as Partial<T>;
}
