/** CRM building blocks shared by every screen (visual language from the prototype's components/crm/ui.tsx). */
import { useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, ChevronLeft, ChevronRight, Inbox, RefreshCw, Sparkles } from "lucide-react";
import type { PageMeta } from "@/api/client";
import { errorMessage } from "@/api/client";
import { useAuth } from "@/auth/auth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

export function PageHead({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  const { branches, branchId } = useAuth();
  const scope = branchId ? branches.find((b) => b.branch_id === branchId)?.branch_name : branches.length > 1 ? "All branches" : branches[0]?.branch_name;
  return (
    <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        {scope && <div className="mb-1 text-xs font-semibold uppercase text-primary">{scope}</div>}
        <h1 className="text-2xl font-semibold text-foreground">{title}</h1>
        {description && <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

const DANGER = /Overdue|Failed|Lost|Outstanding|Rejected|Broken|Cancelled|Breach|Blocked|Escalated|Critical|High|Reversed|Not Verified/i;
const WARN = /Hot|Due Today|Pending|Partial|Part Paid|Requested|Review|Awaiting|Registered|Scheduled|Draft|Warm|Assessment|In Progress|Open|Medium/i;
const GOOD = /Paid|Won|Synced|Attended|Active|Admitted|Verified|Approved|Completed|Kept|Resolved|Matched|Sent|Delivered|Closed|Placed|Ready|Allocated|Configured/i;

export function Status({ children, kind }: { children: ReactNode; kind?: "danger" | "warn" | "good" | "neutral" }) {
  const text = String(children ?? "");
  const tone = kind ?? (DANGER.test(text) ? "danger" : WARN.test(text) ? "warn" : GOOD.test(text) ? "good" : "neutral");
  if (!text) return <span className="text-muted-foreground">—</span>;
  return <Badge className={cn("status", `status-${tone}`)}>{children}</Badge>;
}

export function Metric({ label, value, hint, to, loading }: { label: string; value: ReactNode; hint?: ReactNode; to?: string; loading?: boolean }) {
  const body = (
    <div className="metric-card group">
      <div className="flex items-start justify-between">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        {to && <ChevronRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />}
      </div>
      {loading ? <Skeleton className="mt-3 h-7 w-24" /> : <strong className="mt-3 block text-2xl font-semibold text-foreground">{value}</strong>}
      {hint && <span className="mt-1 block text-xs text-muted-foreground">{hint}</span>}
    </div>
  );
  return to ? (
    <Link to={to} className="block">
      {body}
    </Link>
  ) : (
    body
  );
}

export function Section({
  title,
  subtitle,
  action,
  children,
  className,
}: {
  title: string;
  subtitle?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("panel", className)}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">{title}</h2>
          {subtitle && <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

export function MiniBars({ items }: { items: { name: string; value: number; label?: string }[] }) {
  return (
    <div className="space-y-4">
      {items.map((x) => (
        <div key={x.name}>
          <div className="mb-1.5 flex justify-between text-xs">
            <span className="font-medium">{x.name}</span>
            <span className="text-muted-foreground">{x.label ?? `${x.value}%`}</span>
          </div>
          <div className="h-2 rounded-full bg-muted">
            <div className="h-full rounded-full bg-primary" style={{ width: `${Math.max(0, Math.min(100, x.value))}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

export function AiNote({ title = "AI Suggestion", children, actions }: { title?: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="ai-note">
      <div className="flex items-center gap-2 text-sm font-semibold text-ai">
        <Sparkles className="size-4" />
        {title}
        <span className="ml-auto text-[10px] uppercase text-muted-foreground">Advisory only</span>
      </div>
      <div className="mt-2 text-sm leading-6 text-foreground">{children}</div>
      {actions && <div className="mt-3 flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function Warning({ children }: { children: ReactNode }) {
  return (
    <div className="flex gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
      <div>{children}</div>
    </div>
  );
}

/** Label / value pairs for detail panels. */
export function Facts({ items, columns = 2 }: { items: [string, ReactNode][]; columns?: 1 | 2 | 3 }) {
  return (
    <dl className={cn("grid gap-x-6 gap-y-3 text-sm", columns === 1 ? "grid-cols-1" : columns === 2 ? "sm:grid-cols-2" : "sm:grid-cols-3")}>
      {items.map(([label, value]) => (
        <div key={label} className="min-w-0">
          <dt className="text-[11px] font-semibold uppercase text-muted-foreground">{label}</dt>
          <dd className="mt-0.5 break-words">{value ?? "—"}</dd>
        </div>
      ))}
    </dl>
  );
}

// ---------------------------------------------------------------- data states

export function LoadingRows({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-2" aria-busy="true">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-9 w-full" />
      ))}
    </div>
  );
}

export function ErrorPanel({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-start gap-3 rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm">
      <div className="flex items-center gap-2 font-medium text-destructive">
        <AlertTriangle className="size-4" />
        {errorMessage(error)}
      </div>
      {onRetry && (
        <Button size="sm" variant="outline" onClick={onRetry}>
          <RefreshCw />
          Try again
        </Button>
      )}
    </div>
  );
}

export function Empty({ title = "Nothing here yet", children }: { title?: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
      <Inbox className="size-6" />
      <div className="font-medium text-foreground">{title}</div>
      {children}
    </div>
  );
}

/** Renders loading / error / empty around a query result. */
export function QueryView<T>({
  query,
  children,
  empty,
  isEmpty,
  rows,
}: {
  query: { data: T | undefined; isLoading: boolean; error: unknown; refetch: () => unknown };
  children: (data: T) => ReactNode;
  empty?: ReactNode;
  isEmpty?: (data: T) => boolean;
  rows?: number;
}) {
  if (query.isLoading) return <LoadingRows rows={rows} />;
  if (query.error) return <ErrorPanel error={query.error} onRetry={() => void query.refetch()} />;
  if (query.data === undefined) return null;
  const blank = isEmpty ? isEmpty(query.data) : Array.isArray(query.data) && query.data.length === 0;
  if (blank) return <>{empty ?? <Empty />}</>;
  return <>{children(query.data)}</>;
}

// ---------------------------------------------------------------- tables

export type Column<T> = {
  header: string;
  cell: (row: T) => ReactNode;
  className?: string;
};

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  loading,
  error,
  onRetry,
  empty,
}: {
  columns: Column<T>[];
  rows: T[] | undefined;
  rowKey: (row: T) => string | number;
  onRowClick?: (row: T) => void;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  empty?: ReactNode;
}) {
  if (loading) return <LoadingRows />;
  if (error) return <ErrorPanel error={error} onRetry={onRetry} />;
  if (!rows?.length) return <>{empty ?? <Empty />}</>;
  return (
    <div className="table-wrap">
      <table className="w-full text-left text-sm">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.header} className={c.className}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={rowKey(row)}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              className={onRowClick ? "cursor-pointer" : undefined}
            >
              {columns.map((c) => (
                <td key={c.header} className={c.className}>
                  {c.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Pagination({ meta, onPage }: { meta: PageMeta | undefined; onPage: (page: number) => void }) {
  if (!meta || meta.pages <= 1) return meta ? <div className="mt-3 text-xs text-muted-foreground">{meta.total} records</div> : null;
  return (
    <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
      <span>
        Page {meta.page} of {meta.pages} · {meta.total} records
      </span>
      <div className="flex gap-1">
        <Button size="sm" variant="outline" disabled={meta.page <= 1} onClick={() => onPage(meta.page - 1)} aria-label="Previous page">
          <ChevronLeft />
        </Button>
        <Button size="sm" variant="outline" disabled={meta.page >= meta.pages} onClick={() => onPage(meta.page + 1)} aria-label="Next page">
          <ChevronRight />
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- confirmations

/**
 * A button that opens a confirmation dialog, optionally asking for a reason (sent to the audit trail).
 * `onConfirm` may return a promise; the dialog stays open (and shows nothing extra) until it settles.
 */
export function ConfirmAction({
  trigger,
  title,
  description,
  action = "Confirm",
  destructive = false,
  reason = false,
  reasonLabel = "Reason",
  onConfirm,
}: {
  trigger: ReactNode;
  title: string;
  description?: ReactNode;
  action?: string;
  destructive?: boolean;
  reason?: boolean;
  reasonLabel?: string;
  onConfirm: (reason: string) => unknown;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const confirm = async () => {
    setBusy(true);
    try {
      await onConfirm(text.trim());
      setOpen(false);
      setText("");
    } catch {
      /* the mutation's own toast reports the error */
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <span onClick={() => setOpen(true)} className="contents">
        {trigger}
      </span>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description && <DialogDescription>{description}</DialogDescription>}
          </DialogHeader>
          {reason && (
            <div className="space-y-1.5">
              <label className="text-sm font-medium" htmlFor="confirm-reason">
                {reasonLabel}
              </label>
              <Textarea id="confirm-reason" value={text} onChange={(e) => setText(e.target.value)} placeholder="Recorded in the audit trail" />
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant={destructive ? "destructive" : "default"} disabled={busy || (reason && !text.trim())} onClick={() => void confirm()}>
              {action}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
