"use client";
import { useEffect, useState } from "react";
import { Alert, Button, Card, Empty, Input, JsonBlock, Loading, PageHeader } from "@/components/ui";
import { api } from "@/lib/client";
import { dateTime } from "@/lib/format";

interface Item {
  id: string;
  at: string;
  actor: string;
  action: string;
  object_id: string | null;
  ok: boolean;
  request: any;
  response: any;
  before: any;
}

export default function ActivityPage() {
  const [items, setItems] = useState<Item[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState({ actor: "", action: "", object_id: "" });
  const [applied, setApplied] = useState(filter);
  const [open, setOpen] = useState<string | null>(null);

  async function load(before?: string) {
    setLoading(true);
    setErr(null);
    try {
      const qs = new URLSearchParams({ limit: "50" });
      if (before) qs.set("before", before);
      for (const [k, v] of Object.entries(applied)) if (v) qs.set(k, v);
      const r = await api(`/activity?${qs}`);
      setItems((cur) => (before ? [...cur, ...r.items] : r.items));
      setNext(r.next_before);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, [applied]);

  return (
    <>
      <PageHeader title="Activity log" sub="Every change made from Claude (MCP), the dashboard and the worker — read only." />
      <form className="mb-4 flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); setApplied(filter); }}>
        <Input placeholder="Actor (e.g. claude-mcp)" value={filter.actor} onChange={(e) => setFilter({ ...filter, actor: e.target.value })} className="w-44" />
        <Input placeholder="Action (e.g. set_status)" value={filter.action} onChange={(e) => setFilter({ ...filter, action: e.target.value })} className="w-44" />
        <Input placeholder="Object ID" value={filter.object_id} onChange={(e) => setFilter({ ...filter, object_id: e.target.value })} className="w-44" />
        <Button type="submit">Filter</Button>
      </form>
      {err && <Alert kind="error">{err}</Alert>}
      <Card>
        {!loading && items.length === 0 && <Empty>No activity.</Empty>}
        <ul className="-mx-4 divide-y divide-border">
          {items.map((i) => (
            <li key={i.id} className="px-4 py-2.5 text-sm">
              <button className="flex w-full flex-wrap items-center gap-x-3 gap-y-0.5 text-left" onClick={() => setOpen(open === i.id ? null : i.id)} aria-expanded={open === i.id}>
                <span className={i.ok ? "text-good-text" : "text-critical-text"} aria-label={i.ok ? "succeeded" : "failed"}>{i.ok ? "✓" : "✕"}</span>
                <span className="font-medium">{i.action}</span>
                <span className="text-text-2">{i.actor}</span>
                {i.object_id && <span className="text-xs text-text-3">{i.object_id}</span>}
                <span className="ml-auto text-xs text-text-3">{dateTime(i.at)}</span>
              </button>
              {open === i.id && (
                <div className="mt-2 grid gap-2 lg:grid-cols-3">
                  <div><div className="mb-1 text-xs font-medium text-text-3">Request</div><JsonBlock value={i.request} /></div>
                  <div><div className="mb-1 text-xs font-medium text-text-3">Response</div><JsonBlock value={i.response} /></div>
                  <div><div className="mb-1 text-xs font-medium text-text-3">Before</div>{i.before ? <JsonBlock value={i.before} /> : <p className="text-xs text-text-3">—</p>}</div>
                </div>
              )}
            </li>
          ))}
        </ul>
        {loading && <Loading />}
        {next && !loading && <div className="mt-3 text-center"><Button onClick={() => load(next)}>Load more</Button></div>}
      </Card>
    </>
  );
}
