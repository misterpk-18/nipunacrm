/**
 * Management charts (recharts). Follows the dataviz method: thin bars (≤ 24px) with 4px rounded data-ends,
 * hairline recessive grid, text in text tokens (never the series colour), legend for ≥ 2 series, a
 * per-bar tooltip, and the numbers always reachable without hovering (direct labels / table view).
 * Categorical slots 1–2 of the validated reference palette (blue, orange) — checked on the white card surface.
 */
import type { ReactNode } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  LabelList,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { FunnelStage } from "@/api/dashboard";
import { money } from "@/lib/format";

export const SERIES = { one: "#2a78d6", two: "#eb6834" } as const;
const INK_MUTED = "var(--muted-foreground)";
const INK = "var(--foreground)";
const GRID = "var(--border)";

/** Bar-end label on one line (recharts' default wraps to the bar width, which breaks on short bars). */
function tipLabel(fill: string) {
  return function TipLabel(props: {
    x?: number | string;
    y?: number | string;
    width?: number | string;
    height?: number | string;
    value?: unknown;
  }) {
    const x = Number(props.x ?? 0) + Number(props.width ?? 0) + 6;
    const y = Number(props.y ?? 0) + Number(props.height ?? 0) / 2;
    return (
      <text x={x} y={y} dy={4} fill={fill} fontSize={11}>
        {String(props.value ?? "")}
      </text>
    );
  };
}

function TooltipBox({
  title,
  rows,
}: {
  title: string;
  rows: { label: string; value: string; color: string }[];
}) {
  return (
    <div className="rounded-md border bg-card px-3 py-2 text-xs shadow-sm">
      <div className="mb-1 text-muted-foreground">{title}</div>
      {rows.map((r) => (
        <div key={r.label} className="flex items-center gap-2">
          <span
            className="inline-block h-0.5 w-3 rounded"
            style={{ background: r.color }}
          />
          <strong className="text-sm text-foreground">{r.value}</strong>
          <span className="text-muted-foreground">{r.label}</span>
        </div>
      ))}
    </div>
  );
}

/** Lead funnel: one series, stages top → bottom, count · % direct-labelled at each bar tip. */
export function FunnelChart({ stages }: { stages: FunnelStage[] }) {
  const data = stages.map((s) => ({
    ...s,
    tip: `${s.leads} · ${s.pct_of_total}%`,
  }));
  const height = Math.max(160, data.length * 36 + 16);
  return (
    <figure aria-label="Lead funnel by stage" className="m-0">
      <div style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={data}
            layout="vertical"
            margin={{ top: 4, right: 72, bottom: 4, left: 0 }}
            barCategoryGap={8}
          >
            <CartesianGrid horizontal={false} stroke={GRID} strokeWidth={1} />
            <XAxis
              type="number"
              hide
              domain={[0, "dataMax"]}
              allowDecimals={false}
            />
            <YAxis
              type="category"
              dataKey="stage"
              width={148}
              tickLine={false}
              axisLine={{ stroke: GRID }}
              tick={{ fill: INK_MUTED, fontSize: 11 }}
              tickFormatter={(v: string) =>
                v.length > 22 ? `${v.slice(0, 21)}…` : v
              }
            />
            <Tooltip
              cursor={{ fill: "var(--muted)", opacity: 0.6 }}
              content={({ active, payload }) => {
                const row =
                  active &&
                  (payload?.[0]?.payload as
                    (FunnelStage & { tip: string }) | undefined);
                return row ? (
                  <TooltipBox
                    title={row.stage}
                    rows={[
                      { label: "leads", value: row.tip, color: SERIES.one },
                    ]}
                  />
                ) : null;
              }}
            />
            <Bar
              dataKey="leads"
              fill={SERIES.one}
              maxBarSize={24}
              radius={[0, 4, 4, 0]}
              isAnimationActive={false}
            >
              <LabelList dataKey="tip" content={tipLabel(INK)} />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </figure>
  );
}

type CollectionRow = { name: string; verified: string; pending: string };

