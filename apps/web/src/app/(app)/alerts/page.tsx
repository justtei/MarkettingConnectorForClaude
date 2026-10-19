"use client";
import { useState } from "react";
import { useIsOwner } from "@/components/shell";
import { Alert, Button, Card, Empty, Field, Input, Loading, PageHeader, Select } from "@/components/ui";
import { api, useApi } from "@/lib/client";
import { dateTime } from "@/lib/format";

const METRICS = [
  { value: "cost_per_chat", label: "Cost per chat today (PKR)", op: "gt", threshold: 150 },
  { value: "spend", label: "Spend today (PKR)", op: "gt", threshold: 2000 },
  { value: "frequency", label: "Frequency, last 7 days", op: "gt", threshold: 3 },
  { value: "ctr", label: "CTR today (%)", op: "lt", threshold: 0.8 },
  { value: "spend_stopped", label: "Spend stopped (no spend by noon)", op: "gt", threshold: 0 },
];

export default function AlertsPage() {
  const owner = useIsOwner();
  const alerts = useApi<any[]>("/alerts");
  const events = useApi<any[]>("/alerts/events?limit=30");
  const [metric, setMetric] = useState(METRICS[0]!.value);
  const [op, setOp] = useState("gt");
  const [threshold, setThreshold] = useState("150");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function pickMetric(v: string) {
    const m = METRICS.find((x) => x.value === v)!;
    setMetric(v);
    setOp(m.op);
    setThreshold(String(m.threshold));
  }

  async function create() {
    setBusy(true);
    setErr(null);
    try {
      await api("/alerts", { body: { metric, operator: op, threshold: Number(threshold) } });
      await alerts.mutate();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function patch(id: string, body: Record<string, unknown>) {
    await api(`/alerts/${id}`, { method: "PATCH", body });
    await alerts.mutate();
  }
  async function remove(id: string) {
    if (!window.confirm("Delete this alert rule?")) return;
    await api(`/alerts/${id}`, { method: "DELETE" });
    await alerts.mutate();
  }

  return (
    <>
      <PageHeader title="Alerts" sub="Checked after every sync (every 3 hours). Fired alerts are emailed when email is set up in Settings." />
      {owner && (
        <Card title="New rule" className="mb-4">
          <div className="grid gap-3 sm:grid-cols-[2fr_1fr_1fr_auto] sm:items-end">
            <Field label="Metric"><Select value={metric} onChange={(e) => pickMetric(e.target.value)}>{METRICS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}</Select></Field>
            {metric !== "spend_stopped" ? (
              <>
                <Field label="When"><Select value={op} onChange={(e) => setOp(e.target.value)}><option value="gt">above</option><option value="lt">below</option></Select></Field>
                <Field label="Threshold"><Input type="number" step="any" min={0} value={threshold} onChange={(e) => setThreshold(e.target.value)} /></Field>
              </>
            ) : (
              <div className="sm:col-span-2" />
            )}
            <Button variant="primary" onClick={create} loading={busy}>Add</Button>
          </div>
          {err && <div className="mt-3"><Alert kind="error">{err}</Alert></div>}
        </Card>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Rules">
          {alerts.isLoading && <Loading />}
          {alerts.data?.length === 0 && <Empty>No alert rules.</Empty>}
          <ul className="divide-y divide-border">
            {alerts.data?.map((a) => {
              const muted = a.muted_until && new Date(a.muted_until) > new Date();
              return (
                <li key={a.id} className="space-y-1 py-2.5 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{a.name}</span>
                    <span className="text-xs text-text-3">{!a.active ? "Off" : muted ? `Muted until ${dateTime(a.muted_until)}` : "On"}</span>
                  </div>
                  <div className="text-xs text-text-3">Last fired: {dateTime(a.last_triggered_at)}</div>
                  {owner && (
                    <div className="flex flex-wrap gap-1.5">
                      <Button size="sm" onClick={() => patch(a.id, { active: !a.active })}>{a.active ? "Turn off" : "Turn on"}</Button>
                      {muted ? <Button size="sm" onClick={() => patch(a.id, { mute_hours: null })}>Unmute</Button> : <Button size="sm" onClick={() => patch(a.id, { mute_hours: 24 })}>Mute 24h</Button>}
                      <Button size="sm" variant="ghost" onClick={() => remove(a.id)}>Delete</Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </Card>
        <Card title="Recent alerts">
          {events.isLoading && <Loading />}
          {events.data?.length === 0 && <Empty>Nothing fired yet.</Empty>}
          <ul className="divide-y divide-border">
            {events.data?.map((e) => (
              <li key={e.id} className="py-2 text-sm">
                <div className="flex gap-2"><span aria-hidden className="font-bold text-critical-text">!</span><span>{e.message}</span></div>
                <div className="pl-4 text-xs text-text-3">{dateTime(e.at)}</div>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </>
  );
}
