"use client";
import { forwardRef, useEffect, useRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(" ");
}

type Variant = "primary" | "secondary" | "danger" | "ghost";
export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md"; loading?: boolean }>(
  function Button({ variant = "secondary", size = "md", loading, className, children, disabled, ...rest }, ref) {
    return (
      <button
        ref={ref}
        disabled={disabled || loading}
        className={cx(
          "inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 whitespace-nowrap",
          size === "sm" ? "h-8 px-3 text-sm" : "h-10 px-4 text-sm",
          variant === "primary" && "bg-accent text-accent-fg hover:opacity-90",
          variant === "secondary" && "border border-border bg-surface text-text hover:bg-surface-2",
          variant === "danger" && "bg-critical text-white hover:opacity-90",
          variant === "ghost" && "text-text-2 hover:bg-surface-2",
          className,
        )}
        {...rest}
      >
        {loading && <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden />}
        {children}
      </button>
    );
  },
);

export function Card({ title, actions, children, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx("rounded-xl border border-border bg-surface", className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold">{title}</h2>
          <div className="flex items-center gap-2">{actions}</div>
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Field({ label, hint, error, children }: { label: string; hint?: ReactNode; error?: string | null; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-sm font-medium text-text-2">{label}</span>
      {children}
      {hint && !error && <span className="block text-xs text-text-3">{hint}</span>}
      {error && <span className="block text-xs text-critical-text">{error}</span>}
    </label>
  );
}

const inputCls = "w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-text-3 focus:border-accent focus:outline-none";
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...p }, ref) {
  return <input ref={ref} className={cx(inputCls, "h-10", className)} {...p} />;
});
export function Textarea({ className, ...p }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cx(inputCls, "min-h-20", className)} {...p} />;
}
export function Select({ className, children, ...p }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cx(inputCls, "h-10", className)} {...p}>
      {children}
    </select>
  );
}

const STATUS_STYLE: Record<string, { cls: string; label: string; icon: string }> = {
  ACTIVE: { cls: "text-good-text", label: "Active", icon: "●" },
  PAUSED: { cls: "text-text-2", label: "Paused", icon: "❚❚" },
  CAMPAIGN_PAUSED: { cls: "text-text-2", label: "Campaign paused", icon: "❚❚" },
  ADSET_PAUSED: { cls: "text-text-2", label: "Ad set paused", icon: "❚❚" },
  ARCHIVED: { cls: "text-text-3", label: "Archived", icon: "▢" },
  PENDING_REVIEW: { cls: "text-text-2", label: "In review", icon: "◷" },
  IN_PROCESS: { cls: "text-text-2", label: "Processing", icon: "◷" },
  DISAPPROVED: { cls: "text-critical-text", label: "Disapproved", icon: "✕" },
  WITH_ISSUES: { cls: "text-critical-text", label: "Issues", icon: "!" },
};

/** Status with icon + label, never color alone. */
export function StatusBadge({ status }: { status: string | null | undefined }) {
  const s = STATUS_STYLE[status ?? ""] ?? { cls: "text-text-2", label: status ?? "—", icon: "•" };
  return (
    <span className={cx("inline-flex items-center gap-1 rounded-full border border-border bg-surface-2 px-2 py-0.5 text-xs font-medium", s.cls)}>
      <span aria-hidden className="text-[10px]">{s.icon}</span>
      {s.label}
    </span>
  );
}

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-surface p-3">
      <div className="text-xs font-medium text-text-3">{label}</div>
      <div className="mt-1 text-xl font-semibold tabular-nums">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-text-3">{sub}</div>}
    </div>
  );
}

export function Alert({ kind = "info", children }: { kind?: "info" | "error" | "success" | "warning"; children: ReactNode }) {
  const icon = { info: "ℹ", error: "✕", success: "✓", warning: "!" }[kind];
  return (
    <div
      role={kind === "error" ? "alert" : "status"}
      className={cx(
        "flex gap-2 rounded-lg border px-3 py-2 text-sm",
        kind === "error" && "border-critical/40 bg-critical/10 text-critical-text",
        kind === "success" && "border-good/40 bg-good/10 text-good-text",
        kind === "warning" && "border-warning/50 bg-warning/10 text-text",
        kind === "info" && "border-border bg-surface-2 text-text-2",
      )}
    >
      <span aria-hidden className="font-bold">{icon}</span>
      <div className="min-w-0 flex-1 break-words">{children}</div>
    </div>
  );
}

export function Modal({ open, onClose, title, children, footer }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-xl border border-border bg-surface p-0 text-text shadow-xl"
    >
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="font-semibold">{title}</h2>
        <button onClick={onClose} className="rounded p-1 text-text-3 hover:bg-surface-2" aria-label="Close">
          ✕
        </button>
      </div>
      <div className="max-h-[70vh] space-y-3 overflow-y-auto p-4">{children}</div>
      {footer && <div className="flex justify-end gap-2 border-t border-border px-4 py-3">{footer}</div>}
    </dialog>
  );
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 py-8 text-sm text-text-3">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden />
      {label}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-text-3">{children}</div>;
}

export function PageHeader({ title, sub, actions }: { title: string; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold">{title}</h1>
        {sub && <p className="mt-0.5 text-sm text-text-3">{sub}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function Segmented<T extends string | number>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-lg border border-border bg-surface p-0.5">
      {options.map((o) => (
        <button
          key={String(o.value)}
          role="radio"
          aria-checked={o.value === value}
          onClick={() => onChange(o.value)}
          className={cx("rounded-md px-3 py-1.5 text-sm", o.value === value ? "bg-surface-2 font-semibold text-text" : "text-text-3 hover:text-text")}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function JsonBlock({ value }: { value: unknown }) {
  return <pre className="max-h-64 overflow-auto rounded-lg bg-surface-2 p-2 text-xs text-text-2">{JSON.stringify(value, null, 2)}</pre>;
}
