import type { CoreContext } from "../context.js";
import { UserInputError } from "../guards.js";
import type { PlacementsInput, TargetingInput } from "../schemas.js";

export async function searchInterests(ctx: CoreContext, query: string, limit = 25) {
  const res = await ctx.meta.get<{ data: any[] }>("search", { type: "adinterest", q: query, limit, locale: "en_US" });
  return (res.data ?? []).map((i) => ({
    id: String(i.id),
    name: i.name,
    audience_size_lower_bound: i.audience_size_lower_bound ?? null,
    audience_size_upper_bound: i.audience_size_upper_bound ?? null,
    path: i.path ?? [],
    topic: i.topic ?? null,
  }));
}

export async function searchLocations(
  ctx: CoreContext,
  query: string,
  locationTypes: string[] = ["city"],
  countryCode: string | undefined = "PK",
  limit = 10,
) {
  const res = await ctx.meta.get<{ data: any[] }>("search", {
    type: "adgeolocation",
    q: query,
    location_types: locationTypes,
    ...(countryCode ? { country_code: countryCode } : {}),
    limit,
  });
  return (res.data ?? []).map((l) => ({
    key: String(l.key),
    name: l.name,
    type: l.type,
    region: l.region ?? null,
    region_id: l.region_id ?? null,
    country_code: l.country_code ?? null,
    country_name: l.country_name ?? null,
    supports_city: l.supports_city ?? null,
    supports_region: l.supports_region ?? null,
  }));
}

/** Resolves a city name (e.g. "Karachi") to its Meta city key. Picks the exact-name match first. */
export async function resolveCityKey(ctx: CoreContext, city: string, countryCode = "PK"): Promise<{ key: string; name: string }> {
  const results = await searchLocations(ctx, city, ["city"], countryCode, 10);
  const cities = results.filter((r) => r.type === "city");
  const exact = cities.find((c) => c.name.toLowerCase() === city.trim().toLowerCase()) ?? cities[0];
  if (!exact) throw new UserInputError(`No city called "${city}" found in ${countryCode}. Try search_locations first.`);
  return { key: exact.key, name: exact.name };
}

const GENDERS: Record<string, number[] | undefined> = { all: undefined, male: [1], female: [2] };

/** Converts the simple targeting input into Meta's targeting spec. */
export async function buildTargeting(ctx: CoreContext, t: TargetingInput): Promise<Record<string, unknown>> {
  const spec: Record<string, any> = {};
  const geo: Record<string, any> = {};

  const cityKeys: { key: string; radius?: number; distance_unit?: string }[] = [];
  for (const key of t.city_keys ?? []) cityKeys.push({ key });
  for (const name of t.cities ?? []) cityKeys.push({ key: (await resolveCityKey(ctx, name)).key });
  if (cityKeys.length) {
    geo.cities = dedupeBy(cityKeys, (c) => c.key).map((c) =>
      t.radius_km ? { key: c.key, radius: t.radius_km, distance_unit: "kilometer" } : { key: c.key },
    );
  }
  if (t.countries?.length) geo.countries = t.countries.map((c) => c.toUpperCase());
  if (t.region_keys?.length) geo.regions = t.region_keys.map((key) => ({ key }));
  if (t.pins?.length) {
    geo.custom_locations = t.pins.map((p) => ({
      latitude: p.latitude,
      longitude: p.longitude,
      radius: p.radius_km,
      distance_unit: "kilometer",
      ...(p.name ? { name: p.name } : {}),
    }));
  }
  if (t.place_keys?.length) {
    geo.places = t.place_keys.map((p) => (p.radius_km ? { key: p.key, radius: p.radius_km, distance_unit: "kilometer" } : { key: p.key }));
  }
  if (Object.keys(geo).length) {
    geo.location_types = t.location_types ?? ["home", "recent"];
    spec.geo_locations = geo;
  }

  if (t.age_min !== undefined) spec.age_min = t.age_min;
  if (t.age_max !== undefined) spec.age_max = t.age_max;
  if (spec.age_min !== undefined && spec.age_max !== undefined && spec.age_min > spec.age_max) {
    throw new UserInputError(`age_min (${spec.age_min}) is greater than age_max (${spec.age_max}).`);
  }
  if (t.gender) {
    const g = GENDERS[t.gender];
    if (g) spec.genders = g;
  }
  if (t.interests?.length) {
    spec.flexible_spec = [{ interests: t.interests.map((i) => ({ id: i.id, ...(i.name ? { name: i.name } : {}) })) }];
  }
  if (t.custom_audience_ids?.length) spec.custom_audiences = t.custom_audience_ids.map((id) => ({ id }));
  if (t.excluded_custom_audience_ids?.length) {
    spec.excluded_custom_audiences = t.excluded_custom_audience_ids.map((id) => ({ id }));
  }
  if (t.publisher_platforms?.length) spec.publisher_platforms = t.publisher_platforms;
  if (t.placements) Object.assign(spec, buildPlacements(t.placements));
  if (t.advantage_audience !== undefined) {
    spec.targeting_automation = { advantage_audience: t.advantage_audience ? 1 : 0 };
  }
  if (t.raw) Object.assign(spec, t.raw);
  return spec;
}

