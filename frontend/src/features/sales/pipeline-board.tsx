import { useState, type DragEvent } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Columns3, List, Search } from "lucide-react";
import { leadKeys, type LeadRow } from "@/api/leads";
import { MANUAL_STAGES, PROTECTED_STAGES, pipelineApi, pipelineKeys, type PipelineFilters } from "@/api/pipeline";
import { useLookups } from "@/api/reference";
import { useBranchFilter } from "@/auth/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CourseSelect, Field, NativeSelect } from "@/components/crm/forms";
import { DataTable, Empty, ErrorPanel, LoadingRows, PageHead, Pagination, Status, Warning } from "@/components/crm/ui";
import { followUpLabel } from "@/features/leads/leads-list";
import { maskPhone } from "@/lib/format";
import { useApiMutation } from "@/lib/mutation";

export type PipelineSearch = { view?: "kanban" | "table"; q?: string; owner_id?: string; priority?: string; course_id?: number; page?: number };

const movable = (lead: LeadRow) => !PROTECTED_STAGES.includes(lead.stage);

function useMoveStage() {
  return useApiMutation((v: { lead: LeadRow; stage: string }) => pipelineApi.moveStage(v.lead.lead_id, v.stage), {
    success: (lead) => `${lead.name} moved to ${lead.stage}`,
    invalidate: [pipelineKeys.all, leadKeys.all],
  });
}

function MoveSelect({ lead, onMove, disabled }: { lead: LeadRow; onMove: (stage: string) => void; disabled?: boolean }) {
  if (!movable(lead)) return <span className="text-[11px] text-muted-foreground">System-set stage</span>;
  return (
    <div onClick={(e) => e.stopPropagation()} className="min-w-0">
      <NativeSelect
        aria-label={`Move ${lead.name} to stage`}
        className="h-7 text-xs"
        value=""
        disabled={disabled}
        placeholder="Move to…"
        options={MANUAL_STAGES.filter((s) => s !== lead.stage).map((s) => ({ value: s, label: s }))}
        onChange={(e) => e.target.value && onMove(e.target.value)}
      />
    </div>
  );
}

export function PipelineBoard({ search, onSearch }: { search: PipelineSearch; onSearch: (next: PipelineSearch) => void }) {
  const branchId = useBranchFilter();
  const lookups = useLookups();
  const [text, setText] = useState(search.q ?? "");
  const view = search.view ?? "kanban";
  const filters: PipelineFilters = { branch_id: branchId, q: search.q, owner_id: search.owner_id, priority: search.priority, course_id: search.course_id };
  const set = (patch: Partial<PipelineSearch>) => onSearch({ ...search, ...patch, page: undefined });

  return (
    <>
      <PageHead
        title="Pipeline"
        description="Opportunity flow by stage. Drag a card (or use “Move to…”) between the manual stages."
        actions={
          <div className="flex rounded-md border p-1">
            <Button size="sm" variant={view === "kanban" ? "secondary" : "ghost"} onClick={() => set({ view: "kanban" })} aria-pressed={view === "kanban"}>
              <Columns3 />
              Kanban
            </Button>
            <Button size="sm" variant={view === "table" ? "secondary" : "ghost"} onClick={() => set({ view: "table" })} aria-pressed={view === "table"}>
              <List />
              Table
            </Button>
          </div>
        }
      />
      <div className="panel mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <form
          className="relative self-end"
          onSubmit={(e) => {
            e.preventDefault();
            set({ q: text.trim() || undefined });
          }}
        >
          <Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" />
          <Input className="pl-9" placeholder="Search — press Enter" value={text} onChange={(e) => setText(e.target.value)} aria-label="Search pipeline" />
        </form>
        <Field label="Owner">
          <NativeSelect
            value={search.owner_id ?? ""}
            placeholder="Anyone"
            options={[
              { value: "me", label: "Assigned to me" },
              { value: "unassigned", label: "Unassigned" },
            ]}
            onChange={(e) => set({ owner_id: e.target.value || undefined })}
          />
        </Field>
        <Field label="AI priority">
          <NativeSelect
            value={search.priority ?? ""}
            placeholder="Any"
            options={(lookups.data?.enums["lead_priorities"] ?? []).map((s) => ({ value: s, label: s }))}
            onChange={(e) => set({ priority: e.target.value || undefined })}
          />
        </Field>
        <Field label="Course">
          <CourseSelect value={search.course_id ?? ""} placeholder="Any" onChange={(e) => set({ course_id: e.target.value ? Number(e.target.value) : undefined })} />
        </Field>
      </div>
      {view === "kanban" ? <Kanban filters={filters} /> : <PipelineTable filters={filters} page={search.page} onPage={(page) => onSearch({ ...search, page })} />}
      <div className="mt-4">
        <Warning>
          Fee Shared and Token Paid — Verified are milestones, not stages. Payment Pending Verification is set when a payment is recorded, Admitted when the admission is
          created, and Lost through “Mark lost” on the lead (with a reason) — these are never moved by hand, and a lead never moves back from Payment Pending Verification.
        </Warning>
      </div>
    </>
  );
}

