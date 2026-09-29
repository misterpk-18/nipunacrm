import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Plus, Search, Sparkles } from "lucide-react";
import { get, post } from "@/api/client";
import { leadKeys, leadsApi, type LeadFilters, type LeadRow, type WorkspaceCounts } from "@/api/leads";
import type { DemoRow } from "@/api/demos";
import type { Money } from "@/api/types";
import { useAuth, useBranchFilter } from "@/auth/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AiNote, DataTable, Empty, ErrorPanel, LoadingRows, Metric, PageHead, Pagination, Status } from "@/components/crm/ui";
import { ContactButtons, followUpLabel } from "@/features/leads/leads-list";
import { NewLeadDialog } from "@/features/leads/new-lead-dialog";
import { dateTime, maskPhone, money } from "@/lib/format";
import { useApiMutation } from "@/lib/mutation";

export type QueueKey = keyof WorkspaceCounts;
export type WorkspaceSearch = { queue?: QueueKey; q?: string; page?: number };

export const QUEUES: { key: QueueKey; label: string }[] = [
  { key: "new", label: "New" },
  { key: "untouched", label: "Untouched" },
  { key: "due_today", label: "Due Today" },
  { key: "overdue", label: "Overdue" },
  { key: "hot", label: "Hot" },
  { key: "demos", label: "Demos" },
  { key: "fee_discussion", label: "Fee Discussion" },
  { key: "payment_pending", label: "Payment Pending Verification" },
  { key: "cold", label: "Cold / Reactivation" },
  { key: "future_joining", label: "Future Joining" },
];

type CounsellorDashboard = {
  as_of: string;
  demos_today: DemoRow[];
  tasks: { due_today: number; overdue: number };
  payments_pending_verification: { count: number; amount: Money };
  special_closing_pending: number;
};

type Insight = { insight_id: number; lead_id: number | null; content: string | Record<string, unknown>; priority: string | null; score: number | null; model: string };

