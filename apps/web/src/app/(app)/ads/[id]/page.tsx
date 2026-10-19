"use client";
import Link from "next/link";
import { use, useState } from "react";
import { StatusDialog, type Target } from "@/components/actions";
import { TrendChart } from "@/components/charts";
import { useIsOwner } from "@/components/shell";
import { Alert, Button, Card, Field, Input, Loading, Modal, PageHeader, Select, Stat, StatusBadge, Textarea } from "@/components/ui";
import { api, fileToBase64, tool, useApi } from "@/lib/client";
import { num, pct, pkr, shortDate } from "@/lib/format";

/** Meta returns an <iframe> snippet; render it ourselves, sandboxed, and only for facebook.com. */
function Preview({ html }: { html: string | null }) {
  const src = html ? /src="([^"]+)"/.exec(html)?.[1]?.replace(/&amp;/g, "&") : null;
  let ok = false;
  try {
    ok = !!src && /(^|\.)facebook\.com$/.test(new URL(src).hostname);
  } catch {
    ok = false;
  }
  if (!ok) return <p className="text-sm text-text-3">Preview not available.</p>;
  return <iframe src={src!} title="Ad preview" sandbox="allow-scripts allow-same-origin allow-popups" className="h-[460px] w-full max-w-[340px] rounded-lg border border-border bg-white" />;
}

