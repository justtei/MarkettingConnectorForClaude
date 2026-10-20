/**
 * zod schemas shared by MCP tool inputs and the REST API.
 * Money is always PKR major units here; conversion to Meta minor units happens in core.
 */
import { z } from "zod";

export const metaId = z.string().regex(/^\d+$/, "Meta IDs are digits only");
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
export const pkr = z.number().positive().max(100_000_000);

export const gender = z.enum(["all", "female", "male"]);

export const targetingInput = z
  .object({
    cities: z.array(z.string().min(2)).max(25).optional().describe("City names, e.g. ['Karachi'] (searched in Pakistan)."),
    city_keys: z.array(z.string()).max(25).optional().describe("Meta city keys from search_locations."),
    radius_km: z.number().min(1).max(80).optional().describe("Radius around each city in km."),
    countries: z.array(z.string().length(2)).optional().describe("ISO country codes, e.g. ['PK']."),
    region_keys: z.array(z.string()).optional(),
    pins: z
      .array(
        z.object({
          latitude: z.number().min(-90).max(90),
          longitude: z.number().min(-180).max(180),
          radius_km: z.number().min(1).max(80),
          name: z.string().max(200).optional().describe("Label for your own reference, e.g. 'DHA Karachi'."),
        }),
      )
      .max(200)
      .optional()
      .describe("Map pins: an area around a point (e.g. a neighbourhood). Check the coordinates are in the right city."),
    place_keys: z
      .array(z.object({ key: z.string(), radius_km: z.number().min(1).max(80).optional() }))
      .max(200)
      .optional()
      .describe("Meta place keys (search_locations with location_types ['place']), optionally with a radius."),
    location_types: z.array(z.enum(["home", "recent", "travel_in"])).optional(),
    age_min: z.number().int().min(18).max(65).optional(),
    age_max: z.number().int().min(18).max(65).optional(),
    gender: gender.optional(),
    interests: z.array(z.object({ id: metaId, name: z.string().optional() })).max(50).optional(),
    custom_audience_ids: z.array(metaId).optional(),
    excluded_custom_audience_ids: z.array(metaId).optional(),
    publisher_platforms: z.array(z.enum(["facebook", "instagram", "messenger", "audience_network"])).optional(),
    advantage_audience: z.boolean().optional().describe("Let Meta expand beyond the audience (Advantage+ audience)."),
    raw: z.record(z.string(), z.unknown()).optional().describe("Advanced: raw Meta targeting fields merged last."),
  })
  .describe("Simple targeting. Converted to a Meta targeting spec by core.");
export type TargetingInput = z.infer<typeof targetingInput>;

export const datePreset = z.enum([
  "today",
  "yesterday",
  "last_3d",
  "last_7d",
  "last_14d",
  "last_28d",
  "last_30d",
  "last_90d",
  "this_month",
  "last_month",
  "this_week_mon_today",
  "last_week_mon_sun",
  "maximum",
]);

export const dateRange = z.object({
  date_preset: datePreset.optional().describe("Relative range. Ignored when since/until are given."),
  since: isoDate.optional(),
  until: isoDate.optional(),
});

export const welcomeFields = {
  welcome_message: z.string().max(500).optional().describe("Greeting shown when the WhatsApp chat opens."),
  autofill_message: z.string().max(500).optional().describe("Message pre-filled for the customer to send."),
  icebreakers: z.array(z.string().max(80)).max(4).optional().describe("Up to 4 quick questions, e.g. 'Price?'"),
};

export const messagingApp = z.enum(["whatsapp", "instagram_direct", "messenger"]);
export type MessagingApp = z.infer<typeof messagingApp>;

/** Ad set destinations. The MESSAGING_* values send people to several apps; Meta picks the best one per person. */
export const adsetDestination = z.enum([
  "WHATSAPP",
  "INSTAGRAM_DIRECT",
  "MESSENGER",
  "MESSAGING_INSTAGRAM_DIRECT_WHATSAPP",
  "MESSAGING_MESSENGER_WHATSAPP",
  "MESSAGING_INSTAGRAM_DIRECT_MESSENGER",
  "MESSAGING_INSTAGRAM_DIRECT_MESSENGER_WHATSAPP",
  "WEBSITE",
  "ON_AD",
]);

