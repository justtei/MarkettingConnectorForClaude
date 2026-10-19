/** A failed Meta Graph API call, with a plain-language explanation and the fbtrace_id for Meta support. */
export class MetaApiError extends Error {
  readonly status: number;
  readonly code?: number;
  readonly subcode?: number;
  readonly type?: string;
  readonly fbtraceId?: string;
  readonly userTitle?: string;
  readonly userMessage?: string;
  readonly metaMessage: string;
  readonly plain: string;
  readonly transient: boolean;
  readonly rateLimited: boolean;

  constructor(init: {
    status: number;
    message: string;
    code?: number;
    subcode?: number;
    type?: string;
    fbtraceId?: string;
    userTitle?: string;
    userMessage?: string;
    isTransient?: boolean;
  }) {
    const plain = explainMetaError(init);
    super(plain);
    this.name = "MetaApiError";
    this.status = init.status;
    this.code = init.code;
    this.subcode = init.subcode;
    this.type = init.type;
    this.fbtraceId = init.fbtraceId;
    this.userTitle = init.userTitle;
    this.userMessage = init.userMessage;
    this.metaMessage = init.message;
    this.plain = plain;
    this.rateLimited = isRateLimitCode(init.code);
    this.transient =
      Boolean(init.isTransient) || this.rateLimited || TRANSIENT_CODES.has(init.code ?? -1) || init.status >= 500;
  }

  toJSON() {
    return {
      error: this.plain,
      meta_message: this.metaMessage,
      code: this.code,
      subcode: this.subcode,
      fbtrace_id: this.fbtraceId,
      user_title: this.userTitle,
      user_message: this.userMessage,
    };
  }
}

const TRANSIENT_CODES = new Set([1, 2]);
const RATE_LIMIT_CODES = new Set([
  4, 17, 32, 613, 80000, 80001, 80002, 80003, 80004, 80005, 80006, 80008, 80009, 80014,
]);

export function isRateLimitCode(code?: number): boolean {
  return code !== undefined && RATE_LIMIT_CODES.has(code);
}

const CODE_MESSAGES: Record<number, string> = {
  1: "Meta had a temporary problem. Try again in a minute.",
  2: "Meta's service is temporarily unavailable. Try again shortly.",
  4: "Too many calls to Meta from this app. Wait a few minutes before retrying.",
  10: "The app does not have permission for this action. Check the system user's permissions.",
  17: "Too many calls for this ad account. Wait a few minutes before retrying.",
  32: "Too many calls for this Page. Wait a few minutes before retrying.",
  100: "Meta rejected one of the parameters.",
  102: "The Meta session is invalid. Generate a new system user token.",
  104: "No access token was sent. Set META_ACCESS_TOKEN.",
  190: "The Meta access token is invalid or expired. Generate a new system user token in Business Settings.",
  200: "The token is missing a required permission (for example ads_management or pages_manage_ads).",
  294: "Managing ads needs the ads_management permission on the token.",
  368: "Meta temporarily blocked this action for policy reasons.",
  613: "Meta's rate limit was hit. Wait a few minutes before retrying.",
  803: "One of the IDs does not exist or the token cannot see it.",
  2635: "This API version is deprecated. Update META_API_VERSION.",
  80004: "The ad account hit its Marketing API rate limit. Wait before retrying.",
};

const SUBCODE_MESSAGES: Record<number, string> = {
  33: "The object does not exist, or the token has no access to it.",
  463: "The access token has expired. Generate a new system user token.",
  467: "The access token is no longer valid (password change or revoked). Generate a new one.",
  1487007: "The budget is below Meta's minimum daily budget for this ad set.",
  1885316: "The ad set's daily budget is too low.",
  1487891: "The ad account is disabled or has an unpaid balance.",
  1815652: "The video is still processing. Wait a moment and try again.",
  2446289: "The WhatsApp number is not connected to the Facebook Page. Link it in Page settings first.",
};

function explainMetaError(e: {
  status: number;
  message: string;
  code?: number;
  subcode?: number;
  userMessage?: string;
}): string {
  if (e.status === 0) return `Could not reach Meta (${e.message.replace(/^Network error talking to Meta: /, "")}). Check the server's internet connection and META_GRAPH_BASE_URL.`;
  const base =
    (e.subcode !== undefined ? SUBCODE_MESSAGES[e.subcode] : undefined) ??
    (e.code !== undefined ? CODE_MESSAGES[e.code] : undefined) ??
    (e.code !== undefined && e.code >= 200 && e.code < 300 ? CODE_MESSAGES[200] : undefined) ??
    (e.status >= 500 ? "Meta returned a server error. Try again shortly." : "Meta rejected the request.");
  const detail = e.userMessage ?? e.message;
  return detail && !base.includes(detail) ? `${base} Meta says: ${detail}` : base;
}

/** Turns any thrown value into a short, safe message for Claude or the dashboard. */
export function describeError(err: unknown): { message: string; details?: Record<string, unknown> } {
  if (err instanceof MetaApiError) return { message: err.plain, details: err.toJSON() };
  if (err instanceof Error) return { message: err.message };
  return { message: String(err) };
}
