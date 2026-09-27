import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { taskKeys, tasksApi, TASK_LINK_FIELDS, type Task, type TaskFilters, type TaskLinkField } from "@/api/tasks";
import { useBranches, useLookups } from "@/api/reference";
import { useBranchFilter } from "@/auth/auth";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Field, NativeSelect } from "@/components/crm/forms";
import { DataTable, Empty, ErrorPanel, LoadingRows, PageHead, Pagination, Status } from "@/components/crm/ui";
import { dateTime, relative } from "@/lib/format";
import { LINK_LABELS, LinkedRecord } from "./linked-record";
import { NewTaskDialog, TaskDialog, conditionLabel, ownerLabel } from "./task-dialogs";

export const TASK_TABS = ["My Tasks", "Team Tasks", "Open", "In Progress", "Waiting/Blocked", "Completed", "Cancelled", "Overdue", "Unassigned / Needs Cover"] as const;

export type TaskSearch = {
  tab?: string;
  page?: number;
  type?: string;
  due_today?: boolean;
} & Partial<Record<TaskLinkField, number>>;

function tabFilters(tab: string): TaskFilters {
  switch (tab) {
    case "Team Tasks":
      return { view: "team" };
    case "Overdue":
      return { view: "team", overdue: true };
    case "Unassigned / Needs Cover":
      return { view: "team", unassigned: true, open: true };
    case "Open":
    case "In Progress":
    case "Waiting/Blocked":
    case "Completed":
    case "Cancelled":
      return { view: "team", status: tab };
    default:
      return { view: "my", open: true };
  }
}

function Deadline({ value, overdue }: { value: string | null; overdue?: boolean | undefined }) {
  if (!value) return <span className="text-muted-foreground">—</span>;
  return (
    <span className={overdue ? "font-medium text-destructive" : undefined}>
      {dateTime(value)}
      <small className="block text-[11px] text-muted-foreground">{relative(value)}</small>
    </span>
  );
}