function Kanban({ filters }: { filters: PipelineFilters }) {
  const board = useQuery({ queryKey: pipelineKeys.board(filters), queryFn: () => pipelineApi.board(filters), placeholderData: (prev) => prev });
  const move = useMoveStage();
  const [over, setOver] = useState<string | null>(null);
  if (board.isLoading) return <LoadingRows rows={6} />;
  if (board.error) return <ErrorPanel error={board.error} onRetry={() => void board.refetch()} />;
  const stages = board.data?.stages ?? [];
  const allLeads = stages.flatMap((s) => s.leads);

  const onDrop = (e: DragEvent, stage: string) => {
    e.preventDefault();
    setOver(null);
    const lead = allLeads.find((l) => l.lead_id === Number(e.dataTransfer.getData("text/plain")));
    if (lead && lead.stage !== stage && movable(lead) && MANUAL_STAGES.includes(stage)) move.mutate({ lead, stage });
  };

  return (
    <>
      <p className="mb-2 text-xs text-muted-foreground">{board.data?.total ?? 0} leads in scope</p>
      <div className="flex gap-3 overflow-x-auto pb-4" aria-label="Pipeline board">
        {stages.map((s) => {
          const droppable = MANUAL_STAGES.includes(s.stage);
          return (
            <section
              className="w-64 shrink-0"
              key={s.stage}
              aria-label={s.stage}
              onDragOver={(e) => {
                if (droppable) {
                  e.preventDefault();
                  setOver(s.stage);
                }
              }}
              onDragLeave={() => setOver((o) => (o === s.stage ? null : o))}
              onDrop={(e) => onDrop(e, s.stage)}
            >
              <div className="mb-2 flex justify-between text-xs font-semibold">
                <span>{s.stage}</span>
                <span data-testid="stage-count">{s.count}</span>
              </div>
              <div className={`min-h-52 rounded-md bg-muted p-2 ${over === s.stage ? "ring-2 ring-primary" : ""}`}>
                {s.leads.length === 0 && <p className="p-2 text-center text-xs text-muted-foreground">No leads</p>}
                {s.leads.map((l) => (
                  <article
                    key={l.lead_id}
                    draggable={movable(l)}
                    onDragStart={(e) => e.dataTransfer.setData("text/plain", String(l.lead_id))}
                    className="mb-2 block rounded-md border bg-card p-3"
                    aria-label={l.name}
                  >
                    <Link to="/leads/$leadId" params={{ leadId: String(l.lead_id) }} className="text-sm font-semibold text-primary">
                      {l.name}
                    </Link>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {l.course?.course_title ?? "No course"} · {l.branch.branch_name}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">{l.owner?.full_name ?? "Unassigned"}</p>
                    <div className="mt-2 flex items-center justify-between gap-2">
                      {l.ai_priority ? <Status>{l.ai_priority}</Status> : <span className="text-xs text-muted-foreground">No AI priority</span>}
                      <span className="text-xs">{l.age_days}d</span>
                    </div>
                    <div className="mt-2">
                      <MoveSelect lead={l} disabled={move.isPending} onMove={(stage) => move.mutate({ lead: l, stage })} />
                    </div>
                  </article>
                ))}
                {s.count > s.leads.length && (
                  <Link to="/leads" search={{ stage: s.stage }} className="block p-1 text-center text-xs text-primary">
                    +{s.count - s.leads.length} more in Leads
                  </Link>
                )}
              </div>
            </section>
          );
        })}
      </div>
    </>
  );
}

function PipelineTable({ filters, page, onPage }: { filters: PipelineFilters; page?: number | undefined; onPage: (page: number) => void }) {
  const navigate = useNavigate();
  const query = { ...filters, page, per_page: 25 };
  const table = useQuery({ queryKey: pipelineKeys.table(query), queryFn: () => pipelineApi.table(query), placeholderData: (prev) => prev });
  const move = useMoveStage();
  return (
    <div className="panel">
      <DataTable
        rows={table.data?.data}
        loading={table.isLoading}
        error={table.error}
        onRetry={() => void table.refetch()}
        rowKey={(l) => l.lead_id}
        onRowClick={(l) => void navigate({ to: "/leads/$leadId", params: { leadId: String(l.lead_id) } })}
        empty={<Empty title="No leads match" />}
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
          { header: "Source", cell: (l) => l.original_source },
          { header: "Assigned", cell: (l) => l.owner?.full_name ?? <Status kind="warn">Unassigned</Status> },
          { header: "Stage", cell: (l) => <Status>{l.stage}</Status> },
          { header: "Follow-up", cell: followUpLabel },
          { header: "Age", cell: (l) => `${l.age_days}d` },
          { header: "AI", cell: (l) => (l.ai_priority ? <Status>{`${l.ai_priority}${l.ai_score !== null ? ` · ${l.ai_score}` : ""}`}</Status> : "—") },
          { header: "Actions", cell: (l) => <MoveSelect lead={l} disabled={move.isPending} onMove={(stage) => move.mutate({ lead: l, stage })} /> },
        ]}
      />
      <Pagination meta={table.data?.meta} onPage={onPage} />
    </div>
  );
}
