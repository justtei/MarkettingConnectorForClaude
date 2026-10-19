"use client";
import { useEffect, useState } from "react";
import { Alert, Card, Empty, Loading, PageHeader, Segmented, Select, cx } from "@/components/ui";
import { tool } from "@/lib/client";
import { num, pct, pkr } from "@/lib/format";

type Tab = "breakdowns" | "placements" | "fatigue" | "waste";
const PRESETS = [
  { value: "last_7d", label: "7d" },
  { value: "last_14d", label: "14d" },
  { value: "last_30d", label: "30d" },
];

/** Live insights from Meta (these call Meta, so they are on demand rather than synced). */
export default function InsightsPage() {
  const [tab, setTab] = useState<Tab>("breakdowns");
  const [preset, setPreset] = useState("last_7d");
  return (
    <>
      <PageHeader
        title="Insights"
        sub="Live from Meta: breakdowns, placements, fatigue and wasted spend."
        actions={<Segmented label="Period" value={preset} onChange={setPreset} options={PRESETS} />}
      />
      <div className="mb-4 overflow-x-auto">
        <Segmented
          label="Report"
          value={tab}
          onChange={setTab}
          options={[
            { value: "breakdowns", label: "Age & gender" },
            { value: "placements", label: "Placements" },
            { value: "fatigue", label: "Fatigue" },
            { value: "waste", label: "Wasted spend" },
          ]}
        />
      </div>
      {tab === "breakdowns" && <Breakdowns preset={preset} />}
      {tab === "placements" && <Placements preset={preset} />}
      {tab === "fatigue" && <Fatigue />}
      {tab === "waste" && <Waste preset={preset} />}
    </>
  );
}

function useTool(name: string, input: Record<string, unknown>) {
  const key = JSON.stringify([name, input]);
  const [state, setState] = useState<{ data?: any; error?: string; loading: boolean }>({ loading: true });
  useEffect(() => {
    let live = true;
    setState({ loading: true });
    tool(name, input)
      .then((data) => live && setState({ data, loading: false }))
      .catch((e) => live && setState({ error: (e as Error).message, loading: false }));
    return () => {
      live = false;
    };
  }, [key]);
  return state;
}

/** Horizontal bar list: single magnitude, one hue, value labels in text ink. */
function BarList({ rows, value, label, fmt }: { rows: any[]; value: (r: any) => number; label: (r: any) => string; fmt: (v: number) => string }) {
  const max = Math.max(...rows.map(value), 1);
  return (
    <ul className="space-y-1.5">
      {rows.map((r, i) => (
        <li key={i} className="grid grid-cols-[8rem_1fr_6rem] items-center gap-2 text-sm">
          <span className="truncate text-text-2">{label(r)}</span>
          <div className="h-3 rounded bg-surface-2"><div className="h-3 rounded-r" style={{ width: `${(value(r) / max) * 100}%`, background: "var(--series-1)" }} /></div>
          <span className="text-right tabular-nums">{fmt(value(r))}</span>
        </li>
      ))}
    </ul>
  );
}

function Breakdowns({ preset }: { preset: string }) {
  const [dim, setDim] = useState<"age" | "gender">("age");
  const s = useTool("get_insights", { level: "account", date_preset: preset, breakdowns: [dim] });
  if (s.loading) return <Loading />;
  if (s.error) return <Alert kind="error">{s.error}</Alert>;
  const rows = (s.data.rows as any[]).slice().sort((a, b) => (a.breakdown[dim] < b.breakdown[dim] ? -1 : 1));
  if (!rows.length) return <Empty>No delivery in this period.</Empty>;
  return (
    <div className="space-y-3">
      <Select value={dim} onChange={(e) => setDim(e.target.value as any)} className="w-auto" aria-label="Breakdown">
        <option value="age">By age</option>
        <option value="gender">By gender</option>
      </Select>
      <div className="grid gap-3 lg:grid-cols-2">
        <Card title="Spend"><BarList rows={rows} value={(r) => r.spend} label={(r) => r.breakdown[dim]} fmt={(v) => pkr(v)} /></Card>
        <Card title="Cost per chat"><BarList rows={rows.filter((r) => r.cost_per_conversation !== null)} value={(r) => r.cost_per_conversation} label={(r) => r.breakdown[dim]} fmt={(v) => pkr(v)} /></Card>
      </div>
      <Table rows={rows} first={(r) => r.breakdown[dim]} firstLabel={dim === "age" ? "Age" : "Gender"} />
    </div>
  );
}

