import "server-only";
import { auth } from "@/auth";

const API_URL = process.env.API_URL ?? "http://localhost:3002";

/** Server-side call to the REST API as the signed-in user. The internal secret never reaches the browser. */
export async function apiFetch(path: string, init: { method?: string; body?: BodyInit | null; contentType?: string } = {}) {
  const session = await auth();
  if (!session?.user?.email) return new Response(JSON.stringify({ error: "Not signed in" }), { status: 401 });
  return fetch(`${API_URL}${path}`, {
    method: init.method ?? "GET",
    body: init.body ?? undefined,
    headers: {
      ...(init.body ? { "content-type": init.contentType ?? "application/json" } : {}),
      "x-internal-secret": process.env.API_INTERNAL_SECRET ?? "",
      "x-user-email": session.user.email,
      "x-user-role": session.user.role,
    },
    cache: "no-store",
  });
}