/** Targeting keys that make up placements. None of them set = Advantage+ (automatic) placements. */
export const PLACEMENT_KEYS = [
  "publisher_platforms",
  "facebook_positions",
  "instagram_positions",
  "messenger_positions",
  "threads_positions",
  "audience_network_positions",
  "device_platforms",
] as const;

const POSITION_PLATFORM = {
  facebook_positions: "facebook",
  instagram_positions: "instagram",
  messenger_positions: "messenger",
  threads_positions: "threads",
  audience_network_positions: "audience_network",
} as const;

/**
 * Converts placements into Meta targeting fields. Checks the combinations Meta documents as invalid, so the
 * user gets a clear reason instead of a generic Meta error; Meta still checks format/objective limits.
 */
export function buildPlacements(p: PlacementsInput): Record<string, unknown> {
  const manual = p.platforms || p.devices || Object.keys(POSITION_PLATFORM).some((k) => (p as any)[k]?.length);
  if (p.automatic) {
    if (manual) throw new UserInputError("Give either automatic: true (Advantage+ placements) or manual platforms/positions, not both.");
    return {};
  }
  if (!manual) throw new UserInputError("Give automatic: true, or the platforms (and optionally positions) to use.");

  const out: Record<string, unknown> = {};
  const platforms = new Set<string>(p.platforms ?? []);
  for (const [key, platform] of Object.entries(POSITION_PLATFORM)) {
    const positions = (p as any)[key] as string[] | undefined;
    if (!positions?.length) continue;
    if (p.platforms && !platforms.has(platform)) {
      throw new UserInputError(`${key} given but ${platform} is not in platforms. Add "${platform}" to platforms or drop ${key}.`);
    }
    platforms.add(platform);
    out[key] = [...new Set(positions)];
  }
  if (platforms.size) {
    if (platforms.size === 1 && platforms.has("audience_network")) throw new UserInputError("Audience Network can't be the only platform.");
    if (platforms.has("threads") && !platforms.has("instagram")) throw new UserInputError("Threads ads need Instagram too: add \"instagram\" to platforms.");
    out.publisher_platforms = [...platforms];
  }

  const fb = new Set((out.facebook_positions as string[] | undefined) ?? []);
  const ig = new Set((out.instagram_positions as string[] | undefined) ?? []);
  const ms = new Set((out.messenger_positions as string[] | undefined) ?? []);
  const anyFb = platforms.has("facebook") && !out.facebook_positions; // all Facebook positions
  const anyIg = platforms.has("instagram") && !out.instagram_positions;
  const fbFeed = anyFb || fb.has("feed");
  for (const pos of ["marketplace", "search", "profile_feed", "notification"]) {
    if (fb.has(pos) && !fb.has("feed")) throw new UserInputError(`Facebook ${pos} needs Facebook feed too: add "feed" to facebook_positions.`);
  }
  const storyNeeds = fbFeed || anyIg || ig.has("story");
  if (fb.has("story") && !storyNeeds) throw new UserInputError("Facebook story needs Facebook feed or Instagram story too.");
  if (ms.has("story") && !storyNeeds) throw new UserInputError("Messenger story needs Facebook feed or Instagram story too.");
  if (ms.has("sponsored_messages") && (platforms.size > 1 || ms.size > 1)) {
    throw new UserInputError("Messenger sponsored_messages can't be combined with any other placement.");
  }
  if (platforms.has("threads") && !(anyIg || ig.has("stream"))) throw new UserInputError("Threads feed needs Instagram stream (feed) too.");

  if (p.devices) {
    out.device_platforms = [...new Set(p.devices)];
    if ((fb.has("story") || ms.has("story")) && !p.devices.includes("mobile")) {
      throw new UserInputError("Story placements need mobile devices.");
    }
  }
  return out;
}

