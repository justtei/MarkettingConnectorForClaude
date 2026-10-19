"use client";
import { useState } from "react";
import { ApiError, tool, useApi } from "@/lib/client";
import { pkr } from "@/lib/format";
import { Alert, Button, Field, Input, Modal } from "./ui";

export interface Target {
  id: string;
  name: string;
  type: "campaign" | "adset" | "ad";
  status: string;
  daily_budget?: number | null;
}

const POLICY =
  "Before going live: no misleading claims or fake discounts, prices must match what customers get on WhatsApp, keep image text short, and make sure someone answers the chats. The ad goes to review first.";

function errorText(e: unknown) {
  if (e instanceof ApiError && e.rule === "budget_cap") return `${e.message}`;
  return (e as Error).message;
}

/** Activate / pause / archive with an explicit confirmation step for anything that can spend. */
export function StatusDialog({ target, next, onClose, onDone }: { target: Target | null; next: "ACTIVE" | "PAUSED" | "ARCHIVED"; onClose: () => void; onDone: (msg: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [includeChildren, setIncludeChildren] = useState(true);
  if (!target) return null;
  const verb = next === "ACTIVE" ? "Activate" : next === "PAUSED" ? "Pause" : "Archive";

  async function go() {
    setBusy(true);
    setErr(null);
    try {
      const r = await tool("set_status", { object_id: target!.id, status: next, confirm: next !== "PAUSED", include_children: includeChildren });
      const warn = r.warnings?.length ? ` Note: ${r.warnings.join(" ")}` : "";
      onDone(`${verb}d ${r.changed.length} object(s).${warn}`);
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`${verb} ${target.type === "adset" ? "ad set" : target.type}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant={next === "ARCHIVED" ? "danger" : "primary"} onClick={go} loading={busy}>
            Yes, {verb.toLowerCase()}
          </Button>
        </>
      }
    >
      <p className="text-sm">
        <strong>{target.name}</strong> ({target.id})
      </p>
      {next === "ACTIVE" && (
        <>
          {target.daily_budget ? <p className="text-sm">Daily budget: <strong>{pkr(target.daily_budget)}</strong> — this will start spending.</p> : <p className="text-sm">This will start spending.</p>}
          {target.type !== "ad" && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={includeChildren} onChange={(e) => setIncludeChildren(e.target.checked)} />
              Also activate its paused {target.type === "campaign" ? "ad sets and ads" : "ads"}
            </label>
          )}
          <Alert kind="warning">{POLICY}</Alert>
        </>
      )}
      {next === "ARCHIVED" && <Alert kind="warning">Archived objects cannot be activated again.</Alert>}
      {err && <Alert kind="error">{err}</Alert>}
    </Modal>
  );
}

export function BudgetDialog({ target, onClose, onDone }: { target: Target | null; onClose: () => void; onDone: (msg: string) => void }) {
  const { data: settings } = useApi<any>("/settings");
  const [value, setValue] = useState(String(target?.daily_budget ?? ""));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!target) return null;
  const current = target.daily_budget ?? 0;
  const next = Number(value);
  const cap = settings?.settings?.maxDailyBudgetPkr as number | undefined;
  const maxPct = settings?.settings?.maxBudgetIncreasePct as number | undefined;
  const change = current && next ? ((next - current) / current) * 100 : null;
  const overCap = cap !== undefined && next > cap;
  const overPct = maxPct !== undefined && change !== null && change > maxPct;

  async function go() {
    setBusy(true);
    setErr(null);
    try {
      const r = await tool("update_budget", { object_id: target!.id, daily_budget: next, confirm: true });
      onDone(`Budget changed from ${pkr(r.previous_daily_budget)} to ${pkr(r.daily_budget)}.`);
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Change daily budget"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={go} loading={busy} disabled={!next || next <= 0 || next === current || overCap || overPct}>
            Confirm {next ? pkr(next) : ""}/day
          </Button>
        </>
      }
    >
      <p className="text-sm"><strong>{target.name}</strong></p>
      <p className="text-sm text-text-2">Current: {pkr(current)}/day</p>
      <Field
        label="New daily budget (PKR)"
        hint={cap !== undefined ? `Cap ${pkr(cap)}/day · max +${maxPct}% per change${current ? ` (up to ${pkr(Math.floor(current * (1 + (maxPct ?? 0) / 100)))} now)` : ""}` : undefined}
        error={overCap ? "Above the daily cap." : overPct ? `More than +${maxPct}% in one step.` : null}
      >
        <Input type="number" inputMode="numeric" min={1} value={value} onChange={(e) => setValue(e.target.value)} autoFocus />
      </Field>
      {change !== null && Number.isFinite(change) && <p className="text-sm text-text-2">Change: {change > 0 ? "+" : ""}{change.toFixed(0)}%</p>}
      {err && <Alert kind="error">{err}</Alert>}
    </Modal>
  );
}

export function DuplicateDialog({ target, onClose, onDone }: { target: Target | null; onClose: () => void; onDone: (msg: string) => void }) {
  const [name, setName] = useState(target ? `${target.name} - Copy` : "");
  const [city, setCity] = useState("");
  const [budget, setBudget] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!target) return null;
  async function go() {
    setBusy(true);
    setErr(null);
    try {
      const r = await tool("duplicate_campaign", {
        campaign_id: target!.id,
        new_name: name || undefined,
        city: city || undefined,
        daily_budget: budget ? Number(budget) : undefined,
      });
      onDone(`Copied as “${r.name}” (PAUSED)${r.city ? ` targeting ${r.city}` : ""}.`);
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal open onClose={onClose} title="Duplicate campaign" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={go} loading={busy}>Duplicate (paused)</Button></>}>
      <Field label="New name"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label="New city (optional)" hint="e.g. Lahore — replaces the location of every ad set"><Input value={city} onChange={(e) => setCity(e.target.value)} placeholder="Lahore" /></Field>
      <Field label="Daily budget per ad set (optional, PKR)"><Input type="number" value={budget} onChange={(e) => setBudget(e.target.value)} /></Field>
      {err && <Alert kind="error">{err}</Alert>}
    </Modal>
  );
}
