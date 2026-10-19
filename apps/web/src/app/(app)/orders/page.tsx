"use client";
import { useMemo, useState } from "react";
import { TrendChart } from "@/components/charts";
import { Alert, Button, Card, Empty, Field, Input, Loading, Modal, PageHeader, Select, Stat, Textarea } from "@/components/ui";
import { api, useApi } from "@/lib/client";
import { addDays, num, pct, pkr, shortDate, todayPk } from "@/lib/format";

interface OrderRow {
  id: string;
  date: string;
  ad_id: string | null;
  ad_name: string | null;
  chats: number;
  orders: number;
  refused: number;
  delivered: number;
  revenue: number;
  note: string | null;
  created_by: string | null;
}

export default function OrdersPage() {
  const [since, setSince] = useState(addDays(todayPk(), -29));
  const [until, setUntil] = useState(todayPk());
  const q = `since=${since}&until=${until}`;
  const rows = useApi<OrderRow[]>(`/orders?${q}`);
  const summary = useApi<any>(`/orders/summary?${q}&group_by=day`);
  const chats = useApi<any[]>(`/orders/chats?${q}`);
  const campaigns = useApi<any>(`/campaigns?days=30&archived=1`);
  const [editing, setEditing] = useState<Partial<OrderRow> | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const ads = useMemo(
    () => (campaigns.data?.campaigns ?? []).flatMap((c: any) => c.adsets.flatMap((s: any) => s.ads.map((a: any) => ({ id: a.id, name: `${a.name} (${c.name})` })))),
    [campaigns.data],
  );
  const chatTotal = (chats.data ?? []).reduce((s, c) => s + c.chats, 0);

  async function refresh(m?: string) {
    setEditing(null);
    setImportOpen(false);
    if (m) setMsg(m);
    await Promise.all([rows.mutate(), summary.mutate(), chats.mutate()]);
  }

  async function remove(r: OrderRow) {
    if (!window.confirm(`Delete the ${shortDate(r.date)} row (${r.orders} orders)?`)) return;
    await api(`/orders/${r.id}`, { method: "DELETE" });
    await refresh("Row deleted.");
  }

  const t = summary.data?.total;
  return (
    <>
      <PageHeader
        title="Orders"
        sub="Daily WhatsApp results. Cost per order joins this log with ad spend."
        actions={
          <>
            <Button onClick={() => setImportOpen(true)}>Import CSV</Button>
            <Button variant="primary" onClick={() => setEditing({ date: todayPk(), chats: 0, orders: 0, refused: 0, revenue: 0 })}>Add row</Button>
          </>
        }
      />
      <div className="mb-4 flex flex-wrap items-end gap-2">
        <Field label="From"><Input type="date" value={since} max={until} onChange={(e) => setSince(e.target.value)} /></Field>
        <Field label="To"><Input type="date" value={until} min={since} onChange={(e) => setUntil(e.target.value)} /></Field>
      </div>
      {msg && <div className="mb-3"><Alert kind="success">{msg}</Alert></div>}
      {summary.error && <Alert kind="error">{summary.error.message}</Alert>}
      {t && (
        <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          <Stat label="Spend" value={pkr(t.spend)} />
          <Stat label="Orders" value={num(t.orders)} sub={`${num(t.delivered)} delivered`} />
          <Stat label="Cost per order" value={pkr(t.cost_per_order)} sub={`${pkr(t.cost_per_delivered_order)} per delivered`} />
          <Stat label="Refusal rate" value={pct(t.refusal_rate_pct)} />
          <Stat label="Revenue" value={pkr(t.revenue)} sub={t.roas !== null ? `ROAS ${t.roas}x` : undefined} />
          <Stat label="Chat → order" value={pct(t.chat_to_order_pct)} sub={chatTotal ? `${num(chatTotal)} chats via webhook` : `${num(t.chats_logged)} chats logged`} />
        </div>
      )}
      {summary.data?.rows?.length > 0 && (
        <div className="mb-4">
          <TrendChart
            title="Orders and refused per day"
            data={summary.data.rows.map((r: any) => ({ date: r.key, orders: r.orders, refused: r.refused }))}
            series={[{ key: "orders", label: "Orders", slot: 1 }, { key: "refused", label: "Refused", slot: 2 }]}
          />
        </div>
      )}
      <Card title="Order log">
        {rows.isLoading && <Loading />}
        {rows.error && <Alert kind="error">{rows.error.message}</Alert>}
        {rows.data && rows.data.length === 0 && <Empty>No rows in this period.</Empty>}
        {rows.data && rows.data.length > 0 && (
          <div className="-mx-4 overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="text-left text-xs text-text-3">
                <tr>
                  <th className="px-4 py-2 font-medium">Date</th>
                  <th className="py-2 font-medium">Ad</th>
                  <th className="py-2 text-right font-medium">Chats</th>
                  <th className="py-2 text-right font-medium">Orders</th>
                  <th className="py-2 text-right font-medium">Refused</th>
                  <th className="py-2 text-right font-medium">Revenue</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                {rows.data.map((r) => (
                  <tr key={r.id} className="border-t border-border">
                    <td className="whitespace-nowrap px-4 py-2">{shortDate(r.date)}</td>
                    <td className="max-w-[16rem] truncate py-2 text-text-2" title={r.note ?? undefined}>{r.ad_name ?? "—"}{r.note ? <span className="block truncate text-xs text-text-3">{r.note}</span> : null}</td>
                    <td className="py-2 text-right tabular-nums">{r.chats}</td>
                    <td className="py-2 text-right tabular-nums">{r.orders}</td>
                    <td className="py-2 text-right tabular-nums">{r.refused}</td>
                    <td className="py-2 text-right tabular-nums">{pkr(r.revenue)}</td>
                    <td className="whitespace-nowrap px-4 py-2 text-right">
                      <Button size="sm" variant="ghost" onClick={() => setEditing(r)}>Edit</Button>
                      <Button size="sm" variant="ghost" onClick={() => remove(r)}>Delete</Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {editing && <OrderDialog row={editing} ads={ads} onClose={() => setEditing(null)} onDone={refresh} />}
      {importOpen && <ImportDialog onClose={() => setImportOpen(false)} onDone={refresh} />}
    </>
  );
}

function OrderDialog({ row, ads, onClose, onDone }: { row: Partial<OrderRow>; ads: { id: string; name: string }[]; onClose: () => void; onDone: (m: string) => void }) {
  const [f, setF] = useState({
    date: row.date ?? todayPk(),
    ad_id: row.ad_id ?? "",
    chats: String(row.chats ?? 0),
    orders: String(row.orders ?? 0),
    refused: String(row.refused ?? 0),
    revenue: String(row.revenue ?? 0),
    note: row.note ?? "",
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const invalid = Number(f.refused) > Number(f.orders) ? "Refused cannot be more than orders." : null;

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      const body = {
        date: f.date,
        chats: Number(f.chats),
        orders: Number(f.orders),
        refused: Number(f.refused),
        revenue: Number(f.revenue),
        ...(row.id ? { ad_id: f.ad_id || null, note: f.note || null } : { ad_id: f.ad_id || undefined, note: f.note || undefined }),
      };
      if (row.id) await api(`/orders/${row.id}`, { method: "PATCH", body });
      else await api("/orders", { body });
      onDone(row.id ? "Row updated." : "Row added.");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={row.id ? "Edit row" : "Add orders"} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save} loading={busy} disabled={!!invalid}>Save</Button></>}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Date"><Input type="date" value={f.date} onChange={set("date")} /></Field>
        <Field label="Ad (optional)">
          <Select value={f.ad_id} onChange={set("ad_id")}>
            <option value="">Not linked</option>
            {ads.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </Select>
        </Field>
        <Field label="Chats"><Input type="number" min={0} inputMode="numeric" value={f.chats} onChange={set("chats")} /></Field>
        <Field label="Orders"><Input type="number" min={0} inputMode="numeric" value={f.orders} onChange={set("orders")} /></Field>
        <Field label="Refused (COD returns)" error={invalid}><Input type="number" min={0} inputMode="numeric" value={f.refused} onChange={set("refused")} /></Field>
        <Field label="Revenue (PKR)"><Input type="number" min={0} inputMode="numeric" value={f.revenue} onChange={set("revenue")} /></Field>
      </div>
      <Field label="Note"><Input value={f.note} onChange={set("note")} maxLength={1000} /></Field>
      {err && <Alert kind="error">{err}</Alert>}
    </Modal>
  );
}

function ImportDialog({ onClose, onDone }: { onClose: () => void; onDone: (m: string) => void }) {
  const [csv, setCsv] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ imported: number; errors: { line: number; error: string }[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function go() {
    setBusy(true);
    setErr(null);
    try {
      const r = await api("/orders/import", { body: { csv } });
      setResult(r);
      if (r.errors.length === 0) onDone(`Imported ${r.imported} row(s).`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={() => (result ? onDone(`Imported ${result.imported} row(s).`) : onClose())} title="Import orders from CSV" footer={<><Button onClick={onClose}>Close</Button><Button variant="primary" onClick={go} loading={busy} disabled={!csv.trim()}>Import</Button></>}>
      <p className="text-sm text-text-2">Columns: <code>date,ad_id,chats,orders,refused,revenue,note</code> (header row required; ad_id, refused and note optional).</p>
      <input type="file" accept=".csv,text/csv" onChange={async (e) => { const file = e.target.files?.[0]; if (file) setCsv(await file.text()); }} className="text-sm" />
      <Textarea value={csv} onChange={(e) => setCsv(e.target.value)} placeholder={"date,ad_id,chats,orders,refused,revenue,note\n2026-10-15,,40,12,2,36000,"} className="min-h-40 font-mono text-xs" />
      {result && (
        <Alert kind={result.errors.length ? "warning" : "success"}>
          Imported {result.imported} row(s).
          {result.errors.length > 0 && <ul className="mt-1 list-disc pl-4">{result.errors.map((e) => <li key={e.line}>Line {e.line}: {e.error}</li>)}</ul>}
        </Alert>
      )}
      {err && <Alert kind="error">{err}</Alert>}
    </Modal>
  );
}