/** Verified collections vs pending verification per branch (two series, legend + tooltip + table below). */
export function CollectionsChart({
  rows,
  footer,
}: {
  rows: CollectionRow[];
  footer?: ReactNode;
}) {
  const data = rows.map((r) => ({
    name: r.name,
    verified: Number(r.verified),
    pending: Number(r.pending),
    vText: money(r.verified),
    pText: money(r.pending),
  }));
  const height = Math.max(150, data.length * 64 + 56);
  return (
    <figure
      aria-label="Verified collections and pending verification by branch"
      className="m-0"
    >
      <div style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={data}
            layout="vertical"
            margin={{ top: 4, right: 84, bottom: 4, left: 0 }}
            barGap={2}
            barCategoryGap={14}
          >
            <CartesianGrid horizontal={false} stroke={GRID} strokeWidth={1} />
            <XAxis
              type="number"
              tickLine={false}
              axisLine={false}
              tick={{ fill: INK_MUTED, fontSize: 11 }}
              tickFormatter={(v: number) =>
                v >= 100000
                  ? `₹${(v / 100000).toFixed(1)}L`
                  : v >= 1000
                    ? `₹${Math.round(v / 1000)}k`
                    : `₹${v}`
              }
            />
            <YAxis
              type="category"
              dataKey="name"
              width={88}
              tickLine={false}
              axisLine={{ stroke: GRID }}
              tick={{ fill: INK_MUTED, fontSize: 11 }}
            />
            <Tooltip
              cursor={{ fill: "var(--muted)", opacity: 0.6 }}
              content={({ active, payload }) => {
                const row =
                  active &&
                  (payload?.[0]?.payload as (typeof data)[number] | undefined);
                return row ? (
                  <TooltipBox
                    title={row.name}
                    rows={[
                      {
                        label: "verified",
                        value: row.vText,
                        color: SERIES.one,
                      },
                      {
                        label: "pending (not counted)",
                        value: row.pText,
                        color: SERIES.two,
                      },
                    ]}
                  />
                ) : null;
              }}
            />
            <Legend
              verticalAlign="top"
              align="left"
              height={28}
              iconType="square"
              iconSize={10}
              formatter={(value: string) => (
                <span style={{ color: INK_MUTED, fontSize: 12 }}>{value}</span>
              )}
            />
            <Bar
              name="Verified collections"
              dataKey="verified"
              fill={SERIES.one}
              maxBarSize={20}
              radius={[0, 4, 4, 0]}
              isAnimationActive={false}
            >
              <LabelList dataKey="vText" content={tipLabel(INK)} />
            </Bar>
            <Bar
              name="Pending verification (excluded)"
              dataKey="pending"
              fill={SERIES.two}
              maxBarSize={20}
              radius={[0, 4, 4, 0]}
              isAnimationActive={false}
            >
              <LabelList dataKey="pText" content={tipLabel(INK_MUTED)} />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      {footer && (
        <figcaption className="mt-2 text-xs text-muted-foreground">
          {footer}
        </figcaption>
      )}
    </figure>
  );
}

/** Achievement meter: value vs target, % labelled in text ink; "Not set" when the measure has no target. */
export function Meter({
  label,
  value,
  target,
  pct,
}: {
  label: string;
  value: string;
  target: string | null;
  pct: string | null;
}) {
  const n = pct === null ? null : Math.max(0, Math.min(100, Number(pct)));
  return (
    <div>
      <div className="mb-1.5 flex flex-wrap justify-between gap-x-3 text-xs">
        <span className="font-medium text-foreground">{label}</span>
        <span className="text-muted-foreground">
          {target === null ? "Target not set" : `${value} of ${target}`}
          {pct !== null && (
            <strong className="ml-1.5 text-foreground">
              {Number(pct).toFixed(1)}%
            </strong>
          )}
        </span>
      </div>
      <div
        className="h-2 rounded-full bg-muted"
        role="meter"
        aria-label={label}
        aria-valuenow={n ?? 0}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        {n !== null && (
          <div
            className="h-full rounded-full"
            style={{ width: `${n}%`, background: SERIES.one }}
          />
        )}
      </div>
    </div>
  );
}
