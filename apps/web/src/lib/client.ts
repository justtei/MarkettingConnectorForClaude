"use client";
import useSWR, { type SWRConfiguration } from "swr";

export class ApiError extends Error {
  status: number;
  rule?: string;
  kind?: string;
  details?: any;
  constructor(status: number, body: any) {
    super(body?.error ?? `Request failed (${status})`);
    this.status = status;
    this.rule = body?.rule;
    this.kind = body?.kind;
    this.details = body?.details;
  }
}

/** Calls the REST API through the authenticated proxy. */
export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/api/proxy${path}`, {
    method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
    headers: opts.body !== undefined ? { "content-type": "application/json" } : undefined,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { error: text };
  }
  if (res.status === 401 && typeof window !== "undefined" && json?.error === "Not signed in") {
    window.location.href = "/login";
  }
  if (!res.ok) throw new ApiError(res.status, json);
  return json as T;
}

/** Runs a tool from the shared registry (same guards as MCP). */
export function tool<T = any>(name: string, input: Record<string, unknown>) {
  return api<T>(`/tools/${name}`, { body: input });
}

export function useApi<T = any>(path: string | null, config?: SWRConfiguration) {
  return useSWR<T>(path, (p: string) => api<T>(p), { revalidateOnFocus: false, ...config });
}

/** Files up to 40 MB are uploaded through the dashboard; larger videos must be given as a public URL. */
export const MAX_UPLOAD_BYTES = 40 * 1024 * 1024;

export function fileToBase64(file: File): Promise<string> {
  if (file.size > MAX_UPLOAD_BYTES) {
    return Promise.reject(new Error(`${file.name} is ${(file.size / 1048576).toFixed(0)} MB. Files over 40 MB must be uploaded by public URL (e.g. a Google Drive or S3 link).`));
  }
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}