export const messagingAppsField = z
  .array(messagingApp)
  .min(1)
  .max(3)
  .optional()
  .describe(
    "Messaging apps people can reach you on, e.g. ['whatsapp','instagram_direct']. Two or more = one button per app, Meta picks per person. " +
      "Must match the ad set's destination (WHATSAPP + INSTAGRAM_DIRECT = MESSAGING_INSTAGRAM_DIRECT_WHATSAPP).",
  );

export const textVariationFields = {
  primary_texts: z
    .array(z.string().max(2200))
    .max(5)
    .optional()
    .describe("Extra primary-text versions (up to 5 in total with primary_text); Meta shows the best one per person."),
  headlines: z.array(z.string().max(255)).max(5).optional().describe("Extra headline versions (up to 5 in total with headline)."),
};

export const creativeFeaturesField = z
  .record(z.string().regex(/^[a-z_]+$/), z.boolean())
  .optional()
  .describe(
    "Advantage+ creative features, each on (true) or off (false), e.g. {text_optimizations: true, video_auto_crop: true, " +
      "image_touchups: true, inline_comment: true, enhance_cta: true}. Leave out to use Meta's defaults. " +
      "The old 'standard_enhancements' bundle is retired by Meta: name the features one by one.",
  );

export const ctaTypes = z.enum([
  "WHATSAPP_MESSAGE",
  "SHOP_NOW",
  "LEARN_MORE",
  "ORDER_NOW",
  "BUY_NOW",
  "SEND_MESSAGE",
  "CONTACT_US",
  "SIGN_UP",
  "GET_OFFER",
]);

export const mediaRef = z.object({
  image_hash: z.string().optional(),
  image_url: z.string().url().optional(),
  video_id: metaId.optional(),
  video_url: z.string().url().optional(),
  thumbnail_hash: z.string().optional(),
  thumbnail_url: z.string().url().optional(),
});

export const carouselCard = z.object({
  image_hash: z.string().optional(),
  image_url: z.string().url().optional(),
  video_id: metaId.optional(),
  headline: z.string().max(255),
  description: z.string().max(255).optional(),
  link: z.string().url().optional(),
});

export const creativeInput = z.object({
  name: z.string().min(1).max(400),
  format: z.enum(["image", "video", "carousel", "instagram_post", "dynamic"]),
  destination: z
    .enum(["whatsapp", "instagram_direct", "messenger", "website"])
    .default("whatsapp")
    .describe("Where the button sends people. For several messaging apps, use messaging_apps instead."),
  messaging_apps: messagingAppsField,
  page_id: metaId.optional().describe("Defaults to the configured Sandalez Page."),
  instagram_user_id: metaId.optional().describe("Defaults to the configured Instagram account."),
  ...mediaRef.shape,
  headline: z.string().max(255).optional(),
  primary_text: z.string().max(2200).optional(),
  description: z.string().max(255).optional(),
  link: z.string().url().optional().describe("Website URL (destination website only)."),
  cta_type: ctaTypes.optional(),
  cards: z.array(carouselCard).min(2).max(10).optional().describe("Carousel cards (format carousel)."),
  instagram_media_id: metaId.optional().describe("Existing Instagram post ID to reuse (format instagram_post)."),
  dynamic: z
    .object({
      image_hashes: z.array(z.string()).max(10).default([]),
      image_urls: z.array(z.string().url()).max(10).default([]),
      video_ids: z.array(metaId).max(10).default([]),
      headlines: z.array(z.string().max(255)).min(1).max(5),
      primary_texts: z.array(z.string().max(2200)).min(1).max(5),
      descriptions: z.array(z.string().max(255)).max(5).default([]),
    })
    .optional()
    .describe("Dynamic creative (DCO): Meta mixes these assets. The ad set must have is_dynamic_creative: true."),
  ...textVariationFields,
  creative_features: creativeFeaturesField,
  ...welcomeFields,
});
export type CreativeInput = z.infer<typeof creativeInput>;