export default function AdPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const owner = useIsOwner();
  const [days, setDays] = useState(30);
  const { data, error, isLoading, mutate } = useApi<any>(`/ads/${id}?days=${days}`);
  const [status, setStatus] = useState<"ACTIVE" | "PAUSED" | null>(null);
  const [swap, setSwap] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [dupBusy, setDupBusy] = useState(false);

  if (isLoading) return <Loading />;
  if (error) return <Alert kind="error">{error.message}</Alert>;
  if (!data) return null;
  const t = data.totals;
  const target: Target = { id: data.id, name: data.name, type: "ad", status: data.status };

  async function duplicate() {
    setDupBusy(true);
    setErr(null);
    try {
      const r = await tool("add_ad_to_adset", { adset_id: data.adset.id, name: `${data.name} - Copy`, creative_id: data.creative?.id });
      setMsg(`Created a paused copy (ad ${r.ad_id}).`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setDupBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        title={data.name}
        sub={
          <>
            <Link href="/campaigns" className="underline-offset-2 hover:underline">{data.campaign.name}</Link> › {data.adset.name}
            {data.adset.daily_budget ? ` · ${pkr(data.adset.daily_budget)}/day` : ""}
          </>
        }
        actions={
          <>
            <StatusBadge status={data.effective_status ?? data.status} />
            {owner && (data.status === "ACTIVE" ? <Button size="sm" onClick={() => setStatus("PAUSED")}>Pause</Button> : <Button size="sm" variant="primary" onClick={() => setStatus("ACTIVE")}>Activate</Button>)}
            {owner && <Button size="sm" onClick={duplicate} loading={dupBusy} disabled={!data.creative}>Duplicate</Button>}
            {owner && <Button size="sm" onClick={() => setSwap(true)}>Swap creative</Button>}
          </>
        }
      />
      {msg && <div className="mb-3"><Alert kind="success">{msg}</Alert></div>}
      {err && <div className="mb-3"><Alert kind="error">{err}</Alert></div>}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label={`Spend (${days}d)`} value={pkr(t.spend)} />
            <Stat label="Chats" value={num(t.conversations)} sub={`${pkr(t.cost_per_chat)} each`} />
            <Stat label="CTR" value={pct(t.ctr, 2)} sub={`${num(t.impressions)} impressions`} />
            <Stat label="Frequency" value={t.avg_frequency ?? "—"} sub={t.avg_frequency && t.avg_frequency >= 3 ? "High — consider a new creative" : undefined} />
            <Stat label="Orders" value={num(t.orders)} sub={t.refused ? `${t.refused} refused` : undefined} />
            <Stat label="Cost per order" value={pkr(t.cost_per_order)} />
            <Stat label="Revenue" value={pkr(t.revenue)} sub={t.roas !== null ? `ROAS ${t.roas}x` : undefined} />
            <Stat label="WhatsApp chats (webhook)" value={num(t.whatsapp_chats)} />
          </div>
          {data.video && (
            <Card title="Video watch">
              <div className="space-y-2">
                {(["p25", "p50", "p75", "p100"] as const).map((k) => {
                  const base = data.video.p25 || 1;
                  const w = Math.round((data.video[k] / base) * 100);
                  return (
                    <div key={k} className="grid grid-cols-[3rem_1fr_5rem] items-center gap-2 text-sm">
                      <span className="text-text-3">{k.slice(1)}%</span>
                      <div className="h-2 rounded bg-surface-2"><div className="h-2 rounded" style={{ width: `${w}%`, background: "var(--series-1)" }} /></div>
                      <span className="text-right tabular-nums">{num(data.video[k])}</span>
                    </div>
                  );
                })}
                <p className="text-xs text-text-3">Completion (100% of those who reached 25%): {pct(data.video.completion_pct)}</p>
              </div>
            </Card>
          )}
          <div className="flex justify-end">
            <Select value={days} onChange={(e) => setDays(Number(e.target.value))} className="w-auto" aria-label="Range">
              <option value={7}>Last 7 days</option>
              <option value={30}>Last 30 days</option>
              <option value={90}>Last 90 days</option>
            </Select>
          </div>
          <TrendChart title="Spend per day (PKR)" kind="bar" data={data.daily} series={[{ key: "spend", label: "Spend", slot: 1 }]} fmt={(v) => pkr(v)} />
          <TrendChart title="Chats per day" data={data.daily} series={[{ key: "conversations", label: "Chats", slot: 1 }]} />
          <TrendChart title="CTR per day (%)" data={data.daily} series={[{ key: "ctr", label: "CTR", slot: 1 }]} fmt={(v) => pct(v, 2)} />
          <TrendChart title="Frequency per day" data={data.daily} series={[{ key: "frequency", label: "Frequency", slot: 1 }]} fmt={(v) => (v === null ? "—" : v.toFixed(2))} />
          <Card title="Orders linked to this ad">
            {data.orders.length === 0 ? (
              <p className="text-sm text-text-3">No orders logged for this ad. <Link className="underline" href="/orders">Log orders</Link></p>
            ) : (
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-text-3"><tr><th className="py-1">Date</th><th className="text-right">Chats</th><th className="text-right">Orders</th><th className="text-right">Refused</th><th className="text-right">Revenue</th></tr></thead>
                <tbody>
                  {data.orders.map((o: any) => (
                    <tr key={o.id} className="border-t border-border"><td className="py-1.5">{shortDate(o.date)}</td><td className="text-right">{o.chats}</td><td className="text-right">{o.orders}</td><td className="text-right">{o.refused}</td><td className="text-right">{pkr(o.revenue)}</td></tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </div>
        <div className="space-y-4">
          <Card title="Creative">
            <div className="space-y-3">
              <Preview html={data.preview_html} />
              {data.creative && (
                <dl className="space-y-1 text-sm">
                  <div><dt className="inline text-text-3">Type: </dt><dd className="inline">{data.creative.type}</dd></div>
                  {data.creative.headline && <div><dt className="inline text-text-3">Headline: </dt><dd className="inline">{data.creative.headline}</dd></div>}
                  {data.creative.primaryText && <div><dt className="text-text-3">Primary text</dt><dd className="whitespace-pre-wrap">{data.creative.primaryText}</dd></div>}
                </dl>
              )}
            </div>
          </Card>
        </div>
      </div>

      {status && <StatusDialog target={target} next={status} onClose={() => setStatus(null)} onDone={async (m) => { setStatus(null); setMsg(m); await mutate(); }} />}
      {swap && <SwapDialog ad={data} onClose={() => setSwap(false)} onDone={async (m) => { setSwap(false); setMsg(m); await mutate(); }} />}
    </>
  );
}

function SwapDialog({ ad, onClose, onDone }: { ad: any; onClose: () => void; onDone: (m: string) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState("");
  const [headline, setHeadline] = useState(ad.creative?.headline ?? "");
  const [text, setText] = useState(ad.creative?.primaryText ?? "");
  const [pauseOld, setPauseOld] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function go() {
    setBusy(true);
    setErr(null);
    try {
      const isVideo = file ? file.type.startsWith("video/") : /\.(mp4|mov|m4v)(\?|$)/i.test(url);
      let media: Record<string, string> = {};
      if (file) {
        const up = await api("/assets/upload", { body: { type: isVideo ? "video" : "image", base64: await fileToBase64(file), name: file.name } });
        media = isVideo ? { video_id: up.video_id } : { image_hash: up.image_hash };
      } else if (url) {
        media = isVideo ? { video_url: url } : { image_url: url };
      } else throw new Error("Choose a file or paste a URL.");
      const name = `${ad.name} v2`;
      const r = await tool("add_ad_to_adset", {
        adset_id: ad.adset.id,
        name,
        creative: { name, format: isVideo ? "video" : "image", ...media, headline: headline || undefined, primary_text: text || undefined },
      });
      if (pauseOld && ad.status === "ACTIVE") await tool("set_status", { object_id: ad.id, status: "PAUSED" });
      onDone(`New ad ${r.ad_id} created (PAUSED). Activate it on the Campaigns page when ready.${pauseOld && ad.status === "ACTIVE" ? " The old ad was paused." : ""}`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="Swap creative" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={go} loading={busy}>Create new ad</Button></>}>
      <p className="text-sm text-text-2">Creates a new paused ad in the same ad set with the new image or video.</p>
      <Field label="Image or video file"><input type="file" accept="image/*,video/*" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="text-sm" /></Field>
      <Field label="…or public URL"><Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" /></Field>
      <Field label="Headline"><Input value={headline} onChange={(e) => setHeadline(e.target.value)} /></Field>
      <Field label="Primary text"><Textarea value={text} onChange={(e) => setText(e.target.value)} /></Field>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={pauseOld} onChange={(e) => setPauseOld(e.target.checked)} /> Pause the current ad</label>
      {err && <Alert kind="error">{err}</Alert>}
    </Modal>
  );
}