/** Shared linked work queue: my / team tabs, filters in the URL, task dialog with workflow actions. */
export function TasksPage({ search, onSearch }: { search: TaskSearch; onSearch: (next: TaskSearch) => void }) {
  const branchId = useBranchFilter();
  const lookups = useLookups();
  const { data: branches } = useBranches();
  const [openId, setOpenId] = useState<number | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const tab = search.tab && (TASK_TABS as readonly string[]).includes(search.tab) ? search.tab : "My Tasks";
  const link = TASK_LINK_FIELDS.map((f) => [f, search[f]] as const).find(([, v]) => v !== undefined) as [TaskLinkField, number] | undefined;

  const filters: TaskFilters = {
    ...tabFilters(tab),
    branch_id: branchId,
    type: search.type,
    due_today: search.due_today || undefined,
    page: search.page,
    per_page: 25,
    ...(link ? { [link[0]]: link[1] } : {}),
  };
  const tasks = useQuery({ queryKey: taskKeys.list(filters), queryFn: () => tasksApi.list(filters), placeholderData: (prev) => prev });
  const rows = tasks.data?.data;
  const branchName = (id: number) => branches?.find((b) => b.branch_id === id)?.branch_name ?? String(id);
  const set = (patch: Partial<TaskSearch>) => {
    const next: TaskSearch = { ...search, ...patch, page: undefined };
    for (const key of Object.keys(next) as (keyof TaskSearch)[]) if (next[key] === undefined || next[key] === "" || next[key] === false) delete next[key];
    onSearch(next);
  };

  return (
    <>
      <PageHead
        title="Tasks"
        description="Shared linked work queue — system and manual tasks."
        actions={
          <Button onClick={() => setNewOpen(true)}>
            <Plus />
            Create Task
          </Button>
        }
      />
      <div className="panel">
        <Tabs value={tab} onValueChange={(t) => set({ tab: t === "My Tasks" ? undefined : t })}>
          <TabsList className="mb-4 h-auto max-w-full flex-wrap justify-start overflow-x-auto">
            {TASK_TABS.map((t) => (
              <TabsTrigger key={t} value={t}>
                {t}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="mb-3 flex flex-wrap items-end gap-3">
          <Field label="Task type" htmlFor="tf-type" className="w-56 min-w-0">
            <NativeSelect
              id="tf-type"
              value={search.type ?? ""}
              placeholder="All types"
              options={(lookups.data?.task_types ?? []).map((t) => ({ value: t.code, label: t.label }))}
              onChange={(e) => set({ type: e.target.value || undefined })}
            />
          </Field>
          <label className="flex h-9 items-center gap-2 text-sm">
            <input type="checkbox" checked={Boolean(search.due_today)} onChange={(e) => set({ due_today: e.target.checked || undefined })} />
            Due today only
          </label>
          {link && (
            <span className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-1.5 text-sm">
              Linked to {LINK_LABELS[link[0]]} #{link[1]}
              <Button size="sm" variant="ghost" onClick={() => set({ [link[0]]: undefined })}>
                Clear
              </Button>
            </span>
          )}
        </div>
        <div className="table-desktop">
          <DataTable
            rows={rows}
            loading={tasks.isLoading}
            error={tasks.error}
            onRetry={() => void tasks.refetch()}
            rowKey={(t) => t.task_id}
            onRowClick={(t) => setOpenId(t.task_id)}
            empty={<Empty title={`No tasks in ${tab}`}>Nothing needs attention here.</Empty>}
            columns={[
              { header: "Task", cell: (t) => <span className="font-semibold text-primary">#{t.task_id}</span> },
              { header: "Type", cell: (t) => t.task_type },
              { header: "Title", cell: (t) => <span className="block max-w-72 truncate" title={t.title}>{t.title}</span> },
              { header: "Branch", cell: (t) => branchName(t.branch_id) },
              { header: "Owner", cell: (t) => (t.owner ? t.owner.full_name : <Status kind="warn">{ownerLabel(t)}</Status>) },
              { header: "Workflow status", cell: (t) => <Status>{t.status}</Status> },
              { header: "Derived condition", cell: (t: Task) => conditionLabel(t) || "—" },
              { header: "Original deadline", cell: (t) => <Deadline value={t.original_due_at} overdue={t.is_overdue && !t.revised_due_at} /> },
              { header: "Revised deadline", cell: (t) => <Deadline value={t.revised_due_at} overdue={t.is_overdue} /> },
              { header: "Linked record", cell: (t) => <LinkedRecord task={t} /> },
              {
                header: "",
                cell: (t) => (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={(e) => {
                      e.stopPropagation();
                      setOpenId(t.task_id);
                    }}
                  >
                    Open
                  </Button>
                ),
              },
            ]}
          />
        </div>
        <div className="mobile-lead-list">
          {tasks.isLoading ? (
            <LoadingRows />
          ) : tasks.error ? (
            <ErrorPanel error={tasks.error} onRetry={() => void tasks.refetch()} />
          ) : rows?.length ? (
            rows.map((t) => (
              <button type="button" className="mobile-lead-card text-left" key={t.task_id} onClick={() => setOpenId(t.task_id)}>
                <div className="flex items-start justify-between gap-3">
                  <span className="min-w-0">
                    <span className="block break-words font-semibold">{t.title}</span>
                    <span className="mt-1 block text-xs text-muted-foreground">
                      #{t.task_id} · {t.task_type} · {branchName(t.branch_id)}
                    </span>
                  </span>
                  <Status>{t.status}</Status>
                </div>
                <div className="mt-2 space-y-1 text-xs">
                  <div>
                    Due {dateTime(t.due_at)} · <span className={t.is_overdue ? "font-medium text-destructive" : undefined}>{conditionLabel(t)}</span>
                  </div>
                  <div className="text-muted-foreground">
                    {ownerLabel(t)}
                    {t.revised_due_at ? ` · original ${dateTime(t.original_due_at)}` : ""}
                  </div>
                  <div onClick={(e) => e.stopPropagation()}>
                    <LinkedRecord task={t} />
                  </div>
                </div>
              </button>
            ))
          ) : (
            <Empty title={`No tasks in ${tab}`} />
          )}
        </div>
        <Pagination meta={tasks.data?.meta} onPage={(page) => onSearch({ ...search, page })} />
        <p className="mt-3 text-xs text-muted-foreground">
          Workflow statuses only: Open · In Progress · Waiting/Blocked · Completed · Cancelled. Overdue and Due Today are derived from the current deadline; Unassigned is an assignment condition. Reassignment never changes Lead Owner or Admission.
        </p>
      </div>
      <TaskDialog taskId={openId} onOpenChange={(o) => !o && setOpenId(null)} />
      <NewTaskDialog open={newOpen} onOpenChange={setNewOpen} presetLink={link ? { field: link[0], id: link[1] } : undefined} />
    </>
  );
}
