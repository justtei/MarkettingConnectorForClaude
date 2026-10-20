import type { CoreContext } from "../context.js";
import { UserInputError } from "../guards.js";
import type { TargetingInput } from "../schemas.js";

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
  if (t.advantage_audience !== undefined) {
    spec.targeting_automation = { advantage_audience: t.advantage_audience ? 1 : 0 };
  }
  if (t.raw) Object.assign(spec, t.raw);
  return spec;
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