export const objective = z.enum([
  "OUTCOME_ENGAGEMENT",
  "OUTCOME_TRAFFIC",
  "OUTCOME_SALES",
  "OUTCOME_LEADS",
  "OUTCOME_AWARENESS",
  "OUTCOME_APP_PROMOTION",
]);

export const createCampaignInput = z.object({
  name: z.string().min(1).max(400),
  objective: objective.default("OUTCOME_ENGAGEMENT"),
  special_ad_categories: z.array(z.string()).default([]),
  daily_budget: pkr.optional().describe("Campaign budget (Advantage+ campaign budget) in PKR. Usually set on the ad set instead."),
});

export const optimizationGoal = z.enum([
  "CONVERSATIONS",
  "LINK_CLICKS",
  "LANDING_PAGE_VIEWS",
  "OFFSITE_CONVERSIONS",
  "IMPRESSIONS",
  "REACH",
  "POST_ENGAGEMENT",
  "THRUPLAY",
  "VALUE",
]);

export const createAdsetInput = z.object({
  campaign_id: metaId,
  name: z.string().min(1).max(400),
  daily_budget: pkr.optional().describe("PKR per day. Omit only if the campaign has its own budget."),
  targeting: targetingInput,
  destination: adsetDestination
    .default("WHATSAPP")
    .describe(
      "Where ads send people. WHATSAPP / INSTAGRAM_DIRECT / MESSENGER for one app; MESSAGING_INSTAGRAM_DIRECT_WHATSAPP etc. for several " +
        "(the ads then need a creative with the same messaging_apps). WEBSITE or ON_AD otherwise.",
    ),
  optimization_goal: optimizationGoal.optional(),
  billing_event: z.enum(["IMPRESSIONS", "LINK_CLICKS", "THRUPLAY"]).default("IMPRESSIONS"),
  bid_strategy: z
    .enum(["LOWEST_COST_WITHOUT_CAP", "LOWEST_COST_WITH_BID_CAP", "COST_CAP"])
    .default("LOWEST_COST_WITHOUT_CAP"),
  bid_amount: pkr.optional().describe("PKR, required for bid cap / cost cap."),
  start_time: z.string().datetime({ offset: true }).optional(),
  end_time: z.string().datetime({ offset: true }).optional(),
  is_dynamic_creative: z.boolean().optional(),
  promoted_object: z.record(z.string(), z.unknown()).optional().describe("Advanced override."),
});

export const createAdInput = z.object({
  adset_id: metaId,
  creative_id: metaId,
  name: z.string().min(1).max(400),
});

export const ctwaCreative = z.object({
  name: z.string().max(400).optional(),
  type: z.enum(["image", "video"]),
  image_url: z.string().url().optional(),
  image_hash: z.string().optional(),
  video_url: z.string().url().optional(),
  video_id: metaId.optional(),
  thumbnail_url: z.string().url().optional(),
  thumbnail_hash: z.string().optional(),
  headline: z.string().max(255).optional(),
  primary_text: z.string().max(2200).optional(),
  ...textVariationFields,
});

export const createCtwaInput = z.object({
  name: z.string().min(1).max(400).describe("Campaign name, e.g. SZ-KHI-Prospecting-WA"),
  objective: z
    .enum(["OUTCOME_ENGAGEMENT", "OUTCOME_SALES"])
    .default("OUTCOME_ENGAGEMENT")
    .describe("OUTCOME_ENGAGEMENT (default) or OUTCOME_SALES (Sales objective, still optimising for chats)."),
  messaging_apps: messagingAppsField.describe(
    "Default ['whatsapp']. ['whatsapp','instagram_direct'] sends people to WhatsApp or Instagram DMs (one button per app).",
  ),
  adset_name: z.string().max(400).optional(),
  daily_budget: pkr.describe("PKR per day for the ad set, e.g. 600"),
  city: z.string().optional().describe("City name, default from Settings (Karachi)."),
  city_key: z.string().optional().describe("Meta city key if already known."),
  radius_km: z.number().min(1).max(80).optional(),
  age_min: z.number().int().min(18).max(65).optional(),
  age_max: z.number().int().min(18).max(65).optional(),
  gender: gender.optional(),
  interests: z.array(z.object({ id: metaId, name: z.string().optional() })).max(50).optional(),
  advantage_audience: z
    .boolean()
    .optional()
    .describe("Advantage+ audience (Meta treats age/gender as suggestions). Default: on when age_min is 25 or lower, else off."),
  creatives: z.array(ctwaCreative).min(1).max(10),
  headline: z.string().max(255).optional().describe("Default headline for creatives that have none."),
  primary_text: z.string().max(2200).optional().describe("Default primary text for creatives that have none."),
  ...textVariationFields,
  creative_features: creativeFeaturesField,
  ...welcomeFields,
});

