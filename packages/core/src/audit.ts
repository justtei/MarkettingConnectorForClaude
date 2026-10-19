import type { CoreContext } from "./context.js";
import { describeError } from "./meta/errors.js";

/** Strip large blobs (base64 media) and secrets before storing a request in the audit log. */
export function sanitizeForAudit(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[depth]";
  if (typeof value === "string") {
    if (value.length > 2000) return `[${value.length} chars omitted]`;
    return value;
  }
  if (Array.isArray(value)) return value.slice(0, 100).map((v) => sanitizeForAudit(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (/^(access_token|token|password|secret|appsecret_proof|bytes|base64|data_base64)$/i.test(k)) {
        out[k] = "[omitted]";
      } else {
        out[k] = sanitizeForAudit(v, depth + 1);
      }
    }
    return out;
  }
  return value ?? null;
}

/**
 * Runs a write and records it in the audit log (who, what, request, response, previous state).
 * Failures are recorded too, then re-thrown.
 */
export async function audited<T>(
  ctx: CoreContext,
  action: string,
  info: { objectId?: string | null; request: unknown; before?: unknown },
  fn: () => Promise<T>,
  objectIdFromResult?: (r: T) => string | undefined,
): Promise<T> {
  try {
    const result = await fn();
    await writeAudit(ctx, {
      action,
      objectId: info.objectId ?? objectIdFromResult?.(result) ?? null,
      ok: true,
      request: info.request,
      response: result,
      before: info.before,
    });
    return result;
  } catch (err) {
    await writeAudit(ctx, {
      action,
      objectId: info.objectId ?? null,
      ok: false,
      request: info.request,
      response: describeError(err),
      before: info.before,
    });
    throw err;
  }
}

export async function writeAudit(
  ctx: CoreContext,
  entry: { action: string; objectId?: string | null; ok?: boolean; request: unknown; response: unknown; before?: unknown },
): Promise<void> {
  try {
    await ctx.db.auditLog.create({
      data: {
        actor: ctx.actor,
        action: entry.action,
        objectId: entry.objectId ?? null,
        ok: entry.ok ?? true,
        request: (sanitizeForAudit({ via: ctx.via, ...(asObject(entry.request)) }) ?? {}) as object,
        response: (sanitizeForAudit(entry.response) ?? {}) as object,
        before: entry.before === undefined ? undefined : ((sanitizeForAudit(entry.before) ?? {}) as object),
      },
    });
  } catch (err) {
    // Never lose the Meta result because the audit insert failed, but make it loud.
    ctx.log.error({ err, action: entry.action }, "AUDIT LOG WRITE FAILED");
  }
}

function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : { value: v };
}
