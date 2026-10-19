import { z } from "zod";
import type { CoreContext } from "../context.js";
import { GuardError, UserInputError } from "../guards.js";
import { MetaApiError } from "../meta/errors.js";
import { toolMap, type ToolDef } from "./registry.js";

export type ToolOutcome =
  | { ok: true; tool: string; result: unknown }
  | { ok: false; tool: string; error: string; kind: "validation" | "guard" | "input" | "meta" | "internal" | "not_found"; rule?: string; details?: unknown };

export function formatZodError(err: z.ZodError): string {
  return err.issues
    .map((i) => {
      const path = i.path.length ? i.path.join(".") : "input";
      return `${path}: ${i.message}`;
    })
    .join("; ");
}

/** Runs one tool with validated input. Never throws: errors come back as { ok: false }. */
export async function runTool(ctx: CoreContext, name: string, rawInput: unknown): Promise<ToolOutcome> {
  const def = toolMap.get(name) as ToolDef | undefined;
  if (!def) return { ok: false, tool: name, error: `Unknown tool "${name}".`, kind: "not_found" };
  const parsed = def.input.safeParse(rawInput ?? {});
  if (!parsed.success) {
    return { ok: false, tool: name, error: `Invalid input — ${formatZodError(parsed.error)}`, kind: "validation" };
  }
  const started = Date.now();
  try {
    const result = await def.handler(ctx, parsed.data);
    ctx.log.info({ tool: name, ms: Date.now() - started }, "tool ok");
    return { ok: true, tool: name, result };
  } catch (err) {
    return toOutcome(ctx, name, err, started);
  }
}

/** Runs any core action with the same error classification as tools (used by REST routes). */
export async function runAction(ctx: CoreContext, name: string, fn: () => Promise<unknown>): Promise<ToolOutcome> {
  const started = Date.now();
  try {
    return { ok: true, tool: name, result: await fn() };
  } catch (err) {
    return toOutcome(ctx, name, err, started);
  }
}

function toOutcome(ctx: CoreContext, name: string, err: unknown, started: number): ToolOutcome {
  const ms = Date.now() - started;
  if (err instanceof GuardError) {
    ctx.log.warn({ tool: name, rule: err.rule, ms }, "tool refused by guard");
    return { ok: false, tool: name, error: err.message, kind: "guard", rule: err.rule };
  }
  if (err instanceof UserInputError) {
    ctx.log.info({ tool: name, ms, msg: err.message }, "tool input error");
    return { ok: false, tool: name, error: err.message, kind: "input" };
  }
  if (err instanceof z.ZodError) {
    return { ok: false, tool: name, error: `Invalid input — ${formatZodError(err)}`, kind: "validation" };
  }
  if (err instanceof MetaApiError) {
    ctx.log.warn({ tool: name, ms, code: err.code, fbtrace_id: err.fbtraceId }, "tool failed at Meta");
    return { ok: false, tool: name, error: err.plain, kind: "meta", details: err.toJSON() };
  }
  const e = err as Error & { details?: unknown };
  ctx.log.error({ tool: name, ms, err }, "tool failed");
  return { ok: false, tool: name, error: e?.message ?? String(err), kind: "internal", details: e?.details };
}