/** Counsellor Workspace: today's prioritised queues (own leads for counsellors, the branch for managers). */
export function CounsellorWorkspace({ search, onSearch }: { search: WorkspaceSearch; onSearch: (next: WorkspaceSearch) => void }) {
  const { isCounsellor, hasRole } = useAuth();
  const branchId = useBranchFilter();
  const navigate = useNavigate();
  const [text, setText] = useState(search.q ?? "");
  const [newOpen, setNewOpen] = useState(false);
  const queue: QueueKey = search.queue ?? "new";
  const mine = isCounsellor && !hasRole("BRANCH_MANAGER", "FOUNDER_CEO", "SUPER_ADMIN");

  // Queue counts: a counsellor's own queues from /leads/workspace; managers count their branch scope per queue.
  const workspace = useQuery({
    queryKey: leadKeys.workspace({ per_page: 25 }),
    queryFn: () => leadsApi.workspace({ per_page: 25 }),
  });
  const scopeCounts = useQueries({
    queries: QUEUES.map((q) => ({
      queryKey: leadKeys.list({ queue: q.key, branch_id: branchId, per_page: 1 }),
      queryFn: () => leadsApi.list({ queue: q.key, branch_id: branchId, per_page: 1 }),
      enabled: !mine,
    })),
  });
  const countOf = (key: QueueKey, i: number) => (mine ? workspace.data?.counts[key] : scopeCounts[i]?.data?.meta.total);

  const dashboard = useQuery({ queryKey: ["dashboard", "counsellor"], queryFn: () => get<CounsellorDashboard>("/dashboard/counsellor") });

  // The workspace works every open course (in the pipeline or not), so it searches all leads
  const filters: LeadFilters = { queue, q: search.q, page: search.page, per_page: 25, branch_id: branchId, lead_status: "All", ...(mine ? { assigned_to: "me" } : {}) };
  const leads = useQuery({ queryKey: leadKeys.list(filters), queryFn: () => leadsApi.list(filters), placeholderData: (prev) => prev });
  const rows = leads.data?.data;

  const canAskAi = hasRole("SALES", "FRONT_OFFICE", "BRANCH_MANAGER");
  const nba = useApiMutation(() => post<Insight[]>("/ai/next-best-action", { limit: 5 }), {});
  const d = dashboard.data;

  return (
    <>
      <PageHead
        title="Counsellor Workspace"
        description={mine ? "Today's prioritised queue of your leads." : "Today's prioritised queues across the branch scope."}
        actions={
          <Button onClick={() => setNewOpen(true)}>
            <Plus />
            Add Lead
          </Button>
        }
      />
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric label="Demos today" value={d?.demos_today.length ?? 0} loading={dashboard.isLoading} to="/demos" />
        <Metric label="Tasks due today" value={d?.tasks.due_today ?? 0} hint={d ? `${d.tasks.overdue} overdue` : undefined} loading={dashboard.isLoading} to="/tasks" />
        <Metric
          label="Payments pending verification"
          value={d?.payments_pending_verification.count ?? 0}
          hint={d ? money(d.payments_pending_verification.amount) : undefined}
          loading={dashboard.isLoading}
        />
        <Metric label="Special closing pending" value={d?.special_closing_pending ?? 0} loading={dashboard.isLoading} />
      </div>
      {dashboard.error ? <ErrorPanel error={dashboard.error} onRetry={() => void dashboard.refetch()} /> : null}

      <div className="mb-4 overflow-x-auto" role="tablist" aria-label="Queues">
        <div className="inline-flex min-w-max gap-1 rounded-lg bg-muted p-1">
          {QUEUES.map((q, i) => {
            const count = countOf(q.key, i);
            const active = q.key === queue;
            return (
              <button
                key={q.key}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => onSearch({ ...search, queue: q.key, page: undefined })}
                className={`rounded-md px-3 py-1.5 text-sm font-medium whitespace-nowrap transition-colors ${active ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
              >
                {q.label}
                <span className="ml-1.5 rounded-full bg-primary/10 px-1.5 text-xs text-primary">{count ?? "…"}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="panel">
        <form
          className="relative mb-3"
          onSubmit={(e) => {
            e.preventDefault();
            onSearch({ ...search, q: text.trim() || undefined, page: undefined });
          }}
        >
          <Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" />
          <Input className="pl-9" placeholder="Search name, phone, email or lead code — press Enter" value={text} onChange={(e) => setText(e.target.value)} aria-label="Search queue" />
        </form>

        {canAskAi && (
          <div className="mb-3">
            <AiNote
              title="AI Next Best Action"
              actions={
                <Button size="sm" variant="outline" onClick={() => nba.mutate(undefined)} disabled={nba.isPending}>
                  <Sparkles />
                  {nba.isPending ? "Thinking…" : nba.data ? "Refresh suggestions" : "Suggest next best actions"}
                </Button>
              }
            >
              {!nba.data ? (
                <span className="text-muted-foreground">Suggestions for your most urgent leads, from their recorded activity. Always review before acting.</span>
              ) : nba.data.length === 0 ? (
                <span className="text-muted-foreground">No open leads in your queue to suggest actions for.</span>
              ) : (
                <ul className="space-y-1.5">
                  {nba.data.map((i) => (
                    <li key={i.insight_id}>
                      {i.lead_id ? (
                        <Link to="/leads/$leadId" params={{ leadId: String(i.lead_id) }} className="font-medium text-primary">
                          {nameFor(i.lead_id, [...(workspace.data?.leads ?? []), ...(rows ?? [])]) ?? `Lead #${i.lead_id}`}
                        </Link>
                      ) : null}
                      {i.priority && <span className="ml-2"><Status>{i.priority}</Status></span>} — {typeof i.content === "string" ? i.content : JSON.stringify(i.content)}
                    </li>
                  ))}
                </ul>
              )}
            </AiNote>
          </div>
        )}

        <div className="table-desktop">
          <DataTable
            rows={rows}
            loading={leads.isLoading}
            error={leads.error}
            onRetry={() => void leads.refetch()}
            rowKey={(l) => l.lead_id}
            onRowClick={(l) => void navigate({ to: "/leads/$leadId", params: { leadId: String(l.lead_id) } })}
            empty={<Empty title="Queue is clear">No leads in “{QUEUES.find((q) => q.key === queue)?.label}”.</Empty>}
            columns={[
              {
                header: "Name",
                cell: (l) => (
                  <Link to="/leads/$leadId" params={{ leadId: String(l.lead_id) }} className="font-semibold text-primary" onClick={(e) => e.stopPropagation()}>
                    {l.name}
                    <small className="block font-normal text-muted-foreground">{l.lead_code}</small>
                  </Link>
                ),
              },
              { header: "Phone", cell: (l) => maskPhone(l.phone) },
              { header: "Course", cell: (l) => <span className="block max-w-56 truncate">{l.course?.course_title ?? "—"}</span> },
              { header: "Branch", cell: (l) => l.branch.branch_name },
              { header: "Original source", cell: (l) => l.original_source },
              { header: "Channel", cell: (l) => l.contact_channel },
              { header: "Intake", cell: (l) => <Status>{l.intake_status}</Status> },
              { header: "Assigned", cell: (l) => l.owner?.full_name ?? <Status kind="warn">Unassigned</Status> },
              { header: "Stage", cell: (l) => <Status>{l.stage}</Status> },
              { header: "Next follow-up", cell: followUpLabel },
              { header: "AI priority", cell: (l) => (l.ai_priority ? <Status>{`${l.ai_priority}${l.ai_score !== null ? ` · ${l.ai_score}` : ""}`}</Status> : "—") },
              { header: "Actions", cell: (l) => <ContactButtons phone={l.phone} /> },
            ]}
          />
        </div>
        <div className="mobile-lead-list">
          {leads.isLoading ? (
            <LoadingRows />
          ) : leads.error ? (
            <ErrorPanel error={leads.error} onRetry={() => void leads.refetch()} />
          ) : rows?.length ? (
            rows.map((l) => (
              <div className="mobile-lead-card" key={l.lead_id}>
                <div className="flex items-start justify-between gap-3">
                  <span className="min-w-0">
                    <Link to="/leads/$leadId" params={{ leadId: String(l.lead_id) }} className="font-semibold text-primary">
                      {l.name}
                    </Link>
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {l.course?.course_title ?? "No course"} · {l.stage}
                    </span>
                  </span>
                  {l.ai_priority && <Status>{l.ai_priority}</Status>}
                </div>
                <div className="my-3 space-y-1 text-xs">
                  <div>
                    {maskPhone(l.phone)} · {l.next_follow_up_at ? dateTime(l.next_follow_up_at) : "Unscheduled"}
                  </div>
                  <div className="break-words text-muted-foreground">
                    {l.branch.branch_name} · {l.owner?.full_name ?? "Unassigned"} · {l.original_source} · {l.intake_status}
                  </div>
                </div>
                <ContactButtons phone={l.phone} prominent />
              </div>
            ))
          ) : (
            <Empty title="Queue is clear" />
          )}
        </div>
        <Pagination meta={leads.data?.meta} onPage={(page) => onSearch({ ...search, page })} />
      </div>
      <NewLeadDialog open={newOpen} onOpenChange={setNewOpen} />
    </>
  );
}

function nameFor(leadId: number, rows: LeadRow[]) {
  return rows.find((r) => r.lead_id === leadId)?.name;
}
