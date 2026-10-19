"use client";
import { useState } from "react";
import { TrendChart } from "@/components/charts";
import { useIsOwner } from "@/components/shell";
import { Alert, Button, Loading, PageHeader, Segmented, Stat } from "@/components/ui";
import { api, useApi } from "@/lib/client";
import { dateTime, num, pct, pkr } from "@/lib/format";

type Kpis = {
  spend: number;
  conversations: number;
  cost_per_chat: number | null;
  orders: number;
  refused: number;
  revenue: number;
  cost_per_order: number | null;
  refusal_rate_pct: number | null;
  roas: number | null;
  whatsapp_chats: number;
};

type Window = "today" | "last_7d" | "last_30d";

export default function OverviewPage() {
  const [days, setDays] = useState(30);
  const [win, setWin] = useState<Window>("last_7d");
  const { data, error, isLoading, mutate } = useApi<any>(`/overview?days=${days}`);
  const owner = useIsOwner();
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);

  async function syncNow() {
    setSyncing(true);
    setSyncMsg(null);
    try {
      const r = await api("/sync", { body: { days: 7 } });
      setSyncMsg(`Synced ${r.structure.campaigns} campaigns, ${r.insights.upserted} daily rows.`);
      await mutate();
    } catch (e) {
      setSyncMsg(`Sync failed: ${(e as Error).message}`);
    } finally {
      setSyncing(false);
    }
  }

  const k: Kpis | undefined = data?.[win];
  return (
    <>
      <PageHeader
        title="Overview"
        sub={
          data?.last_sync ? (
            <>
              Last sync {dateTime(data.last_sync.at)}
              {data.last_sync.ok === false && <span className="text-critical-text"> — failed: {data.last_sync.error}</span>}
            </>
          ) : (
            "Not synced yet"
          )
        }
        actions={owner && <Button onClick={syncNow} loading={syncing}>Sync from Meta</Button>}
      />
      {syncMsg && <div className="mb-3"><Alert kind={syncMsg.startsWith("Sync failed") ? "error" : "success"}>{syncMsg}</Alert></div>}
      {error && <Alert kind="error">{error.message}</Alert>}
      {isLoading && <Loading />}
      {data && k && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Segmented
              label="Period"
              value={win}
              onChange={setWin}
              options={[
                { value: "today", label: "Today" },
                { value: "last_7d", label: "7 days" },
                { value: "last_30d", label: "30 days" },
              ]}
            />
            <span className="text-xs text-text-3">{data.active_campaigns} active campaign(s)</span>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            <Stat label="Spend" value={pkr(k.spend)} />
            <Stat label="Chats" value={num(k.conversations)} sub={k.whatsapp_chats ? `${num(k.whatsapp_chats)} via webhook` : undefined} />
            <Stat label="Cost per chat" value={pkr(k.cost_per_chat)} />
            <Stat label="Orders" value={num(k.orders)} sub={k.refused ? `${num(k.refused)} refused` : undefined} />
            <Stat label="Cost per order" value={pkr(k.cost_per_order)} />
            <Stat label="Refusal rate" value={pct(k.refusal_rate_pct)} sub={k.roas !== null ? `ROAS ${k.roas}x` : undefined} />
          </div>

          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">Trend</h2>
            <Segmented label="Chart range" value={days} onChange={setDays} options={[{ value: 7, label: "7d" }, { value: 30, label: "30d" }, { value: 90, label: "90d" }]} />
          </div>
          <div className="grid gap-3 lg:grid-cols-2">
            <TrendChart title="Spend per day (PKR)" kind="bar" data={data.series} series={[{ key: "spend", label: "Spend", slot: 1 }]} fmt={(v) => pkr(v)} />
            <TrendChart
              title="Chats and orders per day"
              data={data.series}
              series={[
                { key: "conversations", label: "Chats", slot: 1 },
                { key: "orders", label: "Orders", slot: 2 },
              ]}
            />
            <TrendChart title="Cost per chat (PKR)" data={data.series} series={[{ key: "cost_per_chat", label: "Cost per chat", slot: 1 }]} fmt={(v) => pkr(v)} />
            <TrendChart title="Cost per order (PKR)" data={data.series} series={[{ key: "cost_per_order", label: "Cost per order", slot: 1 }]} fmt={(v) => pkr(v)} />
          </div>
          {!data.last_sync && <Alert>No data yet. Click “Sync from Meta” (or wait for the worker, every 3 hours).</Alert>}
        </div>
      )}
    </>
  );
}
