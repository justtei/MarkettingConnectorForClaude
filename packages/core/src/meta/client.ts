import { createHmac } from "node:crypto";
import type { Config } from "../config.js";
import { logger as rootLogger, type Logger } from "../logger.js";
import { MetaApiError, isRateLimitCode } from "./errors.js";

export type Params = Record<string, unknown>;

export interface UsageSnapshot {
  /** Highest usage percentage seen across the usage headers on the last response. */
  maxPct: number;
  /** Seconds Meta says to wait before access is regained (0 = not throttled). */
  regainSeconds: number;
  raw: Record<string, unknown>;
  at: string;
}

export interface MetaClientOptions {
  accessToken: string;
  appSecret?: string;
  apiVersion: string;
  baseUrl: string;
  maxRetries?: number;
  retryBaseMs?: number;
  timeoutMs?: number;
  /** Start slowing down when any usage header passes this percentage (spec: 75%). */
  throttleAtPct?: number;
  fetchImpl?: typeof fetch;
  logger?: Logger;
  sleep?: (ms: number) => Promise<void>;
}

export interface Paged<T> {
  data: T[];
  paging?: { cursors?: { before?: string; after?: string }; next?: string; previous?: string };
  summary?: unknown;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Thin Graph API client. The only place in the codebase that holds the Meta token
 * and talks to graph.facebook.com.
 */
export class MetaClient {
  private readonly opts: Required<Omit<MetaClientOptions, "appSecret" | "fetchImpl" | "logger" | "sleep">> &
    Pick<MetaClientOptions, "appSecret">;
  private readonly fetchImpl: typeof fetch;
  private readonly log: Logger;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly proof?: string;
  private throttleUntil = 0;
  lastUsage: UsageSnapshot | null = null;

  constructor(options: MetaClientOptions) {
    this.opts = {
      accessToken: options.accessToken,
      appSecret: options.appSecret,
      apiVersion: options.apiVersion,
      baseUrl: options.baseUrl.replace(/\/+$/, ""),
      maxRetries: options.maxRetries ?? 3,
      retryBaseMs: options.retryBaseMs ?? 500,
      timeoutMs: options.timeoutMs ?? 60_000,
      throttleAtPct: options.throttleAtPct ?? 75,
    };
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.log = (options.logger ?? rootLogger).child({ component: "meta-client" });
    this.sleep = options.sleep ?? defaultSleep;
    if (options.appSecret) {
      this.proof = createHmac("sha256", options.appSecret).update(options.accessToken).digest("hex");
    }
  }

  static fromConfig(config: Config, extra: Partial<MetaClientOptions> = {}): MetaClient {
    return new MetaClient({
      accessToken: config.META_ACCESS_TOKEN,
      appSecret: config.META_APP_SECRET,
      apiVersion: config.META_API_VERSION,
      baseUrl: config.META_GRAPH_BASE_URL,
      maxRetries: config.META_MAX_RETRIES,
      retryBaseMs: config.META_RETRY_BASE_MS,
      timeoutMs: config.META_TIMEOUT_MS,
      ...extra,
    });
  }

  get apiVersion(): string {
    return this.opts.apiVersion;
  }

  get accessToken(): string {
    return this.opts.accessToken;
  }

  get appSecretProof(): string | undefined {
    return this.proof;
  }

  async get<T = any>(path: string, params: Params = {}): Promise<T> {
    return this.request<T>("GET", path, params);
  }

  async post<T = any>(path: string, params: Params = {}): Promise<T> {
    return this.request<T>("POST", path, params);
  }

  async delete<T = any>(path: string, params: Params = {}): Promise<T> {
    return this.request<T>("DELETE", path, params);
  }

  /** multipart/form-data POST (file uploads). Blob values are sent as files. */
  async postMultipart<T = any>(path: string, params: Params): Promise<T> {
    return this.requestUrl<T>("POST", this.buildUrl(path), params, false, true);
  }

