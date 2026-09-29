/**
 * My work (V4, Phase 9): the counsellor's prioritised lead queue (same queues and rules as the Counsellor
 * Workspace) plus the signed-in user's open tasks. Roles without leads access see their tasks only.
 */
import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Plus, Search } from "lucide-react";
import { leadKeys, leadsApi, type LeadFilters } from "@/api/leads";
import { taskKeys, tasksApi, type Task, type TaskFilters } from "@/api/tasks";
import { useAuth, useBranchFilter } from "@/auth/auth";
import { DataTable, Empty, ErrorPanel, LoadingRows, PageHead, Pagination, PriorityChip, Section, StatTile, Status } from "@/components/crm/ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { followUpLabel } from "@/features/leads/leads-list";
import { NewLeadDialog } from "@/features/leads/new-lead-dialog";
import { LinkedRecord } from "@/features/operations/linked-record";
import { TaskDialog, conditionLabel } from "@/features/operations/task-dialogs";
import { QUEUES, type QueueKey } from "@/features/sales/counsellor-workspace";
import { dateTime, isPast, relative } from "@/lib/format";
import { CourseSource, LeadContact, LeadIdentity, LeadMobileCard } from "./lead-parts";

export type MyWorkSearch = { queue?: QueueKey; q?: string; page?: number };

export function MyWorkPage({ search, onSearch }: { search: MyWorkSearch; onSearch: (next: MyWorkSearch) => void }) {
  const { hasRole, isCounsellor, branches, branchId } = useAuth();
  const [newOpen, setNewOpen] = useState(false);
  const sales = hasRole("FOUNDER_CEO", "SUPER_ADMIN", "BRANCH_MANAGER", "SALES", "FRONT_OFFICE");
  const mine = isCounsellor && !hasRole("BRANCH_MANAGER", "FOUNDER_CEO", "SUPER_ADMIN");
  const scope = branchId ? branches.find((b) => b.branch_id === branchId)?.branch_name : branches.length > 1 ? "All Branches" : branches[0]?.branch_name;
  return (
    <>
      <PageHead
        eyebrow=""
        title="My work"
        description={`${sales ? (mine ? "Today's prioritised queue of your leads" : "Today's prioritised queue across your branch scope") : "Your open tasks"} · ${scope ?? ""}`}
        actions={
          sales ? (
            <Button onClick={() => setNewOpen(true)}>
              <Plus />
              Add lead
            </Button>
          ) : undefined
        }
      />
      <div className="space-y-5">
        {sales && <LeadQueue search={search} onSearch={onSearch} mine={mine} />}
        <MyTasks />
      </div>
      {sales && <NewLeadDialog open={newOpen} onOpenChange={setNewOpen} />}
    </>
  );
}

