"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useContext, useState, type ReactNode } from "react";
import { cx } from "./ui";

export interface SessionUser {
  email: string;
  name: string | null;
  role: "owner" | "staff";
}

const UserCtx = createContext<SessionUser | null>(null);
export function useUser(): SessionUser {
  const u = useContext(UserCtx);
  if (!u) throw new Error("useUser outside Shell");
  return u;
}
export function useIsOwner() {
  return useUser().role === "owner";
}

const NAV = [
  { href: "/", label: "Overview", icon: "◎", main: true },
  { href: "/campaigns", label: "Campaigns", icon: "▤", main: true },
  { href: "/new", label: "New campaign", icon: "+", main: true, owner: true },
  { href: "/orders", label: "Orders", icon: "☰", main: true },
  { href: "/creatives", label: "Creatives", icon: "▣" },
  { href: "/insights", label: "Insights", icon: "◔" },
  { href: "/audiences", label: "Audiences", icon: "◍" },
  { href: "/alerts", label: "Alerts", icon: "!" },
  { href: "/activity", label: "Activity log", icon: "↻" },
  { href: "/settings", label: "Settings", icon: "⚙" },
];

export function Shell({ user, children, signOutAction }: { user: SessionUser; children: ReactNode; signOutAction: () => Promise<void> }) {
  const path = usePathname();
  const [more, setMore] = useState(false);
  const items = NAV.filter((n) => !n.owner || user.role === "owner");
  const isActive = (href: string) => (href === "/" ? path === "/" : path.startsWith(href));

  return (
    <UserCtx.Provider value={user}>
      <div className="md:flex">
        {/* Desktop sidebar */}
        <aside className="sticky top-0 hidden h-screen w-56 shrink-0 flex-col border-r border-border bg-surface md:flex">
          <div className="px-4 py-4">
            <div className="text-base font-semibold">Sandalez Ads</div>
            <div className="text-xs text-text-3">Click-to-WhatsApp</div>
          </div>
          <nav className="flex-1 space-y-0.5 px-2" aria-label="Main">
            {items.map((n) => (
              <Link
                key={n.href}
                href={n.href}
                aria-current={isActive(n.href) ? "page" : undefined}
                className={cx(
                  "flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm",
                  isActive(n.href) ? "bg-surface-2 font-semibold text-text" : "text-text-2 hover:bg-surface-2",
                )}
              >
                <span aria-hidden className="w-4 text-center">{n.icon}</span>
                {n.label}
              </Link>
            ))}
          </nav>
          <UserBox user={user} signOutAction={signOutAction} />
        </aside>

        <div className="min-w-0 flex-1">
          {/* Mobile top bar */}
          <header className="sticky top-0 z-20 flex items-center justify-between border-b border-border bg-surface/95 px-4 py-3 backdrop-blur md:hidden">
            <span className="font-semibold">Sandalez Ads</span>
            <span className="text-xs text-text-3">{user.role}</span>
          </header>
          <main className="mx-auto max-w-6xl px-4 pb-24 pt-4 md:px-6 md:pb-10 md:pt-6">{children}</main>
        </div>

        {/* Mobile bottom nav */}
        <nav className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t border-border bg-surface md:hidden" aria-label="Main">
          {items
            .filter((n) => n.main)
            .map((n) => (
              <Link
                key={n.href}
                href={n.href}
                aria-current={isActive(n.href) ? "page" : undefined}
                className={cx("flex flex-col items-center gap-0.5 py-2 text-[11px]", isActive(n.href) ? "font-semibold text-text" : "text-text-3")}
              >
                <span aria-hidden className="text-base leading-none">{n.icon}</span>
                {n.label.replace("New campaign", "New")}
              </Link>
            ))}
          <button onClick={() => setMore((v) => !v)} aria-expanded={more} className="flex flex-col items-center gap-0.5 py-2 text-[11px] text-text-3">
            <span aria-hidden className="text-base leading-none">⋯</span>More
          </button>
        </nav>
        {more && (
          <div className="fixed inset-x-0 bottom-14 z-30 border-t border-border bg-surface p-2 shadow-lg md:hidden">
            {items
              .filter((n) => !n.main)
              .map((n) => (
                <Link key={n.href} href={n.href} onClick={() => setMore(false)} className="flex items-center gap-2 rounded-lg px-3 py-2.5 text-sm text-text-2 hover:bg-surface-2">
                  <span aria-hidden className="w-4 text-center">{n.icon}</span>
                  {n.label}
                </Link>
              ))}
            <UserBox user={user} signOutAction={signOutAction} />
          </div>
        )}
      </div>
    </UserCtx.Provider>
  );
}

function UserBox({ user, signOutAction }: { user: SessionUser; signOutAction: () => Promise<void> }) {
  return (
    <form action={signOutAction} className="border-t border-border px-4 py-3">
      <div className="truncate text-sm">{user.email}</div>
      <div className="flex items-center justify-between">
        <span className="text-xs text-text-3">{user.role === "owner" ? "Owner" : "Staff"}</span>
        <button className="text-xs text-text-2 underline-offset-2 hover:underline">Sign out</button>
      </div>
    </form>
  );
}
