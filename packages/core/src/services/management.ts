import type { z } from "zod";
import { audited } from "../audit.js";
import type { CoreContext } from "../context.js";
import {
  AD_POLICY_REMINDER,
  checkDailyBudget,
  GuardError,
  rememberOwned,
  requireConfirm,
  resolveOwnedObject,
  UserInputError,
} from "../guards.js";
import { describeError, MetaApiError } from "../meta/errors.js";
import { fromMinorUnits, toMinorUnits } from "../meta/money.js";
import type { budgetInput, statusInput, targetingUpdateInput, TargetingInput } from "../schemas.js";
import { getCurrency } from "./account.js";
import { getCampaignTree, readObject } from "./campaigns.js";
import { rebuildCampaignCopy } from "./duplicate.js";
import { mirrorStatus } from "./mirror.js";
import { getSettings } from "./settings.js";
import { buildTargeting, mergeTargeting, resolveCityKey, validateTargetingSpec } from "./targeting.js";

type StatusInput = z.input<typeof statusInput>;
type BudgetInput = z.infer<typeof budgetInput>;
type TargetingUpdate = z.input<typeof targetingUpdateInput>;

const PAUSED_LIKE = new Set(["PAUSED"]);

/** set_status: PAUSED is always allowed; ACTIVE and ARCHIVED need confirm: true and pass the budget guard. */
export async function setStatus(ctx: CoreContext, input: StatusInput) {
  const { type, obj } = await readObject(ctx, input.object_id);
  if (!["campaign", "adset", "ad"].includes(type)) {
    throw new UserInputError(`${input.object_id} is a ${type}; only campaigns, ad sets and ads have a status.`);
  }
  if (input.status === "ACTIVE") requireConfirm(input.confirm, `activate ${type} "${obj.name}" (${obj.id})`);
  if (input.status === "ARCHIVED") requireConfirm(input.confirm, `archive ${type} "${obj.name}" (${obj.id}); archived objects cannot be re-activated`);

  const before = { status: obj.status, effective_status: obj.effective_status };
  return audited(ctx, "set_status", { objectId: obj.id, request: input, before }, async () => {
    const changed: { id: string; type: string; name: string; status: string }[] = [];
    const warnings: string[] = [];

    if (input.status !== "ACTIVE") {
      await ctx.meta.post(obj.id, { status: input.status });
      await mirrorStatus(ctx, obj.id, input.status);
      changed.push({ id: obj.id, type, name: obj.name, status: input.status });
      return { object_id: obj.id, type, status: input.status, changed, warnings };
    }

    // ---- activation: check budgets of everything that will be able to spend
    const settings = await getSettings(ctx);
    const currency = await getCurrency(ctx);
    const includeChildren = input.include_children ?? true;
    const toActivate: { id: string; type: string; name: string }[] = [{ id: obj.id, type, name: obj.name }];

    if (type === "campaign") {
      const campaignBudget = fromMinorUnits(obj.daily_budget, currency);
      if (campaignBudget) checkDailyBudget(settings, campaignBudget);
      const adsets = await ctx.meta.getAll<any>(`${obj.id}/adsets`, { fields: "id,name,status,daily_budget" }, 500);
      for (const s of adsets) {
        const b = fromMinorUnits(s.daily_budget, currency);
        if (b && (s.status === "ACTIVE" || (includeChildren && PAUSED_LIKE.has(s.status)))) checkDailyBudget(settings, b);
      }
      if (includeChildren) {
        for (const s of adsets) if (PAUSED_LIKE.has(s.status)) toActivate.push({ id: s.id, type: "adset", name: s.name });
        const ads = await ctx.meta.getAll<any>(`${obj.id}/ads`, { fields: "id,name,status" }, 500);
        for (const a of ads) if (PAUSED_LIKE.has(a.status)) toActivate.push({ id: a.id, type: "ad", name: a.name });
      }
      if (adsets.length === 0) warnings.push("This campaign has no ad sets, so nothing will deliver.");
    } else if (type === "adset") {
      const b = fromMinorUnits(obj.daily_budget, currency);
      if (b) checkDailyBudget(settings, b);
      if (includeChildren) {
        const ads = await ctx.meta.getAll<any>(`${obj.id}/ads`, { fields: "id,name,status" }, 500);
        for (const a of ads) if (PAUSED_LIKE.has(a.status)) toActivate.push({ id: a.id, type: "ad", name: a.name });
      }
      // A paused object reports its own PAUSED status, so read the parent directly.
      const campaign = await ctx.meta.get<any>(obj.campaign_id, { fields: "id,status" });
      if (campaign.status !== "ACTIVE") warnings.push("The parent campaign is paused; activate it too or nothing will deliver.");
    } else {
      const [parent, campaign] = await Promise.all([
        ctx.meta.get<any>(obj.adset_id, { fields: "id,daily_budget,status" }),
        ctx.meta.get<any>(obj.campaign_id, { fields: "id,status" }),
      ]);
      const b = fromMinorUnits(parent.daily_budget, currency);
      if (b) checkDailyBudget(settings, b);
      if (campaign.status !== "ACTIVE") warnings.push("The parent campaign is paused; activate it too or the ad will not deliver.");
      if (parent.status !== "ACTIVE") warnings.push("The parent ad set is paused; activate it too or the ad will not deliver.");
    }

    // Parents first, so children never run under a paused parent mid-way.
    for (const o of toActivate) {
      await ctx.meta.post(o.id, { status: "ACTIVE" });
      await mirrorStatus(ctx, o.id, "ACTIVE");
      changed.push({ ...o, status: "ACTIVE" });
    }
    return {
      object_id: obj.id,
      type,
      status: "ACTIVE",
      changed,
      warnings,
      note: "Ads go to PENDING_REVIEW first and start delivering once Meta approves them.",
      policy_reminder: AD_POLICY_REMINDER,
    };
  });
}

