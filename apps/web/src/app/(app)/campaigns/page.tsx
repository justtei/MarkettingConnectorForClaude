"use client";
import Link from "next/link";
import { useState } from "react";
import { BudgetDialog, DuplicateDialog, StatusDialog, type Target } from "@/components/actions";
import { useIsOwner } from "@/components/shell";
import { Alert, Button, Empty, Loading, PageHeader, Segmented, StatusBadge, cx } from "@/components/ui";
import { useApi } from "@/lib/client";
import { num, pct, pkr } from "@/lib/format";

type Stats = { spend: number; conversations: number; cost_per_chat: number | null; ctr: number; impressions: number };

function StatsLine({ s }: { s: Stats }) {
  return (
    <div className="grid grid-cols-4 gap-2 text-right text-xs tabular-nums sm:text-sm">
      <span title="Spend">{pkr(s.spend)}</span>
      <span title="Chats">{num(s.conversations)}</span>
      <span title="Cost per chat">{pkr(s.cost_per_chat)}</span>
      <span title="CTR">{pct(s.ctr, 2)}</span>
    </div>
  );
}

export default function CampaignsPage() {
  const owner = useIsOwner();
  const [days, setDays] = useState(7);
  const [archived, setArchived] = useState(false);
  const { data, error, isLoading, mutate } = useApi<any>(`/campaigns?days=${days}&archived=${archived ? 1 : 0}`);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [statusTarget, setStatusTarget] = useState<{ t: Target; next: "ACTIVE" | "PAUSED" | "ARCHIVED" } | null>(null);
  const [budgetTarget, setBudgetTarget] = useState<Target | null>(null);
  const [dupTarget, setDupTarget] = useState<Target | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const done = async (m: string) => {
    setStatusTarget(null);
    setBudgetTarget(null);
    setDupTarget(null);
    setMsg(m);
    await mutate();
  };

  const statusButtons = (t: Target) =>
    owner && (
      <div className="flex flex-wrap gap-1.5">
        {t.status === "ACTIVE" ? (
          <Button size="sm" onClick={() => setStatusTarget({ t, next: "PAUSED" })}>Pause</Button>
        ) : t.status === "PAUSED" ? (
          <Button size="sm" variant="primary" onClick={() => setStatusTarget({ t, next: "ACTIVE" })}>Activate</Button>
        ) : null}
        {t.daily_budget ? <Button size="sm" onClick={() => setBudgetTarget(t)}>Budget</Button> : null}
        {t.type === "campaign" && <Button size="sm" variant="ghost" onClick={() => setDupTarget(t)}>Duplicate</Button>}
        {t.status !== "ARCHIVED" && <Button size="sm" variant="ghost" onClick={() => setStatusTarget({ t, next: "ARCHIVED" })}>Archive</Button>}
      </div>
    );

  return (
    <>
      <PageHeader
        title="Campaigns"
        sub="Campaign → ad set → ad, from the last sync. Actions go to Meta immediately."
        actions={
          <>
            <Segmented label="Stats period" value={days} onChange={setDays} options={[{ value: 1, label: "Today" }, { value: 7, label: "7d" }, { value: 30, label: "30d" }]} />
            {owner && <Link href="/new"><Button variant="primary">New campaign</Button></Link>}
          </>
        }
      />
      {msg && <div className="mb-3"><Alert kind="success">{msg}</Alert></div>}
      {error && <Alert kind="error">{error.message}</Alert>}
      {isLoading && <Loading />}
      {data && data.campaigns.length === 0 && <Empty>No campaigns yet. Create one or run a sync.</Empty>}
      {data && data.campaigns.length > 0 && (
        <div className="space-y-3">
          <div className="hidden grid-cols-[1fr_minmax(0,22rem)] gap-4 px-4 text-xs font-medium text-text-3 md:grid">
            <span />
            <div className="grid grid-cols-4 gap-2 text-right"><span>Spend</span><span>Chats</span><span>Cost/chat</span><span>CTR</span></div>
          </div>
          {data.campaigns.map((c: any) => {
            const ct: Target = { id: c.id, name: c.name, type: "campaign", status: c.status, daily_budget: c.daily_budget };
            return (
              <section key={c.id} className="rounded-xl border border-border bg-surface">
                <div className="grid gap-3 p-4 md:grid-cols-[1fr_minmax(0,22rem)] md:items-center md:gap-4">
                  <div className="min-w-0 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <button onClick={() => setOpen((o) => ({ ...o, [c.id]: !o[c.id] }))} aria-expanded={!!open[c.id]} className="text-text-3" aria-label="Toggle ad sets">
                        {open[c.id] ? "▾" : "▸"}
                      </button>
                      <span className="font-semibold">{c.name}</span>
                      <StatusBadge status={c.effective_status ?? c.status} />
                    </div>
                    <div className="text-xs text-text-3">
                      {c.objective} · {c.adsets.length} ad set(s) · via {c.created_via}
                      {c.daily_budget ? ` · ${pkr(c.daily_budget)}/day (campaign budget)` : ""}
                    </div>
                    {statusButtons(ct)}
                  </div>
                  <StatsLine s={c.stats} />
                </div>
                {open[c.id] && (
                  <div className="border-t border-border">
                    {c.adsets.map((s: any) => {
                      const st: Target = { id: s.id, name: s.name, type: "adset", status: s.status, daily_budget: s.daily_budget };
                      return (
                        <div key={s.id} className="border-b border-border last:border-b-0">
                          <div className="grid gap-3 py-3 pl-8 pr-4 md:grid-cols-[1fr_minmax(0,22rem)] md:items-center md:gap-4">
                            <div className="min-w-0 space-y-1.5">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="font-medium">{s.name}</span>
                                <StatusBadge status={s.effective_status ?? s.status} />
                              </div>
                              <div className="text-xs text-text-3">
                                {s.daily_budget ? `${pkr(s.daily_budget)}/day` : "campaign budget"} · {s.destination ?? "—"} · {s.optimization ?? "—"}
                              </div>
                              {statusButtons(st)}
                            </div>
                            <StatsLine s={s.stats} />
                          </div>
                          <ul>
                            {s.ads.map((a: any) => (
                              <li key={a.id} className="grid gap-2 border-t border-border/60 py-2.5 pl-14 pr-4 md:grid-cols-[1fr_minmax(0,22rem)] md:items-center md:gap-4">
                                <div className="flex min-w-0 items-center gap-2">
                                  {a.creative?.thumbnailUrl && <img src={a.creative.thumbnailUrl} alt="" className="h-8 w-8 rounded object-cover" />}
                                  <Link href={`/ads/${a.id}`} className="truncate text-sm underline-offset-2 hover:underline">{a.name}</Link>
                                  <StatusBadge status={a.effective_status ?? a.status} />
                                </div>
                                <div className={cx(a.stats.impressions === 0 && "text-text-3")}><StatsLine s={a.stats} /></div>
                              </li>
                            ))}
                            {s.ads.length === 0 && <li className="py-2 pl-14 text-xs text-text-3">No ads</li>}
                          </ul>
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            );
          })}
          <label className="flex items-center gap-2 text-sm text-text-2">
            <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> Show archived
          </label>
        </div>
      )}
      {statusTarget && <StatusDialog target={statusTarget.t} next={statusTarget.next} onClose={() => setStatusTarget(null)} onDone={done} />}
      {budgetTarget && <BudgetDialog target={budgetTarget} onClose={() => setBudgetTarget(null)} onDone={done} />}
      {dupTarget && <DuplicateDialog target={dupTarget} onClose={() => setDupTarget(null)} onDone={done} />}
    </>
  );
}
