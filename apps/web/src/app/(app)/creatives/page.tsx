"use client";
import { useState } from "react";
import { useIsOwner } from "@/components/shell";
import { Alert, Button, Card, Empty, Field, Input, Loading, PageHeader, Segmented } from "@/components/ui";
import { api, fileToBase64, useApi } from "@/lib/client";
import { num, pct, pkr } from "@/lib/format";

export default function CreativesPage() {
  const [tab, setTab] = useState<"performance" | "media">("performance");
  return (
    <>
      <PageHeader title="Creatives" sub="Performance per creative and the media library." actions={<Segmented label="View" value={tab} onChange={setTab} options={[{ value: "performance", label: "Performance" }, { value: "media", label: "Media" }]} />} />
      {tab === "performance" ? <Performance /> : <Media />}
    </>
  );
}

function Performance() {
  const [days, setDays] = useState(30);
  const { data, error, isLoading } = useApi<any>(`/creatives?days=${days}`);
  if (isLoading) return <Loading />;
  if (error) return <Alert kind="error">{error.message}</Alert>;
  const list = (data?.creatives ?? []).slice().sort((a: any, b: any) => b.stats.spend - a.stats.spend);
  return (
    <div className="space-y-3">
      <Segmented label="Period" value={days} onChange={setDays} options={[{ value: 7, label: "7d" }, { value: 30, label: "30d" }, { value: 90, label: "90d" }]} />
      {list.length === 0 && <Empty>No creatives yet.</Empty>}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {list.map((c: any) => (
          <article key={c.id} className="flex gap-3 rounded-xl border border-border bg-surface p-3">
            {c.thumbnail_url ? <img src={c.thumbnail_url} alt="" className="h-20 w-20 shrink-0 rounded-lg object-cover" /> : <div className="h-20 w-20 shrink-0 rounded-lg bg-surface-2" />}
            <div className="min-w-0 flex-1 text-sm">
              <div className="truncate font-medium">{c.name ?? c.id}</div>
              <div className="text-xs text-text-3">{c.type} · {c.ads.length} ad(s)</div>
              {c.headline && <div className="truncate text-xs text-text-2">{c.headline}</div>}
              <dl className="mt-1 grid grid-cols-2 gap-x-2 text-xs tabular-nums">
                <dt className="text-text-3">Spend</dt><dd className="text-right">{pkr(c.stats.spend)}</dd>
                <dt className="text-text-3">Chats</dt><dd className="text-right">{num(c.stats.conversations)}</dd>
                <dt className="text-text-3">Cost/chat</dt><dd className="text-right">{pkr(c.stats.cost_per_chat)}</dd>
                <dt className="text-text-3">CTR</dt><dd className="text-right">{pct(c.stats.ctr, 2)}</dd>
              </dl>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

function Media() {
  const owner = useIsOwner();
  const [archived, setArchived] = useState(false);
  const { data, error, isLoading, mutate } = useApi<any>(`/assets?type=all&archived=${archived ? 1 : 0}`);
  const [files, setFiles] = useState<FileList | null>(null);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  async function upload() {
    setBusy(true);
    setMsg(null);
    try {
      let n = 0;
      for (const f of Array.from(files ?? [])) {
        await api("/assets/upload", { body: { type: f.type.startsWith("video/") ? "video" : "image", base64: await fileToBase64(f), name: f.name } });
        n++;
      }
      if (url) {
        await api("/assets/upload", { body: { type: /\.(mp4|mov|m4v)(\?|$)/i.test(url) ? "video" : "image", url } });
        n++;
      }
      setMsg({ kind: "success", text: `Uploaded ${n} file(s) to Meta.` });
      setFiles(null);
      setUrl("");
      await mutate();
    } catch (e) {
      setMsg({ kind: "error", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function toggleArchive(ref: string, value: boolean) {
    await api(`/assets/${encodeURIComponent(ref)}/archive`, { body: { archived: value } });
    await mutate();
  }

  return (
    <div className="space-y-4">
      {owner && (
        <Card title="Upload">
          <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <Field label="Images or videos (max 40 MB each)"><input type="file" multiple accept="image/*,video/*" onChange={(e) => setFiles(e.target.files)} className="text-sm" /></Field>
            <Field label="…or a public URL"><Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" /></Field>
            <Button variant="primary" onClick={upload} loading={busy} disabled={!files?.length && !url}>Upload</Button>
          </div>
          {msg && <div className="mt-3"><Alert kind={msg.kind}>{msg.text}</Alert></div>}
        </Card>
      )}
      <label className="flex items-center gap-2 text-sm text-text-2"><input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> Include archived</label>
      {isLoading && <Loading />}
      {error && <Alert kind="error">{error.message}</Alert>}
      {data && (
        <>
          <h2 className="text-sm font-semibold">Images ({data.images?.length ?? 0})</h2>
          {data.images?.length === 0 && <Empty>No images.</Empty>}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
            {data.images?.map((i: any) => (
              <figure key={i.image_hash} className="rounded-lg border border-border bg-surface p-2 text-xs">
                {i.url ? <img src={i.url} alt={i.name ?? ""} className="aspect-square w-full rounded object-cover" /> : <div className="aspect-square rounded bg-surface-2" />}
                <figcaption className="mt-1 truncate" title={i.name}>{i.name ?? i.image_hash}</figcaption>
                {owner && <button className="text-text-3 underline-offset-2 hover:underline" onClick={() => toggleArchive(i.image_hash, !i.archived)}>{i.archived ? "Unarchive" : "Archive"}</button>}
              </figure>
            ))}
          </div>
          <h2 className="text-sm font-semibold">Videos ({data.videos?.length ?? 0})</h2>
          {data.videos?.length === 0 && <Empty>No videos.</Empty>}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
            {data.videos?.map((v: any) => (
              <figure key={v.video_id} className="rounded-lg border border-border bg-surface p-2 text-xs">
                {v.picture ? <img src={v.picture} alt="" className="aspect-square w-full rounded object-cover" /> : <div className="aspect-square rounded bg-surface-2" />}
                <figcaption className="mt-1 truncate" title={v.title}>{v.title ?? v.video_id}</figcaption>
                <div className="text-text-3">{v.status ?? ""}{v.length_seconds ? ` · ${Math.round(v.length_seconds)}s` : ""}</div>
                {owner && <button className="text-text-3 underline-offset-2 hover:underline" onClick={() => toggleArchive(v.video_id, !v.archived)}>{v.archived ? "Unarchive" : "Archive"}</button>}
              </figure>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