function LeadQueue({ search, onSearch, mine }: { search: MyWorkSearch; onSearch: (next: MyWorkSearch) => void; mine: boolean }) {
  const branchId = useBranchFilter();
  const navigate = useNavigate();
  const [text, setText] = useState(search.q ?? "");
  const queue: QueueKey = search.queue ?? "new";

  // Counts: a counsellor's own queues from /leads/workspace; managers count their branch scope per queue.
  const workspace = useQuery({ queryKey: leadKeys.workspace({ per_page: 25 }), queryFn: () => leadsApi.workspace({ per_page: 25 }), enabled: mine });
  const scopeCounts = useQueries({
    queries: QUEUES.map((q) => ({
      queryKey: leadKeys.list({ queue: q.key, branch_id: branchId, per_page: 1 }),
      queryFn: () => leadsApi.list({ queue: q.key, branch_id: branchId, per_page: 1 }),
      enabled: !mine,
    })),
  });
  const countOf = (key: QueueKey, i: number) => (mine ? workspace.data?.counts[key] : scopeCounts[i]?.data?.meta.total);

  const filters: LeadFilters = { queue, q: search.q, page: search.page, per_page: 25, branch_id: branchId, lead_status: "All", ...(mine ? { assigned_to: "me" } : {}) };
  const leads = useQuery({ queryKey: leadKeys.list(filters), queryFn: () => leadsApi.list(filters), placeholderData: (prev) => prev });
  const rows = leads.data?.data;
  const label = QUEUES.find((q) => q.key === queue)?.label;

  return (
    <>
      <Tabs value={queue} onValueChange={(v) => onSearch({ ...search, queue: v as QueueKey, page: undefined })}>
        <TabsList aria-label="Queues" className="w-full">
          {QUEUES.map((q, i) => (
            <TabsTrigger key={q.key} value={q.key}>
              {q.label}
              <span className="queue-count">{countOf(q.key, i) ?? "…"}</span>
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4 lg:gap-4">
        {(["overdue", "due_today", "hot", "payment_pending"] as QueueKey[]).map((key) => (
          <StatTile
            key={key}
            label={QUEUES.find((q) => q.key === key)?.label ?? key}
            value={countOf(key, QUEUES.findIndex((q) => q.key === key)) ?? "…"}
            active={queue === key}
            onClick={() => onSearch({ ...search, queue: key, page: undefined })}
          />
        ))}
      </div>
      <section className="panel" aria-label={`${label} queue`}>
        <form
          className="relative mb-3"
          onSubmit={(e) => {
            e.preventDefault();
            onSearch({ ...search, q: text.trim() || undefined, page: undefined });
          }}
        >
          <Search className="absolute left-3 top-3 size-4 text-muted-foreground" />
          <Input className="pl-9" placeholder="Search name, phone, email or lead code — press Enter" value={text} onChange={(e) => setText(e.target.value)} aria-label="Search queue" />
        </form>
        {leads.data && <p className="mb-3 text-xs text-muted-foreground">{leads.data.meta.total} leads in “{label}”</p>}
        <div className="table-desktop">
          <DataTable
            rows={rows}
            loading={leads.isLoading}
            error={leads.error}
            onRetry={() => void leads.refetch()}
            rowKey={(l) => l.lead_id}
            onRowClick={(l) => void navigate({ to: "/leads/$leadId", params: { leadId: String(l.lead_id) } })}
            empty={<Empty title="Queue is clear">No leads in “{label}”.</Empty>}
            columns={[
              { header: "Lead", cell: (l) => <LeadIdentity lead={l} /> },
              { header: "Course / source", cell: (l) => <CourseSource lead={l} /> },
              { header: "Owner", cell: (l) => l.owner?.full_name ?? <Status kind="warn">Unassigned</Status> },
              { header: "Stage", cell: (l) => <Status kind={l.stage === "New Enquiry" ? undefined : "neutral"}>{l.stage}</Status> },
              { header: "Follow-up", cell: followUpLabel },
              { header: "Priority", cell: (l) => <PriorityChip priority={l.ai_priority} /> },
              { header: "", cell: (l) => <LeadContact phone={l.phone} /> },
            ]}
          />
        </div>
        <div className="mobile-lead-list">
          {leads.isLoading ? (
            <LoadingRows />
          ) : leads.error ? (
            <ErrorPanel error={leads.error} onRetry={() => void leads.refetch()} />
          ) : rows?.length ? (
            rows.map((l) => <LeadMobileCard key={l.lead_id} lead={l} />)
          ) : (
            <Empty title="Queue is clear" />
          )}
        </div>
        <Pagination meta={leads.data?.meta} onPage={(page) => onSearch({ ...search, page })} />
      </section>
    </>
  );
}

function dueLabel(t: Task) {
  return (
    <span className={isPast(t.due_at) ? "font-medium text-destructive" : undefined} title={dateTime(t.due_at)}>
      {dateTime(t.due_at)}
      <small className="block">{relative(t.due_at)}</small>
    </span>
  );
}

function MyTasks() {
  const [page, setPage] = useState(1);
  const [openTask, setOpenTask] = useState<number | null>(null);
  const filters: TaskFilters = { view: "my", open: true, page, per_page: 10 };
  const tasks = useQuery({ queryKey: taskKeys.list(filters), queryFn: () => tasksApi.list(filters), placeholderData: (prev) => prev });
  return (
    <Section
      title="My open tasks"
      subtitle={tasks.data ? `${tasks.data.meta.total} open · oldest due first` : "Tasks you own that are not completed or cancelled"}
      action={
        <Link to="/tasks" className="text-sm font-semibold text-primary">
          All tasks
        </Link>
      }
    >
      <DataTable
        stack
        rows={tasks.data?.data}
        loading={tasks.isLoading}
        error={tasks.error}
        onRetry={() => void tasks.refetch()}
        rowKey={(t) => t.task_id}
        onRowClick={(t) => setOpenTask(t.task_id)}
        empty={<Empty title="No open tasks">Tasks assigned to you appear here.</Empty>}
        columns={[
          {
            header: "Task",
            cell: (t) => (
              <span className="block max-w-[28rem] whitespace-normal">
                <span className="font-semibold text-foreground">{t.title}</span>
                <small className="block font-normal">{t.task_type}</small>
              </span>
            ),
          },
          { header: "Linked record", cell: (t) => <LinkedRecord task={t} /> },
          { header: "Due", cell: dueLabel },
          { header: "Status", cell: (t) => <Status>{conditionLabel(t)}</Status> },
        ]}
      />
      <Pagination meta={tasks.data?.meta} onPage={setPage} />
      <TaskDialog taskId={openTask} onOpenChange={(open) => !open && setOpenTask(null)} />
    </Section>
  );
}
