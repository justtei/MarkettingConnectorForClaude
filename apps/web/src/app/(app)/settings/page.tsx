"use client";
import { useEffect, useState } from "react";
import { useIsOwner, useUser } from "@/components/shell";
import { Alert, Button, Card, Field, Input, Loading, Modal, PageHeader, Select } from "@/components/ui";
import { api, tool, useApi } from "@/lib/client";
import { dateTime, pkr } from "@/lib/format";

export default function SettingsPage() {
  const owner = useIsOwner();
  return (
    <>
      <PageHeader title="Settings" />
      <div className="grid gap-4 lg:grid-cols-2">
        <TokenCard />
        <SyncCard />
        <CapsCard owner={owner} />
        <ReportsCard />
        {owner && <UsersCard />}
      </div>
    </>
  );
}

function TokenCard() {
  const token = useApi<any>("/settings/token");
  const settings = useApi<any>("/settings");
  const t = token.data;
  return (
    <Card title="Meta connection">
      {token.isLoading && <Loading />}
      {token.error && <Alert kind="error">{token.error.message}</Alert>}
      {t && (
        <div className="space-y-2 text-sm">
          <Alert kind={t.healthy ? "success" : "error"}>{t.healthy ? "Token is valid and has every permission." : t.warnings.join(" ")}</Alert>
          <dl className="grid grid-cols-[9rem_1fr] gap-y-1">
            <dt className="text-text-3">Expires</dt><dd>{t.expires_at === "never" ? "Never (system user)" : `${dateTime(t.expires_at)} (${t.days_left} days)`}</dd>
            <dt className="text-text-3">Token type</dt><dd>{t.type ?? "—"}</dd>
            <dt className="text-text-3">API version</dt><dd>{t.api_version} <span className="text-text-3">(review quarterly)</span></dd>
            <dt className="text-text-3">Ad account</dt><dd>{settings.data?.ad_account_id}</dd>
            <dt className="text-text-3">Page</dt><dd>{settings.data?.page_id ?? "not set"}</dd>
            <dt className="text-text-3">WhatsApp</dt><dd>{settings.data?.whatsapp_number ? `+${settings.data.whatsapp_number}` : "not set"}</dd>
            <dt className="text-text-3">Rate-limit usage</dt><dd>{settings.data?.rate_limit_usage ? `${settings.data.rate_limit_usage.max_pct}%` : "—"}</dd>
            <dt className="text-text-3">Permissions</dt><dd className="text-xs text-text-2">{t.scopes.join(", ") || "—"}</dd>
          </dl>
        </div>
      )}
    </Card>
  );
}

