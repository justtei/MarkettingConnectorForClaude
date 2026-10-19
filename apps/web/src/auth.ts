import NextAuth, { type DefaultSession } from "next-auth";
import Credentials from "next-auth/providers/credentials";

declare module "next-auth" {
  interface Session {
    user: { role: "owner" | "staff" } & DefaultSession["user"];
  }
}

const API_URL = process.env.API_URL ?? "http://localhost:3002";

export const { handlers, auth, signIn, signOut } = NextAuth({
  trustHost: true,
  session: { strategy: "jwt", maxAge: 12 * 60 * 60 },
  pages: { signIn: "/login" },
  providers: [
    Credentials({
      credentials: { email: { label: "Email" }, password: { label: "Password", type: "password" } },
      async authorize(credentials, request) {
        const email = String(credentials?.email ?? "").trim();
        const password = String(credentials?.password ?? "");
        if (!email || !password) return null;
        const ip = request?.headers?.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "";
        const res = await fetch(`${API_URL}/api/auth/login`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-internal-secret": process.env.API_INTERNAL_SECRET ?? "",
            "x-client-ip": ip,
          },
          body: JSON.stringify({ email, password }),
          cache: "no-store",
        });
        if (!res.ok) return null;
        const u = (await res.json()) as { email: string; name: string | null; role: "owner" | "staff" };
        return { id: u.email, email: u.email, name: u.name ?? u.email, role: u.role } as any;
      },
    }),
  ],
  callbacks: {
    jwt({ token, user }) {
      if (user) token.role = (user as any).role;
      return token;
    },
    session({ session, token }) {
      session.user.role = (token.role as "owner" | "staff") ?? "staff";
      return session;
    },
  },
});
