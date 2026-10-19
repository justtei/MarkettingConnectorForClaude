import { z } from "zod";
import type { CoreContext } from "../context.js";

/** Settings editable from the dashboard; env values are the defaults. */
export const settingsSchema = z.object({
  maxDailyBudgetPkr: z.number().positive().max(10_000_000),
  maxBudgetIncreasePct: z.number().positive().max(1000),
  defaultCityKey: z.string().nullable(),
  defaultCityName: z.string().nullable(),
  defaultAgeMin: z.number().int().min(13).max(65),
  defaultAgeMax: z.number().int().min(13).max(65),
  defaultGender: z.enum(["all", "female", "male"]),
  alertEmail: z.string().email().nullable(),
});

export type Settings = z.infer<typeof settingsSchema>;

const KEY = "settings";

export function defaultSettings(ctx: Pick<CoreContext, "config">): Settings {
  return {
    maxDailyBudgetPkr: ctx.config.MAX_DAILY_BUDGET_PKR,
    maxBudgetIncreasePct: ctx.config.MAX_BUDGET_INCREASE_PCT,
    defaultCityKey: null,
    defaultCityName: "Karachi",
    defaultAgeMin: 20,
    defaultAgeMax: 40,
    defaultGender: "female",
    alertEmail: process.env.REPORT_EMAIL_TO?.trim() || null,
  };
}

export async function getSettings(ctx: Pick<CoreContext, "config" | "db">): Promise<Settings> {
  const defaults = defaultSettings(ctx);
  const row = await ctx.db.setting.findUnique({ where: { key: KEY } });
  if (!row) return defaults;
  const merged = { ...defaults, ...(row.value as Partial<Settings>) };
  const parsed = settingsSchema.safeParse(merged);
  return parsed.success ? parsed.data : defaults;
}

export async function updateSettings(ctx: CoreContext, patch: Partial<Settings>): Promise<Settings> {
  const current = await getSettings(ctx);
  const next = settingsSchema.parse({ ...current, ...patch });
  if (next.defaultAgeMin > next.defaultAgeMax) throw new Error("Default minimum age must not exceed maximum age.");
  await ctx.db.setting.upsert({
    where: { key: KEY },
    create: { key: KEY, value: next },
    update: { value: next },
  });
  await ctx.db.auditLog.create({
    data: {
      actor: ctx.actor,
      action: "update_settings",
      request: patch as object,
      response: next as object,
      before: current as object,
    },
  });
  return next;
}

/** Small key/value helpers for bookkeeping (last sync time, etc.). */
export async function getMeta<T>(ctx: Pick<CoreContext, "db">, key: string): Promise<T | null> {
  const row = await ctx.db.setting.findUnique({ where: { key } });
  return (row?.value as T) ?? null;
}

export async function setMeta(ctx: Pick<CoreContext, "db">, key: string, value: unknown): Promise<void> {
  await ctx.db.setting.upsert({
    where: { key },
    create: { key, value: value as object },
    update: { value: value as object },
  });
}
