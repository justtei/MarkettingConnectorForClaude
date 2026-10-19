import { redirect } from "next/navigation";
import { AuthError } from "next-auth";
import { auth, signIn } from "@/auth";

export const metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string; next?: string }> }) {
  const session = await auth();
  const sp = await searchParams;
  if (session?.user) redirect("/");

  async function login(formData: FormData) {
    "use server";
    const next = String(formData.get("next") || "/");
    try {
      await signIn("credentials", {
        email: formData.get("email"),
        password: formData.get("password"),
        redirectTo: next.startsWith("/") && !next.startsWith("//") ? next : "/",
      });
    } catch (err) {
      if (err instanceof AuthError) redirect(`/login?error=1&next=${encodeURIComponent(next)}`);
      throw err;
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <form action={login} className="w-full max-w-sm space-y-4 rounded-xl border border-border bg-surface p-6">
        <div>
          <h1 className="text-lg font-semibold">Sandalez Ads</h1>
          <p className="text-sm text-text-3">Sign in to the dashboard</p>
        </div>
        {sp.error && (
          <p role="alert" className="rounded-lg border border-critical/40 bg-critical/10 px-3 py-2 text-sm text-critical-text">
            Wrong email or password, or too many attempts. Try again in a few minutes.
          </p>
        )}
        <input type="hidden" name="next" value={sp.next ?? "/"} />
        <label className="block space-y-1">
          <span className="text-sm font-medium text-text-2">Email</span>
          <input name="email" type="email" required autoComplete="email" className="h-10 w-full rounded-lg border border-border bg-surface px-3 text-sm focus:border-accent focus:outline-none" />
        </label>
        <label className="block space-y-1">
          <span className="text-sm font-medium text-text-2">Password</span>
          <input name="password" type="password" required autoComplete="current-password" className="h-10 w-full rounded-lg border border-border bg-surface px-3 text-sm focus:border-accent focus:outline-none" />
        </label>
        <button className="h-10 w-full rounded-lg bg-accent text-sm font-medium text-accent-fg hover:opacity-90">Sign in</button>
      </form>
    </main>
  );
}
