import { redirect } from "next/navigation";
import { auth, signOut } from "@/auth";
import { Shell } from "@/components/shell";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.user?.email) redirect("/login");

  async function signOutAction() {
    "use server";
    await signOut({ redirectTo: "/login" });
  }

  return (
    <Shell user={{ email: session.user.email, name: session.user.name ?? null, role: session.user.role }} signOutAction={signOutAction}>
      {children}
    </Shell>
  );
}
