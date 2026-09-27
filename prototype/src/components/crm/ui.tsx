import { useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import {
  AlertTriangle,
  ArrowRight,
  Bot,
  ChevronRight,
  Download,
  MessageCircle,
  Phone,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { useCrmScope } from "./crm-scope";

export function PageHead({
  title,
  description,
  actions,
}: {
  title: string;
  description: string;
  actions?: ReactNode;
}) {
  const { branch } = useCrmScope();
  return (
    <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <div className="mb-1 text-xs font-semibold uppercase text-primary">
          Sample data · {branch}
        </div>
        <h1 className="text-2xl font-semibold text-foreground">{title}</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{description}</p>
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}
export function Status({ children }: { children: ReactNode }) {
  const t = String(children);
  const kind = /Overdue|Failed|Lost|Outstanding|Review/.test(t)
    ? "danger"
    : /Hot|Due Today|Pending|Partial|Requested/.test(t)
      ? "warn"
      : /Paid|Won|Synced|Attended|Active/.test(t)
        ? "good"
        : "neutral";
  return <Badge className={cn("status", `status-${kind}`)}>{children}</Badge>;
}
export function Metric({
  label,
  value,
  delta,
  to,
}: {
  label: string;
  value: string;
  delta?: string;
  to?: string;
}) {
  const body = (
    <div className="metric-card group">
      <div className="flex items-start justify-between">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        {to && (
          <ChevronRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
        )}
      </div>
      <strong className="mt-3 block text-2xl font-semibold text-foreground">{value}</strong>
      {delta && <span className="mt-1 block text-xs text-success">{delta}</span>}
      <span className="mt-3 block text-[10px] font-semibold uppercase text-muted-foreground">
        Sample data
      </span>
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
export function AiNote({
  title = "AI Suggestion",
  children,
  actions = true,
}: {
  title?: string;
  children: ReactNode;
  actions?: boolean;
}) {
  return (
    <div className="ai-note">
      <div className="flex items-center gap-2 text-sm font-semibold text-ai">
        <Sparkles className="size-4" />
        {title}
        <span className="ml-auto text-[10px] uppercase text-muted-foreground">Advisory only</span>
      </div>
      <div className="mt-2 text-sm leading-6 text-foreground">{children}</div>
      {actions && (
        <div className="mt-3 flex gap-2">
          <Button size="sm" onClick={() => demoAction("Accept AI Suggestion")}>Accept</Button>
          <Button size="sm" variant="outline" onClick={() => demoAction("Dismiss AI Suggestion")}>
            Dismiss
          </Button>
          <Button size="sm" variant="ghost" onClick={() => demoAction("Create Task")}>
            Create Task
          </Button>
        </div>
      )}
    </div>
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
  subtitle?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("panel", className)}>
      <div className="mb-4 flex items-center justify-between gap-4">
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
            <div className="h-full rounded-full bg-primary" style={{ width: `${x.value}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}
export function demoAction(label: string) {
  toast.info(`${label} — Demo only · Not Connected`);
}
export function LeadActions({ prominent = false }: { prominent?: boolean }) {
  return (
    <div className="flex gap-2">
      <Button
        size={prominent ? "sm" : "icon"}
        variant={prominent ? "default" : "ghost"}
        title="Call"
        onClick={() => demoAction("Call")}
      >
        <Phone />
        {prominent && "Call"}
      </Button>
      <Button
        size={prominent ? "sm" : "icon"}
        variant="outline"
        title="WhatsApp"
        onClick={() => demoAction("WhatsApp")}
      >
        <MessageCircle />
        {prominent && "WhatsApp"}
      </Button>
    </div>
  );
}
export function ConfirmAction({
  trigger,
  title,
  description,
  action = "Confirm",
  destructive = false,
}: {
  trigger: ReactNode;
  title: string;
  description: string;
  action?: string;
  destructive?: boolean;
}) {
  const [reason, setReason] = useState("");
  return (
    <Dialog>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <label className="text-sm font-medium">Reason required</label>
        <Textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Enter reason for the audit trail..."
        />
        <DialogFooter>
          <Button variant="outline">Cancel</Button>
          <Button variant={destructive ? "destructive" : "default"} disabled={!reason.trim()}>
            {action}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
export function PrototypeTable({ headers, rows }: { headers: string[]; rows: ReactNode[][] }) {
  return (
    <div className="table-wrap">
      <table className="w-full text-left text-sm">
        <thead>
          <tr>
            {headers.map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (
                <td key={j}>{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
export function ExportButton() {
  return (
    <Button variant="outline" size="sm" onClick={() => demoAction("Export Sample")}>
      <Download />
      Export Sample
    </Button>
  );
}
type FlowLinkProps =
  | { to: "/students/$personId"; params: { personId: string }; label: string }
  | { to: "/admissions/new" | "/payments" | "/collections"; label: string };
export function FlowLink(props: FlowLinkProps) {
  return (
    <Button asChild>
      {props.to === "/students/$personId" ? (
        <Link to={props.to} params={props.params}>
          {props.label}
          <ArrowRight />
        </Link>
      ) : (
        <Link to={props.to}>
          {props.label}
          <ArrowRight />
        </Link>
      )}
    </Button>
  );
}
export function FactLabel({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase text-muted-foreground">
      <Bot className="size-3" />
      {children}
    </span>
  );
}
export function Warning({ children }: { children: ReactNode }) {
  return (
    <div className="flex gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
      {children}
    </div>
  );
}