  /** GET a list edge and follow `paging.next` until exhausted or `maxItems` reached. */
  async getAll<T = any>(path: string, params: Params = {}, maxItems = 1000): Promise<T[]> {
    const out: T[] = [];
    let page = await this.get<Paged<T>>(path, { limit: Math.min(maxItems, 200), ...params });
    for (;;) {
      out.push(...(page.data ?? []));
      const next = page.paging?.next;
      if (!next || out.length >= maxItems || !(page.data?.length)) break;
      page = await this.requestUrl<Paged<T>>("GET", next, undefined, true);
    }
    return out.slice(0, maxItems);
  }

  private buildUrl(path: string): string {
    if (/^https?:\/\//.test(path)) return path;
    const clean = path.replace(/^\/+/, "");
    return `${this.opts.baseUrl}/${this.opts.apiVersion}/${clean}`;
  }

  private encode(params: Params): URLSearchParams {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue;
      sp.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
    }
    // A caller may pass its own access_token (e.g. the app token for debug_token);
    // appsecret_proof is only valid for the system user token.
    if (!sp.has("access_token")) {
      sp.set("access_token", this.opts.accessToken);
      if (this.proof) sp.set("appsecret_proof", this.proof);
    } else if (this.opts.appSecret && !sp.get("access_token")!.includes("|")) {
      // A Page token gets its own proof (apps that require app-secret proofs refuse calls without one).
      // App tokens (app_id|secret) take none.
      sp.set("appsecret_proof", createHmac("sha256", this.opts.appSecret).update(sp.get("access_token")!).digest("hex"));
    }
    return sp;
  }

  private async request<T>(method: "GET" | "POST" | "DELETE", path: string, params: Params): Promise<T> {
    const url = this.buildUrl(path);
    return this.requestUrl<T>(method, url, params, false);
  }

  private async requestUrl<T>(
    method: "GET" | "POST" | "DELETE",
    url: string,
    params: Params | undefined,
    absoluteNext: boolean,
    multipart = false,
  ): Promise<T> {
    let attempt = 0;
    for (;;) {
      await this.waitForThrottle();
      let finalUrl = url;
      let body: URLSearchParams | FormData | undefined;
      if (absoluteNext) {
        // `paging.next` URLs already carry the token and cursors.
        finalUrl = url;
      } else if (method === "GET" || method === "DELETE") {
        finalUrl = `${url}?${this.encode(params ?? {}).toString()}`;
      } else if (multipart) {
        const form = new FormData();
        for (const [k, v] of Object.entries(params ?? {})) {
          if (v === undefined || v === null) continue;
          if (v instanceof Blob) form.set(k, v, (v as File).name ?? "upload");
          else form.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
        }
        for (const [k, v] of this.encode({})) form.set(k, v);
        body = form;
      } else {
        body = this.encode(params ?? {});
      }

      const started = Date.now();
      let res: Response;
      try {
        res = await this.fetchImpl(finalUrl, {
          method,
          body,
          headers: body instanceof URLSearchParams ? { "content-type": "application/x-www-form-urlencoded" } : undefined,
          signal: AbortSignal.timeout(this.opts.timeoutMs),
        });
      } catch (err) {
        // Network failure: retry reads; never blindly retry writes (they may have succeeded).
        if (method === "GET" && attempt < this.opts.maxRetries) {
          attempt++;
          const wait = this.backoff(attempt);
          this.log.warn({ err: String(err), attempt, wait, url: redactUrl(url) }, "Meta network error, retrying");
          await this.sleep(wait);
          continue;
        }
        throw new MetaApiError({
          status: 0,
          message: `Network error talking to Meta: ${(err as Error).message}`,
          isTransient: true,
        });
      }

      this.readUsage(res.headers);
      const text = await res.text();
      let json: any;
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        json = { error: { message: `Non-JSON response from Meta (HTTP ${res.status})` } };
      }

      this.log.debug({ method, url: redactUrl(url), status: res.status, ms: Date.now() - started }, "Meta call");

      if (res.ok && !json?.error) return json as T;

      const e = json?.error ?? {};
      const error = new MetaApiError({
        status: res.status,
        message: e.message ?? `HTTP ${res.status}`,
        code: e.code,
        subcode: e.error_subcode,
        type: e.type,
        fbtraceId: e.fbtrace_id,
        userTitle: e.error_user_title,
        userMessage: e.error_user_msg,
        isTransient: e.is_transient,
      });

      // Rate-limit rejections were not processed, so retrying is safe for any method.
      // Other transient errors are retried only for reads.
      const retryable = error.rateLimited || (error.transient && method === "GET");
      if (retryable && attempt < this.opts.maxRetries) {
        attempt++;
        const wait = isRateLimitCode(error.code)
          ? Math.max(this.backoff(attempt) * 4, (this.lastUsage?.regainSeconds ?? 0) * 1000)
          : this.backoff(attempt);
        this.log.warn({ code: error.code, attempt, wait, fbtrace_id: error.fbtraceId }, "Meta error, retrying");
        await this.sleep(Math.min(wait, 5 * 60_000));
        continue;
      }
      this.log.warn({ code: error.code, subcode: error.subcode, fbtrace_id: error.fbtraceId, msg: error.metaMessage }, "Meta error");
      throw error;
    }
  }