/** update_budget: confirm required; refused above the cap or above the max % increase. */
export async function updateBudget(ctx: CoreContext, input: BudgetInput) {
  requireConfirm(input.confirm, `change the daily budget of ${input.object_id} to PKR ${input.daily_budget}`);
  const { type, obj } = await readObject(ctx, input.object_id);
  if (type !== "adset" && type !== "campaign") throw new UserInputError(`${input.object_id} is a ${type}; budgets live on ad sets (or campaigns).`);
  const currency = await getCurrency(ctx);
  const current = fromMinorUnits(obj.daily_budget, currency);
  if (!current) {
    if (Number(obj.lifetime_budget ?? 0) > 0) throw new UserInputError("This object uses a lifetime budget; change it in Ads Manager.");
    throw new UserInputError(
      type === "campaign"
        ? "This campaign has no campaign budget; change the budget on its ad sets instead."
        : "This ad set has no own budget (the campaign budget is used); change the campaign's budget instead.",
    );
  }
  const settings = await getSettings(ctx);
  checkDailyBudget(settings, input.daily_budget, current);
  const before = { daily_budget: current };
  return audited(ctx, "update_budget", { objectId: obj.id, request: input, before }, async () => {
    await ctx.meta.post(obj.id, { daily_budget: toMinorUnits(input.daily_budget, currency) });
    const budget = Math.round(input.daily_budget);
    if (type === "adset") await ctx.db.adSet.updateMany({ where: { id: obj.id }, data: { dailyBudget: budget } });
    else await ctx.db.campaign.updateMany({ where: { id: obj.id }, data: { dailyBudget: budget } });
    return {
      object_id: obj.id,
      type,
      name: obj.name,
      previous_daily_budget: current,
      daily_budget: input.daily_budget,
      change_pct: Math.round(((input.daily_budget - current) / current) * 1000) / 10,
      currency,
    };
  });
}

/** update_targeting: merges the changes into the current targeting (or replaces it). */
export async function updateTargeting(ctx: CoreContext, input: TargetingUpdate) {
  requireConfirm(input.confirm, `change the targeting of ad set ${input.adset_id}`);
  const { type, obj } = await readObject(ctx, input.adset_id);
  if (type !== "adset") throw new UserInputError(`${input.adset_id} is a ${type}, not an ad set.`);
  const current = (obj.targeting ?? {}) as Record<string, unknown>;
  const changes = await buildTargeting(ctx, input.changes);
  const merged = input.replace ? changes : mergeTargeting(current, changes);
  if (!input.replace) {
    if (input.changes.gender === "all") delete merged.genders;
    if (input.changes.interests && input.changes.interests.length === 0) delete merged.flexible_spec;
    if (input.changes.custom_audience_ids && input.changes.custom_audience_ids.length === 0) delete merged.custom_audiences;
  }
  validateTargetingSpec(merged as Record<string, any>);
  return audited(ctx, "update_targeting", { objectId: obj.id, request: input, before: { targeting: current } }, async () => {
    await ctx.meta.post(obj.id, { targeting: merged });
    await ctx.db.adSet.updateMany({ where: { id: obj.id }, data: { targeting: merged as object } });
    return { adset_id: obj.id, name: obj.name, targeting: merged, previous_targeting: current };
  });
}