function Table({ rows, first, firstLabel }: { rows: any[]; first: (r: any) => string; firstLabel: string }) {
  return (
    <Card>
      <div className="-mx-4 overflow-x-auto">
        <table className="w-full min-w-[520px] text-sm">
          <thead className="text-left text-xs text-text-3"><tr><th className="px-4 py-1 font-medium">{firstLabel}</th><th className="text-right font-medium">Spend</th><th className="text-right font-medium">Impr.</th><th className="text-right font-medium">CTR</th><th className="text-right font-medium">Chats</th><th className="px-4 text-right font-medium">Cost/chat</th></tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-t border-border">
                <td className="px-4 py-1.5">{first(r)}</td><td className="text-right tabular-nums">{pkr(r.spend)}</td><td className="text-right tabular-nums">{num(r.impressions)}</td><td className="text-right tabular-nums">{pct(r.ctr, 2)}</td><td className="text-right tabular-nums">{num(r.conversations)}</td><td className="px-4 text-right tabular-nums">{pkr(r.cost_per_conversation)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function Placements({ preset }: { preset: string }) {
  const s = useTool("placement_report", { date_preset: preset });
  if (s.loading) return <Loading />;
  if (s.error) return <Alert kind="error">{s.error}</Alert>;
  const d = s.data;
  if (!d.placements.length) return <Empty>No delivery in this period.</Empty>;
  return (
    <div className="space-y-3">
      {d.summary.length > 0 && <Alert kind="warning">Expensive placements: {d.summary.join("; ")}</Alert>}
      <Card title={`Average cost per chat ${pkr(d.total.cost_per_conversation)}`}>
        <ul className="divide-y divide-border">
          {d.placements.map((p: any) => (
            <li key={`${p.platform}-${p.position}`} className="grid grid-cols-[1fr_auto] gap-2 py-2 text-sm sm:grid-cols-[1fr_6rem_6rem_6rem_7rem]">
              <span>
                {p.platform} / {p.position.replace(/_/g, " ")}{" "}
                {p.flag && (
                  <span className={cx("ml-1 rounded-full border border-border px-1.5 text-xs", p.flag === "expensive" ? "text-critical-text" : "text-good-text")}>
                    {p.flag === "expensive" ? "! expensive" : "✓ efficient"}
                  </span>
                )}
              </span>
              <span className="text-right tabular-nums">{pkr(p.spend)}</span>
              <span className="hidden text-right tabular-nums text-text-2 sm:block">{pct(p.spend_share_pct)}</span>
              <span className="hidden text-right tabular-nums sm:block">{num(p.conversations)} chats</span>
              <span className="hidden text-right tabular-nums sm:block">{pkr(p.cost_per_conversation)}</span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

function Fatigue() {
  const s = useTool("detect_fatigue", {});
  if (s.loading) return <Loading />;
  if (s.error) return <Alert kind="error">{s.error}</Alert>;
  const d = s.data;
  return (
    <div className="space-y-3">
      <p className="text-sm text-text-2">
        Last {d.window.since} → {d.window.until}; recent days from {d.window.recent_since}. {d.fatigued_count} ad(s) look tired.
      </p>
      {d.ads.length === 0 && <Empty>Not enough delivery to judge fatigue.</Empty>}
      {d.ads.map((a: any) => (
        <Card key={a.ad_id} title={<span>{a.ad_name} {a.fatigued && <span className={cx("ml-1 text-xs", a.severity === "high" ? "text-critical-text" : "text-text-2")}>! {a.severity}</span>}</span>}>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
            <dt className="text-text-3">Frequency</dt><dd className="tabular-nums">{a.frequency}</dd>
            <dt className="text-text-3">CTR before → recent</dt><dd className="tabular-nums">{pct(a.ctr_baseline, 2)} → {pct(a.ctr_recent, 2)}</dd>
            <dt className="text-text-3">Cost/chat before → recent</dt><dd className="tabular-nums">{pkr(a.cost_per_chat_baseline)} → {pkr(a.cost_per_chat_recent)}</dd>
            <dt className="text-text-3">Spend</dt><dd className="tabular-nums">{pkr(a.spend)}</dd>
          </dl>
          {a.reasons.length > 0 && <p className="mt-2 text-sm">{a.reasons.join(" · ")}</p>}
          {a.recommendation && <p className="mt-1 text-sm text-text-2">{a.recommendation}</p>}
        </Card>
      ))}
    </div>
  );
}

function Waste({ preset }: { preset: string }) {
  const s = useTool("wasted_spend_report", { date_preset: preset, min_spend: 300 });
  if (s.loading) return <Loading />;
  if (s.error) return <Alert kind="error">{s.error}</Alert>;
  const d = s.data;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-2">
        <div className="rounded-xl border border-border bg-surface p-3"><div className="text-xs text-text-3">Total spend</div><div className="text-lg font-semibold">{pkr(d.total_spend)}</div></div>
        <div className="rounded-xl border border-border bg-surface p-3"><div className="text-xs text-text-3">Likely wasted</div><div className="text-lg font-semibold">{pkr(d.wasted_spend)}</div><div className="text-xs text-text-3">{pct(d.wasted_pct)} of spend</div></div>
        <div className="rounded-xl border border-border bg-surface p-3"><div className="text-xs text-text-3">Avg cost/chat</div><div className="text-lg font-semibold">{pkr(d.average_cost_per_chat)}</div></div>
      </div>
      <Alert>{d.recommendation}</Alert>
      {d.items.map((i: any) => (
        <div key={i.ad_id} className="rounded-lg border border-border bg-surface px-3 py-2 text-sm">
          <div className="font-medium">{i.ad_name} <span className="text-text-3">· {i.campaign_name}</span></div>
          <div className="text-text-2">{i.reason} — wasted ≈ {pkr(i.wasted_spend)}</div>
        </div>
      ))}
    </div>
  );
}
