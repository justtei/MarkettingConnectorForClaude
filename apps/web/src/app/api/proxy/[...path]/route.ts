// Authenticated pass-through from browser to the REST API (/api/proxy/x -> API /api/x).
import type { NextRequest } from "next/server";
import { apiFetch } from "@/lib/server-api";

async function forward(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  if (path.some((p) => p === ".." || p.includes("/"))) return Response.json({ error: "Bad path" }, { status: 400 });
  if (path[0] === "auth") return Response.json({ error: "Not found" }, { status: 404 });
  const target = `/api/${path.map(encodeURIComponent).join("/")}${req.nextUrl.search}`;
  const body = req.method === "GET" || req.method === "HEAD" ? null : await req.text();
  const res = await apiFetch(target, { method: req.method, body: body || null });
  const text = await res.text();
  return new Response(text, { status: res.status, headers: { "content-type": res.headers.get("content-type") ?? "application/json" } });
}

export const GET = forward;
export const POST = forward;
export const PUT = forward;
export const PATCH = forward;
export const DELETE = forward;
export const dynamic = "force-dynamic";