/** Phase 2: bulk status / budget edits. Each item goes through the same guards. */
export async function bulkUpdate(
  ctx: CoreContext,
  input: { items: { object_id: string; status?: "ACTIVE" | "PAUSED" | "ARCHIVED"; daily_budget?: number }[]; confirm?: boolean },
) {
  if (input.items.length === 0) throw new UserInputError("No items given.");
  const results: { object_id: string; ok: boolean; result?: unknown; error?: string }[] = [];
  for (const item of input.items) {
    if (item.status === undefined && item.daily_budget === undefined) {
      results.push({ object_id: item.object_id, ok: false, error: "Nothing to change (give status and/or daily_budget)." });
      continue;
    }
    try {
      const out: Record<string, unknown> = {};
      if (item.daily_budget !== undefined) {
        out.budget = await updateBudget(ctx, { object_id: item.object_id, daily_budget: item.daily_budget, confirm: input.confirm });
      }
      if (item.status !== undefined) {
        out.status = await setStatus(ctx, { object_id: item.object_id, status: item.status, confirm: input.confirm, include_children: false });
      }
      results.push({ object_id: item.object_id, ok: true, result: out });
    } catch (err) {
      if (err instanceof GuardError && err.rule === "confirm_required") throw err;
      results.push({ object_id: item.object_id, ok: false, error: (err as Error).message });
    }
  }
  return { total: results.length, succeeded: results.filter((r) => r.ok).length, results };
}

/**
 * delete_object: permanently deletes a campaign, ad set or ad on Meta (with everything inside it). Needs confirm: true,
 * and refuses anything still running so a live campaign is never removed by mistake: pause it first.
 * The dashboard keeps its spend and order history (rows are marked DELETED, not removed).
 */
export async function deleteObject(ctx: CoreContext, input: { object_id: string; confirm?: boolean }) {
  const { type, obj } = await readObject(ctx, input.object_id);
  if (type !== "campaign" && type !== "adset" && type !== "ad") {
    throw new UserInputError(`${input.object_id} is a ${type}; only campaigns, ad sets and ads can be deleted.`);
  }
  const label = type === "adset" ? "ad set" : type;
  const children =
    type === "ad"
      ? { adsets: 0, ads: 0 }
      : {
          adsets: type === "campaign" ? (await ctx.meta.getAll<any>(`${obj.id}/adsets`, { fields: "id" }, 500)).length : 0,
          ads: (await ctx.meta.getAll<any>(`${obj.id}/ads`, { fields: "id" }, 500)).length,
        };
  if (obj.status === "ACTIVE") {
    throw new UserInputError(`${label} "${obj.name}" (${obj.id}) is active. Pause it first (set_status PAUSED), then delete it.`);
  }
  const inside = [children.adsets && `${children.adsets} ad set(s)`, children.ads && `${children.ads} ad(s)`].filter(Boolean).join(" and ");
  requireConfirm(input.confirm, `permanently delete ${label} "${obj.name}" (${obj.id})${inside ? ` with its ${inside}` : ""}`, "This cannot be undone.");

  const before = { type, name: obj.name, status: obj.status, effective_status: obj.effective_status, children };
  return audited(ctx, "delete_object", { objectId: obj.id, request: input, before }, async () => {
    await ctx.meta.delete(obj.id);
    // Keep the mirror rows (their daily stats and order links stay), just mark them deleted.
    const data = { status: "DELETED", effectiveStatus: "DELETED" };
    if (type === "campaign") {
      await ctx.db.campaign.updateMany({ where: { id: obj.id }, data });
      await ctx.db.adSet.updateMany({ where: { campaignId: obj.id }, data });
      await ctx.db.ad.updateMany({ where: { adSet: { campaignId: obj.id } }, data });
    } else if (type === "adset") {
      await ctx.db.adSet.updateMany({ where: { id: obj.id }, data });
      await ctx.db.ad.updateMany({ where: { adSetId: obj.id }, data });
    } else {
      await ctx.db.ad.updateMany({ where: { id: obj.id }, data });
    }
    return { object_id: obj.id, type, name: obj.name, deleted: true, also_deleted: children };
  });
}

