import type { Config } from "./config.js";
import type { CoreContext } from "./context.js";
import type { Settings } from "./services/settings.js";

/** A safety rule refused the request. The message tells the caller exactly what to do. */
export class GuardError extends Error {
  readonly rule: string;
  constructor(rule: string, message: string) {
    super(message);
    this.name = "GuardError";
    this.rule = rule;
  }
}

/** Not found / bad input errors the caller can fix. */
export class UserInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserInputError";
  }
}

/** Every campaign, ad set and ad create is forced to PAUSED, whatever the input says. */
export function forcePaused<T extends Record<string, unknown>>(params: T): T & { status: "PAUSED" } {
  return { ...params, status: "PAUSED" };
}

/** Live actions (can spend or change spend) need confirm: true, which Claude must get from the user first. */
export function requireConfirm(confirm: boolean | undefined, description: string): void {
  if (confirm !== true) {
    throw new GuardError(
      "confirm_required",
      `Confirmation required: ${description}. This can spend money. Ask the user to confirm, then call again with confirm: true.`,
    );
  }
}

/** Budget cap guard: absolute cap per ad set / campaign, and max % increase per change. */
export function checkDailyBudget(
  settings: Pick<Settings, "maxDailyBudgetPkr" | "maxBudgetIncreasePct">,
  newBudgetPkr: number,
  currentBudgetPkr?: number | null,
): void {
  if (!Number.isFinite(newBudgetPkr) || newBudgetPkr <= 0) {
    throw new UserInputError("Daily budget must be a positive number of PKR.");
  }
  if (newBudgetPkr > settings.maxDailyBudgetPkr) {
    throw new GuardError(
      "budget_cap",
      `Refused: daily budget PKR ${newBudgetPkr.toLocaleString()} is above the cap of PKR ${settings.maxDailyBudgetPkr.toLocaleString()}. ` +
        `The owner can raise MAX_DAILY_BUDGET_PKR in Settings.`,
    );
  }
  if (currentBudgetPkr && currentBudgetPkr > 0 && newBudgetPkr > currentBudgetPkr) {
    const pct = ((newBudgetPkr - currentBudgetPkr) / currentBudgetPkr) * 100;
    if (pct > settings.maxBudgetIncreasePct + 1e-9) {
      const maxAllowed = Math.floor(currentBudgetPkr * (1 + settings.maxBudgetIncreasePct / 100));
      throw new GuardError(
        "budget_increase",
        `Refused: raising the budget from PKR ${currentBudgetPkr.toLocaleString()} to PKR ${newBudgetPkr.toLocaleString()} is a ${pct.toFixed(0)}% increase; ` +
          `the limit is ${settings.maxBudgetIncreasePct}% per change (max PKR ${maxAllowed.toLocaleString()} now). Raise it in steps.`,
      );
    }
  }
}

/** One ad account only: any other act_ ID is rejected. */
export function assertOwnAccount(config: Config, accountId: string | undefined | null): void {
  if (!accountId) return;
  const want = config.META_AD_ACCOUNT_ID.replace(/^act_/, "");
  const got = String(accountId).replace(/^act_/, "");
  if (want !== got) {
    throw new GuardError("wrong_account", `Refused: object belongs to ad account act_${got}, not the Sandalez account.`);
  }
}

const ownershipCache = new Map<string, { type: ObjectType; accountId: string }>();
export type ObjectType = "campaign" | "adset" | "ad" | "adcreative" | "customaudience" | "unknown";

/**
 * Confirms an object ID belongs to the configured ad account and returns its type.
 * Checks the DB mirror first; falls back to asking Meta.
 */
export async function resolveOwnedObject(ctx: CoreContext, objectId: string): Promise<ObjectType> {
  if (!/^\d+$/.test(objectId)) throw new UserInputError(`"${objectId}" is not a valid Meta object ID (digits only).`);
  const cached = ownershipCache.get(objectId);
  if (cached) {
    assertOwnAccount(ctx.config, cached.accountId);
    return cached.type;
  }
  const res = await ctx.meta.get<{ id: string; account_id?: string; metadata?: { type?: string } }>(objectId, {
    metadata: 1,
    fields: "id,account_id",
  });
  if (!res.account_id) {
    throw new GuardError("wrong_account", `Refused: object ${objectId} is not an ad object of the Sandalez account.`);
  }
  assertOwnAccount(ctx.config, res.account_id);
  // The live API no longer returns metadata.type for ad objects, so fall back to the DB mirror, then to probing.
  const t = (res.metadata?.type as ObjectType | undefined) ?? (await typeFromMirror(ctx, objectId)) ?? (await probeType(ctx, objectId));
  ownershipCache.set(objectId, { type: t, accountId: res.account_id });
  return t;
}

async function typeFromMirror(ctx: CoreContext, id: string): Promise<ObjectType | undefined> {
  const where = { where: { id }, select: { id: true } } as const;
  const [c, s, a, cr] = await Promise.all([
    ctx.db.campaign.findUnique(where),
    ctx.db.adSet.findUnique(where),
    ctx.db.ad.findUnique(where),
    ctx.db.creative.findUnique(where),
  ]);
  return c ? "campaign" : s ? "adset" : a ? "ad" : cr ? "adcreative" : undefined;
}

/** Each field exists on one kind of node only; Meta answers (#100) for the others. Ordered by how often each is used. */
const TYPE_PROBES: [ObjectType, string][] = [
  ["ad", "adset_id"],
  ["adset", "campaign_id"],
  ["campaign", "objective"],
  ["adcreative", "object_type"],
  ["customaudience", "subtype"],
];

async function probeType(ctx: CoreContext, id: string): Promise<ObjectType> {
  for (const [type, field] of TYPE_PROBES) {
    try {
      await ctx.meta.get(id, { fields: `id,${field}` });
      return type;
    } catch (err) {
      if ((err as { code?: number }).code !== 100) throw err;
    }
  }
  return "unknown";
}

export function rememberOwned(ctx: CoreContext, objectId: string, type: ObjectType): void {
  ownershipCache.set(objectId, { type, accountId: ctx.config.META_AD_ACCOUNT_ID.replace(/^act_/, "") });
}

/** Shown before every activation (spec: remind the user of Meta ad policy basics). */
export const AD_POLICY_REMINDER =
  "Meta ad policy check before going live: no misleading or exaggerated claims (e.g. fake discounts or 'guaranteed' results), " +
  "prices and offers must match what customers get on WhatsApp, no before/after or personal-attribute wording ('Are you overweight?'), " +
  "keep image text short, and make sure the landing chat is answered. The ad goes to PENDING_REVIEW and runs once Meta approves it.";