  private backoff(attempt: number): number {
    const base = this.opts.retryBaseMs * 2 ** (attempt - 1);
    return Math.round(base + Math.random() * base * 0.25);
  }

  private async waitForThrottle(): Promise<void> {
    const wait = this.throttleUntil - Date.now();
    if (wait > 0) {
      this.log.info({ wait }, "Throttling Meta calls (usage above threshold)");
      await this.sleep(wait);
    }
  }

  /** Reads X-Business-Use-Case-Usage, X-Ad-Account-Usage and X-App-Usage and slows down above 75%. */
  private readUsage(headers: Headers): void {
    const raw: Record<string, unknown> = {};
    let maxPct = 0;
    let regainSeconds = 0;

    const buc = parseHeader(headers.get("x-business-use-case-usage"));
    if (buc && typeof buc === "object") {
      raw.business_use_case = buc;
      for (const entries of Object.values(buc as Record<string, any[]>)) {
        for (const u of entries ?? []) {
          maxPct = Math.max(maxPct, num(u.call_count), num(u.total_cputime), num(u.total_time));
          regainSeconds = Math.max(regainSeconds, num(u.estimated_time_to_regain_access) * 60);
        }
      }
    }
    const acc = parseHeader(headers.get("x-ad-account-usage"));
    if (acc && typeof acc === "object") {
      raw.ad_account = acc;
      maxPct = Math.max(maxPct, num((acc as any).acc_id_util_pct));
      regainSeconds = Math.max(regainSeconds, num((acc as any).reset_time_duration));
    }
    const app = parseHeader(headers.get("x-app-usage"));
    if (app && typeof app === "object") {
      raw.app = app;
      maxPct = Math.max(maxPct, num((app as any).call_count), num((app as any).total_cputime), num((app as any).total_time));
    }
    if (Object.keys(raw).length === 0) return;

    this.lastUsage = { maxPct, regainSeconds, raw, at: new Date().toISOString() };
    if (maxPct >= 100 && regainSeconds > 0) {
      this.throttleUntil = Date.now() + regainSeconds * 1000;
    } else if (maxPct > this.opts.throttleAtPct) {
      // Linear slow-down: 75% -> 0s, 100% -> 30s between calls.
      const frac = Math.min(1, (maxPct - this.opts.throttleAtPct) / (100 - this.opts.throttleAtPct));
      this.throttleUntil = Date.now() + Math.round(frac * 30_000);
    }
  }
}

function parseHeader(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function redactUrl(url: string): string {
  return url.replace(/(access_token|appsecret_proof)=[^&]+/g, "$1=***");
}
