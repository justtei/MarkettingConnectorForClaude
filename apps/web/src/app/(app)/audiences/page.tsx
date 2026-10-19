"use client";
import { useState } from "react";
import { useIsOwner } from "@/components/shell";
import { Alert, Button, Card, Empty, Field, Input, Loading, Modal, PageHeader, Select, Textarea } from "@/components/ui";
import { tool, useApi } from "@/lib/client";
import { compact, dateTime } from "@/lib/format";

export default function AudiencesPage() {
  const owner = useIsOwner();
  const { data, error, isLoading, mutate } = useApi<any[]>("/audiences");
  const [open, setOpen] = useState<"custom" | "lookalike" | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const done = async (m: string) => {
    setOpen(null);
    setMsg(m);
    await mutate();
  };
  return (
    <>
      <PageHeader
        title="Audiences"
        sub="Custom audiences (website, engagement, customer lists) and lookalikes, for retargeting ad sets."
        actions={owner && <><Button onClick={() => setOpen("lookalike")} disabled={!data?.length}>New lookalike</Button><Button variant="primary" onClick={() => setOpen("custom")}>New audience</Button></>}
      />
      {msg && <div className="mb-3"><Alert kind="success">{msg}</Alert></div>}
      {isLoading && <Loading />}
      {error && <Alert kind="error">{error.message}</Alert>}
      {data && data.length === 0 && <Empty>No audiences yet.</Empty>}
      {data && data.length > 0 && (
        <Card>
          <div className="-mx-4 overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead className="text-left text-xs text-text-3"><tr><th className="px-4 py-1 font-medium">Name</th><th className="font-medium">Type</th><th className="text-right font-medium">Size</th><th className="font-medium">Status</th><th className="px-4 font-medium">Created</th></tr></thead>
              <tbody>
                {data.map((a) => (
                  <tr key={a.id} className="border-t border-border">
                    <td className="px-4 py-2"><div className="font-medium">{a.name}</div><div className="text-xs text-text-3">{a.id}</div></td>
                    <td>{a.subtype}{a.lookalike ? ` ${Math.round((a.lookalike.ratio ?? 0) * 100)}% ${a.lookalike.country ?? ""}` : ""}</td>
                    <td className="text-right tabular-nums">{a.size_lower ? `${compact(a.size_lower)}–${compact(a.size_upper)}` : "—"}</td>
                    <td className="text-text-2">{a.delivery ?? a.status ?? "—"}</td>
                    <td className="px-4 text-text-2">{dateTime(a.created)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      <p className="mt-3 text-xs text-text-3">Use an audience in an ad set via Claude (“retarget purchasers with …”) or the create_adset tool’s custom_audience_ids.</p>
      {open === "custom" && <CustomDialog onClose={() => setOpen(null)} onDone={done} />}
      {open === "lookalike" && data && <LookalikeDialog sources={data} onClose={() => setOpen(null)} onDone={done} />}
    </>
  );
}

function CustomDialog({ onClose, onDone }: { onClose: () => void; onDone: (m: string) => void }) {
  const [name, setName] = useState("");
  const [source, setSource] = useState<"website" | "engagement" | "customer_list">("engagement");
  const [days, setDays] = useState(30);
  const [event, setEvent] = useState("all_visitors");
  const [eng, setEng] = useState("instagram");
  const [list, setList] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function go() {
    setBusy(true);
    setErr(null);
    try {
      const customers =
        source === "customer_list"
          ? list
              .split(/\r?\n/)
              .map((l) => l.trim())
              .filter(Boolean)
              .map((l) => (l.includes("@") ? { email: l } : { phone: l }))
          : undefined;
      const r = await tool("create_custom_audience", { name, source, retention_days: days, website_event: event, engagement_source: eng, customers });
      onDone(`Audience “${r.name}” created${r.uploaded ? ` (${r.uploaded.received} customers uploaded, ${r.uploaded.skipped} skipped)` : ""}. It fills over a few hours.`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="New custom audience" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={go} loading={busy} disabled={!name}>Create</Button></>}>
      <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="IG engagers 90d" /></Field>
      <Field label="Source">
        <Select value={source} onChange={(e) => setSource(e.target.value as any)}>
          <option value="engagement">People who engaged (Instagram / Page)</option>
          <option value="website">Website visitors (pixel)</option>
          <option value="customer_list">Customer list (phones / emails)</option>
        </Select>
      </Field>
      {source !== "customer_list" && <Field label="Look-back (days)"><Input type="number" min={1} max={180} value={days} onChange={(e) => setDays(Number(e.target.value))} /></Field>}
      {source === "website" && (
        <Field label="Event">
          <Select value={event} onChange={(e) => setEvent(e.target.value)}>
            <option value="all_visitors">All visitors</option>
            <option value="ViewContent">Viewed a product</option>
            <option value="AddToCart">Added to cart</option>
            <option value="InitiateCheckout">Started checkout</option>
            <option value="Purchase">Purchased</option>
          </Select>
        </Field>
      )}
      {source === "engagement" && (
        <Field label="Where"><Select value={eng} onChange={(e) => setEng(e.target.value)}><option value="instagram">Instagram @sandalez_</option><option value="page">Facebook Page</option></Select></Field>
      )}
      {source === "customer_list" && (
        <Field label="One phone or email per line" hint="Phones like 0300-1234567 are converted to 92300…; everything is hashed before upload.">
          <Textarea value={list} onChange={(e) => setList(e.target.value)} className="min-h-40 font-mono text-xs" />
        </Field>
      )}
      {err && <Alert kind="error">{err}</Alert>}
    </Modal>
  );
}

function LookalikeDialog({ sources, onClose, onDone }: { sources: any[]; onClose: () => void; onDone: (m: string) => void }) {
  const [origin, setOrigin] = useState(sources.find((s) => s.subtype !== "LOOKALIKE")?.id ?? "");
  const [ratio, setRatio] = useState(1);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function go() {
    setBusy(true);
    setErr(null);
    try {
      const src = sources.find((s) => s.id === origin);
      const r = await tool("create_lookalike", { name: name || `LAL ${ratio}% PK - ${src?.name ?? origin}`, origin_audience_id: origin, ratio: ratio / 100, country: "PK" });
      onDone(`Lookalike “${r.name}” created.`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal open onClose={onClose} title="New lookalike (Pakistan)" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={go} loading={busy} disabled={!origin}>Create</Button></>}>
      <Field label="Source audience"><Select value={origin} onChange={(e) => setOrigin(e.target.value)}>{sources.filter((s) => s.subtype !== "LOOKALIKE").map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
      <Field label="Size (% of Pakistan)" hint="1% = most similar"><Select value={ratio} onChange={(e) => setRatio(Number(e.target.value))}>{[1, 2, 3, 5, 10].map((r) => <option key={r} value={r}>{r}%</option>)}</Select></Field>
      <Field label="Name (optional)"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
      {err && <Alert kind="error">{err}</Alert>}
    </Modal>
  );
}