/** Phase 2: deep-copy a campaign (PAUSED), optionally renaming it and retargeting it to another city. */
export async function duplicateCampaign(
  ctx: CoreContext,
  input: { campaign_id: string; new_name?: string; city?: string; city_key?: string; daily_budget?: number },
) {
  const type = await resolveOwnedObject(ctx, input.campaign_id);
  if (type !== "campaign" && type !== "unknown") throw new UserInputError(`${input.campaign_id} is a ${type}, not a campaign.`);
  const settings = await getSettings(ctx);
  if (input.daily_budget !== undefined) checkDailyBudget(settings, input.daily_budget);
  let cityKey = input.city_key;
  let cityName = input.city;
  if (!cityKey && input.city) {
    const c = await resolveCityKey(ctx, input.city);
    cityKey = c.key;
    cityName = c.name;
  }

  return audited(ctx, "duplicate_campaign", { objectId: input.campaign_id, request: input }, async () => {
    const currency = await getCurrency(ctx);
    let copy: { copied_campaign_id: string } | null = null;
    let fallback: { reason: string; notes: string[] } | null = null;
    let newId: string;
    try {
      copy = await ctx.meta.post<{ copied_campaign_id: string }>(`${input.campaign_id}/copies`, {
        deep_copy: true,
        status_option: "PAUSED",
        rename_options: { rename_strategy: "DEEP_RENAME", rename_suffix: " - Copy" },
      });
    } catch (err) {
      if (!(err instanceof MetaApiError)) throw err;
      // Meta's copy refuses some older ads (retired creative settings, posts made by a development-mode app).
      ctx.log.warn({ err: err.message }, "Meta /copies failed; rebuilding the copy object by object");
      const source = await ctx.meta.get<any>(input.campaign_id, { fields: "name" });
      const rebuilt = await rebuildCampaignCopy(ctx, input.campaign_id, {
        name: input.new_name ?? `${source.name} - Copy`,
        cityKey,
        cityName,
        dailyBudgetMinor: input.daily_budget !== undefined ? toMinorUnits(input.daily_budget, currency) : undefined,
      });
      fallback = { reason: describeError(err).message, notes: rebuilt.notes };
      newId = rebuilt.campaign_id;
    }
    if (copy) {
      newId = copy.copied_campaign_id;
      if (!newId) throw new Error("Meta did not return the copied campaign ID.");
      rememberOwned(ctx, newId, "campaign");
      if (input.new_name) await ctx.meta.post(newId, { name: input.new_name });

      const adsets = await ctx.meta.getAll<any>(`${newId}/adsets`, { fields: "id,name,targeting,daily_budget" }, 500);
      for (const s of adsets) {
        rememberOwned(ctx, s.id, "adset");
        const update: Record<string, unknown> = {};
        if (cityKey) {
          const t = { ...(s.targeting ?? {}) };
          t.geo_locations = { cities: [{ key: cityKey }], location_types: t.geo_locations?.location_types ?? ["home", "recent"] };
          update.targeting = t;
          if (cityName) update.name = `${String(s.name).replace(/ - Copy$/, "")} | ${cityName}`;
        }
        if (input.daily_budget !== undefined && Number(s.daily_budget ?? 0) > 0) {
          update.daily_budget = toMinorUnits(input.daily_budget, currency);
        }
        if (Object.keys(update).length) await ctx.meta.post(s.id, update);
      }
    }
    const tree = await getCampaignTree(ctx, newId!);
    if (!tree.adsets.length) {
      ctx.log.warn({ newId }, "Copied campaign has no ad sets (deep copy may still be running)");
    }
    return {
      source_campaign_id: input.campaign_id,
      campaign_id: newId,
      name: tree.name,
      status: "PAUSED",
      city: cityName ?? null,
      method: fallback ? "rebuilt" : "meta_copy",
      ...(fallback ? { meta_copy_error: fallback.reason, notes: fallback.notes } : {}),
      adsets: tree.adsets.map((s) => ({ id: s.id, name: s.name, daily_budget: s.daily_budget, ads: s.ads.length })),
    };
  }, (r) => r.campaign_id);
}

export type { TargetingInput };
