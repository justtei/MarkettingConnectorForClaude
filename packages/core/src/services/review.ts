/** Ad review: rejected ads with Meta's reasons, and delivery issues on campaigns / ad sets / ads. */
import type { CoreContext } from "../context.js";

export const REVIEW_FIELDS = "ad_review_feedback,issues_info";

/** Plain-language review result for one ad / ad set / campaign as Meta returns it. */
export function reviewOf(o: any): { status: string; reasons: string[] } | null {
  const reasons: string[] = [];
  const fb = o?.ad_review_feedback;
  for (const group of [fb?.global, fb?.placement_specific?.facebook, fb?.placement_specific?.instagram]) {
    if (group && typeof group === "object") for (const [k, v] of Object.entries(group)) reasons.push(`${k}: ${String(v)}`);
  }
  for (const i of o?.issues_info ?? []) {
    const text = i.error_summary || i.error_message;
    if (text) reasons.push(`${text}${i.level ? ` (${String(i.level).toLowerCase()})` : ""}`);
  }
  const status = String(o?.effective_status ?? "");
  if (!reasons.length && !["DISAPPROVED", "WITH_ISSUES"].includes(status)) return null;
  return { status, reasons: [...new Set(reasons)] };
}

/** Ads that are disapproved or have issues, under an object or the whole account. */
export async function rejectedAds(ctx: CoreContext, objectId?: string | null) {
  const ads = await ctx.meta.getAll<any>(`${objectId ?? ctx.config.META_AD_ACCOUNT_ID}/ads`, {
    fields: `id,name,effective_status,${REVIEW_FIELDS}`,
    effective_status: ["DISAPPROVED", "WITH_ISSUES"],
  }, 500);
  return ads
    .filter((a) => a.effective_status === "DISAPPROVED" || a.effective_status === "WITH_ISSUES")
    .map((a) => ({ id: String(a.id), name: String(a.name ?? a.id), status: String(a.effective_status), reasons: reviewOf(a)?.reasons ?? [] }));
}
