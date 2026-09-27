/** Small helpers shared by the management screens (period filter, queue rows, role-aware links). */
import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { PERIODS } from "@/api/dashboard";
import { useAuth } from "@/auth/auth";
import { allowed, rolesForPath } from "@/auth/access";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/crm/forms";
import { Metric } from "@/components/crm/ui";
import { date, todayIST } from "@/lib/format";

export type PeriodValue = { period: string; from?: string; to?: string };

/** Period presets as a button row, with From / To inputs for Custom. */
export function PeriodBar({
  value,
  onChange,
  idPrefix = "period",
}: {
  value: PeriodValue;
  onChange: (v: PeriodValue) => void;
  idPrefix?: string;
}) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2" role="group" aria-label="Period">
        {PERIODS.map((p) => (
          <Button
            key={p}
            size="sm"
            variant={value.period === p ? "default" : "outline"}
            aria-pressed={value.period === p}
            onClick={() =>
              onChange(
                p === "Custom"
                  ? {
                      period: p,
                      from: value.from ?? `${todayIST().slice(0, 8)}01`,
                      to: value.to ?? todayIST(),
                    }
                  : { period: p },
              )
            }
          >
            {p}
          </Button>
        ))}
      </div>
      {value.period === "Custom" && (
        <div className="grid max-w-md grid-cols-2 gap-3">
          <Field label="From" htmlFor={`${idPrefix}-from`}>
            <Input
              id={`${idPrefix}-from`}
              type="date"
              value={value.from ?? ""}
              onChange={(e) => onChange({ ...value, from: e.target.value })}
            />
          </Field>
          <Field label="To" htmlFor={`${idPrefix}-to`}>
            <Input
              id={`${idPrefix}-to`}
              type="date"
              value={value.to ?? ""}
              onChange={(e) => onChange({ ...value, to: e.target.value })}
            />
          </Field>
        </div>
      )}
    </div>
  );
}

/** Query params for a period (drops from/to unless Custom). */
export function periodQuery(v: PeriodValue) {
  return v.period === "Custom"
    ? { period: v.period, from: v.from, to: v.to }
    : { period: v.period };
}

export function periodLabel(period: string, from: string, to: string) {
  return `${period} · ${date(from)} – ${date(to)} · IST`;
}

/** True when the current user's roles may open this path (mirrors the route guard). */
export function useCanOpen() {
  const { roles } = useAuth();
  return (path: string) => {
    const needed = rolesForPath(path);
    return needed === null || allowed({ roles: needed }, roles);
  };
}

/** Metric tile that links only when the user may open the target screen. */
export function LinkedMetric({
  label,
  value,
  hint,
  to,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  to?: string;
}) {
  const canOpen = useCanOpen();
  return (
    <Metric
      label={label}
      value={value}
      hint={hint}
      to={to && canOpen(to) ? to : undefined}
    />
  );
}

/** A work-queue row: label, count, and a link to the screen that clears it. */
export function QueueRow({
  label,
  count,
  hint,
  to,
  search,
}: {
  label: string;
  count: ReactNode;
  hint?: ReactNode;
  to?: string;
  search?: Record<string, unknown>;
}) {
  const canOpen = useCanOpen();
  const body = (
    <>
      <span className="min-w-0">
        <span className="block font-medium text-foreground">{label}</span>
        {hint && (
          <span className="block text-xs text-muted-foreground">{hint}</span>
        )}
      </span>
      <span className="flex shrink-0 items-center gap-1">
        <strong className="text-lg text-foreground">{count}</strong>
        {to && canOpen(to) && (
          <ChevronRight className="size-4 text-muted-foreground" />
        )}
      </span>
    </>
  );
  const cls =
    "flex items-center justify-between gap-3 border-b py-2.5 text-sm last:border-b-0";
  return to && canOpen(to) ? (
    <Link
      to={to}
      search={search as never}
      className={`${cls} hover:bg-muted/50`}
    >
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}