/** Readable summary of the placements in a Meta targeting spec. */
export function describePlacements(targeting: Record<string, any> | null | undefined) {
  const t = targeting ?? {};
  const set = PLACEMENT_KEYS.filter((k) => t[k] !== undefined && !(Array.isArray(t[k]) && t[k].length === 0));
  if (!set.length) return { mode: "automatic", note: "Advantage+ placements: Meta chooses where the ads show." };
  const platforms: string[] = t.publisher_platforms ?? ["facebook", "instagram", "messenger", "threads", "audience_network"];
  const positions: Record<string, string[] | "all"> = {};
  for (const [key, platform] of Object.entries(POSITION_PLATFORM)) {
    if (platforms.includes(platform)) positions[platform] = (t[key] as string[] | undefined) ?? "all";
  }
  return { mode: "manual", platforms, positions, devices: (t.device_platforms as string[] | undefined) ?? ["mobile", "desktop"] };
}

/** Removes every placement field, so `changes` can set placements from scratch (or leave them automatic). */
export function withoutPlacements(spec: Record<string, unknown>): Record<string, unknown> {
  const out = { ...spec };
  for (const k of PLACEMENT_KEYS) delete out[k];
  return out;
}

/**
 * New ad sets always state the Advantage+ audience flag: since v26.0 Meta refuses some ad sets without it
 * (ADS_TARGETING__REQUIRE_EXPLICIT_ADVANTAGE_AUDIENCE_FLAG). Default on (Meta's default); off when the
 * minimum age is above 25, which Advantage+ audience does not allow as a hard limit.
 */
export function withExplicitAdvantageAudience(spec: Record<string, any>): Record<string, any> {
  if (spec.targeting_automation?.advantage_audience !== undefined) return spec;
  const on = spec.age_min === undefined || spec.age_min <= 25;
  return { ...spec, targeting_automation: { ...(spec.targeting_automation ?? {}), advantage_audience: on ? 1 : 0 } };
}

/** Merge targeting changes into the current spec (keys present in `changes` replace the old ones). */
export function mergeTargeting(current: Record<string, unknown>, changes: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...current, ...changes };
  // Meta returns read-only/derived fields that must not be sent back.
  for (const k of ["age_range", "brand_safety_content_filter_levels"]) {
    if (!(k in changes)) delete merged[k];
  }
  return merged;
}

export function validateTargetingSpec(spec: Record<string, any>): void {
  if (!spec.geo_locations) {
    throw new UserInputError("Targeting needs a location: give cities, city_keys, countries, region_keys, pins or place_keys.");
  }
}

/** Audience size estimate. Uses reachestimate, falling back to delivery_estimate where unavailable. */
export async function estimateAudience(ctx: CoreContext, t: TargetingInput, optimizationGoal = "CONVERSATIONS") {
  const spec = await buildTargeting(ctx, t);
  validateTargetingSpec(spec);
  try {
    const res = await ctx.meta.get<{ data: any }>(`${ctx.config.META_AD_ACCOUNT_ID}/reachestimate`, {
      targeting_spec: spec,
    });
    const d = Array.isArray(res.data) ? res.data[0] : res.data;
    return {
      source: "reachestimate",
      users_lower_bound: d?.users_lower_bound ?? null,
      users_upper_bound: d?.users_upper_bound ?? null,
      estimate_ready: d?.estimate_ready ?? null,
      targeting: spec,
    };
  } catch (err) {
    ctx.log.info({ err: String(err) }, "reachestimate failed; trying delivery_estimate");
    const res = await ctx.meta.get<{ data: any[] }>(`${ctx.config.META_AD_ACCOUNT_ID}/delivery_estimate`, {
      targeting_spec: spec,
      optimization_goal: optimizationGoal,
    });
    const d = res.data?.[0] ?? {};
    return {
      source: "delivery_estimate",
      users_lower_bound: d.estimate_mau_lower_bound ?? null,
      users_upper_bound: d.estimate_mau_upper_bound ?? null,
      estimate_ready: d.estimate_ready ?? null,
      targeting: spec,
    };
  }
}

function dedupeBy<T>(items: T[], key: (t: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((i) => {
    const k = key(i);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
