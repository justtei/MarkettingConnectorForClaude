import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Core } from "@sandalez/core";
import { hashPassword, verifyPassword } from "@sandalez/db";
import { parseBody, requireOwner } from "../app.js";

const loginSchema = z.object({ email: z.string().email().max(320), password: z.string().min(1).max(200) });

// Simple in-memory brute-force protection: 5 failures per email+IP per 15 minutes.
const failures = new Map<string, { count: number; until: number }>();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;

export function registerAuthRoutes(api: FastifyInstance, core: Core) {
  /** Called by the dashboard's Auth.js credentials provider. */
  api.post("/api/auth/login", async (req, reply) => {
    const { email, password } = parseBody(loginSchema, req.body);
    const key = `${email.toLowerCase()}|${req.headers["x-client-ip"] || req.ip}`;
    const f = failures.get(key);
    if (f && f.count >= MAX_FAILURES && f.until > Date.now()) {
      return reply.code(429).send({ error: "Too many failed attempts. Try again in 15 minutes." });
    }
    const user = await core.db.user.findUnique({ where: { email: email.toLowerCase() } });
    const ok = user ? await verifyPassword(password, user.passwordHash) : await verifyPassword(password, DUMMY_HASH);
    if (!user || !ok) {
      const cur = f && f.until > Date.now() ? f : { count: 0, until: Date.now() + WINDOW_MS };
      cur.count++;
      failures.set(key, cur);
      await core.db.auditLog.create({ data: { actor: email.toLowerCase(), action: "login_failed", ok: false, request: { ip: req.ip }, response: {} } });
      return reply.code(401).send({ error: "Wrong email or password." });
    }
    failures.delete(key);
    await core.db.auditLog.create({ data: { actor: user.email, action: "login", request: { ip: req.ip }, response: { role: user.role } } });
    return { email: user.email, name: user.name, role: user.role };
  });

  api.get("/api/users", async (req, reply) => {
    if (!requireOwner(req, reply)) return;
    const users = await core.db.user.findMany({ orderBy: { createdAt: "asc" }, select: { email: true, name: true, role: true, createdAt: true } });
    return users;
  });

  api.post("/api/users", async (req, reply) => {
    if (!requireOwner(req, reply)) return;
    const body = parseBody(
      z.object({ email: z.string().email(), password: z.string().min(8).max(200), role: z.enum(["owner", "staff"]).default("staff"), name: z.string().max(100).optional() }),
      req.body,
    );
    const passwordHash = await hashPassword(body.password);
    const user = await core.db.user.upsert({
      where: { email: body.email.toLowerCase() },
      create: { email: body.email.toLowerCase(), passwordHash, role: body.role, name: body.name },
      update: { passwordHash, role: body.role, name: body.name },
    });
    await core.db.auditLog.create({ data: { actor: req.user!.email, action: "save_user", objectId: user.email, request: { email: user.email, role: user.role }, response: { ok: true } } });
    return { email: user.email, role: user.role, name: user.name };
  });

  api.delete<{ Params: { email: string } }>("/api/users/:email", async (req, reply) => {
    if (!requireOwner(req, reply)) return;
    const email = req.params.email.toLowerCase();
    if (email === req.user!.email) return reply.code(400).send({ error: "You cannot remove yourself." });
    const owners = await core.db.user.count({ where: { role: "owner", NOT: { email } } });
    if (owners === 0) return reply.code(400).send({ error: "At least one owner must remain." });
    await core.db.user.deleteMany({ where: { email } });
    await core.db.auditLog.create({ data: { actor: req.user!.email, action: "delete_user", objectId: email, request: { email }, response: { ok: true } } });
    return { deleted: email };
  });
}

// Constant-time-ish path for unknown users (prevents user enumeration by timing).
const DUMMY_HASH = "scrypt$00000000000000000000000000000000$" + "0".repeat(128);

/** Creates the first owner from OWNER_EMAIL / OWNER_PASSWORD when the user table is empty. */
export async function bootstrapOwner(core: Core, email?: string, password?: string) {
  if (!email || !password) return null;
  if ((await core.db.user.count()) > 0) return null;
  const user = await core.db.user.create({ data: { email: email.toLowerCase(), passwordHash: await hashPassword(password), role: "owner", name: "Owner" } });
  return user.email;
}
