/** Date helpers. Ad account days are in Asia/Karachi; all dates are YYYY-MM-DD strings. */

export function todayIn(tz = "Asia/Karachi", now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(since: string, until: string): number {
  return Math.round((Date.parse(`${until}T00:00:00Z`) - Date.parse(`${since}T00:00:00Z`)) / 86_400_000) + 1;
}

export function eachDay(since: string, until: string): string[] {
  const out: string[] = [];
  for (let d = since; d <= until; d = addDays(d, 1)) out.push(d);
  return out;
}

export function toDbDate(date: string): Date {
  return new Date(`${date}T00:00:00Z`);
}

export function fromDbDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export interface RangeInput {
  date_preset?: string;
  since?: string;
  until?: string;
}

/** Turns a preset or since/until into concrete dates (inclusive) in the account timezone. */
export function resolveRange(input: RangeInput, tz = "Asia/Karachi", fallbackPreset = "last_7d"): { since: string; until: string } {
  if (input.since || input.until) {
    const until = input.until ?? todayIn(tz);
    const since = input.since ?? addDays(until, -6);
    if (since > until) throw new Error(`"since" (${since}) is after "until" (${until}).`);
    return { since, until };
  }
  const today = todayIn(tz);
  const yesterday = addDays(today, -1);
  const preset = input.date_preset ?? fallbackPreset;
  const dow = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7; // Monday = 0
  switch (preset) {
    case "today":
      return { since: today, until: today };
    case "yesterday":
      return { since: yesterday, until: yesterday };
    case "last_3d":
      return { since: addDays(today, -3), until: yesterday };
    case "last_7d":
      return { since: addDays(today, -7), until: yesterday };
    case "last_14d":
      return { since: addDays(today, -14), until: yesterday };
    case "last_28d":
      return { since: addDays(today, -28), until: yesterday };
    case "last_30d":
      return { since: addDays(today, -30), until: yesterday };
    case "last_90d":
      return { since: addDays(today, -90), until: yesterday };
    case "this_month":
      return { since: `${today.slice(0, 7)}-01`, until: today };
    case "last_month": {
      const firstThis = `${today.slice(0, 7)}-01`;
      const lastPrev = addDays(firstThis, -1);
      return { since: `${lastPrev.slice(0, 7)}-01`, until: lastPrev };
    }
    case "this_week_mon_today":
      return { since: addDays(today, -dow), until: today };
    case "last_week_mon_sun": {
      const mon = addDays(today, -dow - 7);
      return { since: mon, until: addDays(mon, 6) };
    }
    case "maximum":
      return { since: "2015-01-01", until: today };
    default:
      throw new Error(`Unknown date preset "${preset}".`);
  }
}

/** Meta insights params: a preset passes through; explicit dates become time_range. */
export function metaRangeParams(input: RangeInput, fallbackPreset = "last_7d"): Record<string, unknown> {
  if (input.since || input.until) {
    const r = resolveRange(input);
    return { time_range: { since: r.since, until: r.until } };
  }
  return { date_preset: input.date_preset ?? fallbackPreset };
}