export const statusInput = z.object({
  object_id: metaId.describe("Campaign, ad set or ad ID"),
  status: z.enum(["ACTIVE", "PAUSED", "ARCHIVED"]),
  confirm: z.boolean().optional().describe("Must be true to activate or archive. Ask the user first."),
  include_children: z
    .boolean()
    .default(true)
    .describe("When activating a campaign or ad set, also activate its paused ad sets/ads so it can deliver."),
});

export const budgetInput = z.object({
  object_id: metaId.describe("Ad set ID (or campaign ID for campaign-budget campaigns)"),
  daily_budget: pkr.describe("New daily budget in PKR"),
  confirm: z.boolean().optional().describe("Must be true. Ask the user first."),
});

export const targetingUpdateInput = z.object({
  adset_id: metaId,
  changes: targetingInput,
  replace: z.boolean().default(false).describe("Replace the whole targeting instead of merging with the current one."),
  confirm: z.boolean().optional().describe("Must be true. Ask the user first."),
});

export const insightsInput = z.object({
  object_id: metaId.optional().describe("Campaign/ad set/ad ID. Omit for the whole ad account."),
  level: z.enum(["account", "campaign", "adset", "ad"]).default("campaign"),
  ...dateRange.shape,
  breakdowns: z
    .array(
      z.enum([
        "age",
        "gender",
        "publisher_platform",
        "platform_position",
        "region",
        "device_platform",
        "body_asset",
        "title_asset",
        "description_asset",
        "video_asset",
        "image_asset",
        "call_to_action_asset",
      ]),
    )
    .max(2)
    .optional()
    .describe(
      "Split the numbers. *_asset breakdowns show which text, headline, video, image or button wins when an ad runs several " +
        "versions (text versions, multi-app buttons, dynamic creative); use one asset breakdown at a time, at level ad.",
    ),
  time_increment: z.union([z.literal("all_days"), z.literal("monthly"), z.number().int().min(1).max(90)]).optional(),
  limit: z.number().int().min(1).max(500).default(100),
});

export const logOrdersInput = z.object({
  date: isoDate,
  ad_id: metaId.optional(),
  chats: z.number().int().min(0),
  orders: z.number().int().min(0),
  refused: z.number().int().min(0).default(0),
  revenue: z.number().min(0).describe("PKR"),
  note: z.string().max(1000).optional(),
});

/** Order log edits: every field optional and NO defaults (a partial edit must not reset other fields). */
export const orderPatchInput = z.object({
  date: isoDate.optional(),
  ad_id: metaId.nullable().optional(),
  chats: z.number().int().min(0).optional(),
  orders: z.number().int().min(0).optional(),
  refused: z.number().int().min(0).optional(),
  revenue: z.number().min(0).optional(),
  note: z.string().max(1000).nullable().optional(),
});

export const costPerOrderInput = z.object({
  ...dateRange.shape,
  group_by: z.enum(["total", "day", "ad"]).default("total"),
  source: z.enum(["meta", "db"]).default("meta").describe("Spend from Meta live (default) or the synced database."),
  object_id: metaId.optional().describe("Only this campaign, ad set or ad (orders linked to its ads). Omit for the whole account."),
});
