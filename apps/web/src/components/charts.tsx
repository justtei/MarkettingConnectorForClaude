"use client";
import { useState } from "react";
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { shortDate } from "@/lib/format";

export interface Series {
  key: string;
  label: string;
  /** Categorical slot: 1 = blue, 2 = orange (fixed order, never cycled). */
  slot: 1 | 2;
}

const color = (slot: 1 | 2) => `var(--series-${slot})`;

function ChartTooltip({ active, payload, label, series, fmt }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-border bg-surface px-3 py-2 text-xs shadow-md">
      <div className="mb-1 font-semibold text-text">{shortDate(label)}</div>
      {series.map((s: Series) => {
        const p = payload.find((x: any) => x.dataKey === s.key);
        return (
          <div key={s.key} className="flex items-center gap-2 text-text-2">
            <span className="inline-block h-2 w-2 rounded-full" style={{ background: color(s.slot) }} aria-hidden />
            <span>{s.label}</span>
            <span className="ml-auto pl-3 font-semibold tabular-nums text-text">{fmt(p?.value ?? null)}</span>
          </div>
        );
      })}
    </div>
  );
}

function Legend({ series }: { series: Series[] }) {
  if (series.length < 2) return null;
  return (
    <div className="flex flex-wrap gap-3 text-xs text-text-2">
      {series.map((s) => (
        <span key={s.key} className="inline-flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-4 rounded" style={{ background: color(s.slot) }} aria-hidden />
          {s.label}
        </span>
      ))}
    </div>
  );
}

function DataTable({ data, series, fmt }: { data: any[]; series: Series[]; fmt: (v: number | null) => string }) {
  return (
    <div className="max-h-56 overflow-auto">
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-surface text-left text-text-3">
          <tr>
            <th className="py-1 pr-2 font-medium">Date</th>
            {series.map((s) => (
              <th key={s.key} className="py-1 pr-2 text-right font-medium">{s.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((d) => (
            <tr key={d.date} className="border-t border-border">
              <td className="py-1 pr-2 text-text-2">{shortDate(d.date)}</td>
              {series.map((s) => (
                <td key={s.key} className="py-1 pr-2 text-right tabular-nums">{fmt(d[s.key])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * A daily trend chart: bars for one magnitude (e.g. spend), lines for one or two counts.
 * One y-axis only; different measures get their own chart.
 */
export function TrendChart({
  title,
  data,
  series,
  kind = "line",
  fmt = (v) => (v === null ? "—" : v.toLocaleString("en-PK")),
  height = 180,
}: {
  title: string;
  data: any[];
  series: Series[];
  kind?: "line" | "bar";
  fmt?: (v: number | null) => string;
  height?: number;
}) {
  const [asTable, setAsTable] = useState(false);
  const axis = { stroke: "var(--text-3)", fontSize: 11, tickLine: false, axisLine: false } as const;
  const tickDate = (d: string) => shortDate(d);
  return (
    <figure className="rounded-xl border border-border bg-surface p-3">
      <figcaption className="mb-2 flex items-center justify-between gap-2">
        <span className="text-sm font-semibold">{title}</span>
        <div className="flex items-center gap-3">
          <Legend series={series} />
          <button onClick={() => setAsTable((v) => !v)} className="text-xs text-text-3 underline-offset-2 hover:underline">
            {asTable ? "Chart" : "Table"}
          </button>
        </div>
      </figcaption>
      {asTable ? (
        <DataTable data={data} series={series} fmt={fmt} />
      ) : (
        <div style={{ height }} role="img" aria-label={`${title} chart`}>
          <ResponsiveContainer width="100%" height="100%">
            {kind === "bar" ? (
              <BarChart data={data} margin={{ top: 4, right: 4, left: 0, bottom: 0 }} barCategoryGap={2}>
                <CartesianGrid vertical={false} stroke="var(--grid)" />
                <XAxis dataKey="date" tickFormatter={tickDate} minTickGap={24} {...axis} />
                <YAxis width={44} tickFormatter={(v) => compactTick(v)} {...axis} />
                <Tooltip cursor={{ fill: "var(--surface-2)" }} content={<ChartTooltip series={series} fmt={fmt} />} />
                {series.map((s) => (
                  <Bar key={s.key} dataKey={s.key} fill={color(s.slot)} radius={[4, 4, 0, 0]} maxBarSize={18} isAnimationActive={false} />
                ))}
              </BarChart>
            ) : (
              <LineChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke="var(--grid)" />
                <XAxis dataKey="date" tickFormatter={tickDate} minTickGap={24} {...axis} />
                <YAxis width={44} tickFormatter={(v) => compactTick(v)} {...axis} />
                <Tooltip cursor={{ stroke: "var(--text-3)", strokeDasharray: "3 3" }} content={<ChartTooltip series={series} fmt={fmt} />} />
                {series.map((s) => (
                  <Line
                    key={s.key}
                    type="monotone"
                    dataKey={s.key}
                    stroke={color(s.slot)}
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 4, stroke: "var(--surface)", strokeWidth: 2 }}
                    connectNulls
                    isAnimationActive={false}
                  />
                ))}
              </LineChart>
            )}
          </ResponsiveContainer>
        </div>
      )}
    </figure>
  );
}

function compactTick(v: number) {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(v);
}