function SyncCard() {
  const owner = useIsOwner();
  const { data, mutate } = useApi<any>("/settings");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const s = data?.last_sync;
  async function sync() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api("/sync", { body: { days: 30 } });
      setMsg({ kind: "success", text: `Synced ${r.structure.campaigns} campaigns, ${r.structure.ads} ads, ${r.insights.upserted} daily rows in ${Math.round(r.ms / 1000)}s.` });
      await mutate();
    } catch (e) {
      setMsg({ kind: "error", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card title="Data sync" actions={owner && <Button size="sm" onClick={sync} loading={busy}>Sync last 30 days</Button>}>
      <p className="text-sm">
        The worker pulls campaigns and daily stats from Meta every 3 hours so the dashboard never waits on Meta.
      </p>
      <p className="mt-2 text-sm">
        Last sync: {s ? <>{dateTime(s.at)} — {s.ok ? <span className="text-good-text">✓ ok</span> : <span className="text-critical-text">✕ {s.error}</span>}</> : "never"}
      </p>
      {msg && <div className="mt-2"><Alert kind={msg.kind}>{msg.text}</Alert></div>}
    </Card>
  );
}

function CapsCard({ owner }: { owner: boolean }) {
  const { data, mutate } = useApi<any>("/settings");
  const [f, setF] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    if (data?.settings) setF(data.settings);
  }, [data]);
  if (!f) return <Card title="Safety caps & defaults"><Loading /></Card>;
  const raising = data && f.maxDailyBudgetPkr > data.settings.maxDailyBudgetPkr;

  async function save() {
    setBusy(true);
    setMsg(null);
    setConfirm(false);
    try {
      await api("/settings", {
        method: "PUT",
        body: {
          maxDailyBudgetPkr: Number(f.maxDailyBudgetPkr),
          maxBudgetIncreasePct: Number(f.maxBudgetIncreasePct),
          defaultCityName: f.defaultCityName || null,
          defaultCityKey: null,
          defaultAgeMin: Number(f.defaultAgeMin),
          defaultAgeMax: Number(f.defaultAgeMax),
          defaultGender: f.defaultGender,
          alertEmail: f.alertEmail || null,
        },
      });
      setMsg({ kind: "success", text: "Saved." });
      await mutate();
    } catch (e) {
      setMsg({ kind: "error", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }
  const set = (k: string) => (e: { target: { value: string } }) => setF((x: any) => ({ ...x, [k]: e.target.value }));
  return (
    <Card title="Safety caps & defaults">
      <fieldset disabled={!owner} className="grid grid-cols-2 gap-3">
        <Field label="Max daily budget (PKR)" hint="Per ad set / campaign"><Input type="number" min={1} value={f.maxDailyBudgetPkr} onChange={set("maxDailyBudgetPkr")} /></Field>
        <Field label="Max increase per change (%)"><Input type="number" min={1} value={f.maxBudgetIncreasePct} onChange={set("maxBudgetIncreasePct")} /></Field>
        <Field label="Default city"><Input value={f.defaultCityName ?? ""} onChange={set("defaultCityName")} /></Field>
        <Field label="Default gender"><Select value={f.defaultGender} onChange={set("defaultGender")}><option value="female">Women</option><option value="male">Men</option><option value="all">Everyone</option></Select></Field>
        <Field label="Default min age"><Input type="number" min={18} max={65} value={f.defaultAgeMin} onChange={set("defaultAgeMin")} /></Field>
        <Field label="Default max age"><Input type="number" min={18} max={65} value={f.defaultAgeMax} onChange={set("defaultAgeMax")} /></Field>
        <div className="col-span-2"><Field label="Alert & report email"><Input type="email" value={f.alertEmail ?? ""} onChange={set("alertEmail")} placeholder="you@sandalez.pk" /></Field></div>
      </fieldset>
      {owner && <div className="mt-3 flex justify-end"><Button variant="primary" onClick={() => (raising ? setConfirm(true) : save())} loading={busy}>Save</Button></div>}
      {!owner && <p className="mt-2 text-xs text-text-3">Only the owner can change these.</p>}
      {msg && <div className="mt-3"><Alert kind={msg.kind}>{msg.text}</Alert></div>}
      {confirm && (
        <Modal open onClose={() => setConfirm(false)} title="Raise the budget cap?" footer={<><Button onClick={() => setConfirm(false)}>Cancel</Button><Button variant="primary" onClick={save}>Yes, raise it</Button></>}>
          <p className="text-sm">The daily cap goes from {pkr(data.settings.maxDailyBudgetPkr)} to {pkr(Number(f.maxDailyBudgetPkr))}. Claude and the dashboard will be able to set budgets up to this amount.</p>
        </Modal>
      )}
    </Card>
  );
}

function ReportsCard() {
  const { data, mutate, isLoading } = useApi<any[]>("/reports");
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  async function generate() {
    setBusy(true);
    setErr(null);
    try {
      await tool("weekly_report", { send_email: false });
      await mutate();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card title="Weekly reports" actions={<Button size="sm" onClick={generate} loading={busy}>Generate now</Button>}>
      <p className="mb-2 text-sm text-text-2">Sent every Monday 9:00 (Karachi) when email is configured.</p>
      {err && <Alert kind="error">{err}</Alert>}
      {isLoading && <Loading />}
      <ul className="divide-y divide-border text-sm">
        {data?.map((r) => (
          <li key={r.id} className="flex items-center justify-between py-2">
            <span>{r.period_start} → {r.period_end}{r.emailed_to ? <span className="text-xs text-text-3"> · emailed</span> : null}</span>
            <Button size="sm" variant="ghost" onClick={() => setView(r)}>View</Button>
          </li>
        ))}
        {data?.length === 0 && <li className="py-2 text-text-3">No reports yet.</li>}
      </ul>
      {view && (
        <Modal open onClose={() => setView(null)} title={`Week ${view.period_start} → ${view.period_end}`}>
          <dl className="grid grid-cols-2 gap-y-1 text-sm">
            <dt className="text-text-3">Spend</dt><dd>{pkr(view.data.spend)} {fmtChange(view.data.spend_change_pct)}</dd>
            <dt className="text-text-3">Chats</dt><dd>{view.data.chats} {fmtChange(view.data.chats_change_pct)}</dd>
            <dt className="text-text-3">Cost per chat</dt><dd>{pkr(view.data.cost_per_chat)} {fmtChange(view.data.cost_per_chat_change_pct)}</dd>
            <dt className="text-text-3">Orders</dt><dd>{view.data.orders} ({view.data.refused} refused)</dd>
            <dt className="text-text-3">Cost per order</dt><dd>{pkr(view.data.cost_per_order)}</dd>
            <dt className="text-text-3">Revenue</dt><dd>{pkr(view.data.revenue)}</dd>
            <dt className="text-text-3">ROAS</dt><dd>{view.data.roas ?? "—"}</dd>
          </dl>
          <h3 className="pt-2 text-sm font-semibold">Best ads</h3>
          <ul className="text-sm">{view.data.top_ads.map((a: any) => <li key={a.ad_id}>{a.ad_name}: {a.chats} chats at {pkr(a.cost_per_chat)}</li>)}</ul>
          {view.data.fatigued_ads.length > 0 && (<><h3 className="pt-2 text-sm font-semibold">Fatigued</h3><ul className="text-sm">{view.data.fatigued_ads.map((a: any) => <li key={a.ad_id}>{a.ad_name}: {a.reasons.join(", ")}</li>)}</ul></>)}
        </Modal>
      )}
    </Card>
  );
}

function fmtChange(v: number | null) {
  if (v === null || v === undefined) return null;
  return <span className="text-xs text-text-3">({v > 0 ? "+" : ""}{v}%)</span>;
}

function UsersCard() {
  const me = useUser();
  const { data, mutate } = useApi<any[]>("/users");
  const [f, setF] = useState({ email: "", password: "", role: "staff" });
  const [msg, setMsg] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  async function add() {
    setMsg(null);
    try {
      await api("/users", { body: f });
      setF({ email: "", password: "", role: "staff" });
      setMsg({ kind: "success", text: "User saved." });
      await mutate();
    } catch (e) {
      setMsg({ kind: "error", text: (e as Error).message });
    }
  }
  async function remove(email: string) {
    if (!window.confirm(`Remove ${email}?`)) return;
    try {
      await api(`/users/${encodeURIComponent(email)}`, { method: "DELETE" });
      await mutate();
    } catch (e) {
      setMsg({ kind: "error", text: (e as Error).message });
    }
  }
  return (
    <Card title="Users">
      <ul className="mb-3 divide-y divide-border text-sm">
        {data?.map((u) => (
          <li key={u.email} className="flex items-center justify-between py-2">
            <span>{u.email} <span className="text-xs text-text-3">· {u.role}</span></span>
            {u.email !== me.email && <Button size="sm" variant="ghost" onClick={() => remove(u.email)}>Remove</Button>}
          </li>
        ))}
      </ul>
      <div className="grid gap-2 sm:grid-cols-[1fr_1fr_7rem_auto] sm:items-end">
        <Field label="Email"><Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        <Field label="Password (8+)"><Input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
        <Field label="Role"><Select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}><option value="staff">Staff</option><option value="owner">Owner</option></Select></Field>
        <Button onClick={add} disabled={!f.email || f.password.length < 8}>Save user</Button>
      </div>
      <p className="mt-2 text-xs text-text-3">Staff can see everything and manage the order log; only owners can change ads, budgets and settings. Saving an existing email resets its password.</p>
      {msg && <div className="mt-2"><Alert kind={msg.kind}>{msg.text}</Alert></div>}
    </Card>
  );
}
