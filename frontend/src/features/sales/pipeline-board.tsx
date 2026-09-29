import { useState, type DragEvent } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { BookOpen, CalendarDays, ClipboardList, Clock3, Columns3, List, Plus, Search, Settings2 } from "lucide-react";
import { leadKeys } from "@/api/leads";
import { MANUAL_STAGES, PROTECTED_STAGES, pipelineApi, pipelineKeys, type NextAction, type PipelineCard, type PipelineFilters } from "@/api/pipeline";
import { useLookups } from "@/api/reference";
import { useBranchFilter } from "@/auth/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CourseSelect, Field, NativeSelect } from "@/components/crm/forms";
import { Avatar, DataTable, Empty, ErrorPanel, LoadingRows, PageHead, Pagination, PriorityChip, Section, Status } from "@/components/crm/ui";
import { followUpLabel } from "@/features/leads/leads-list";
import { date, money } from "@/lib/format";
import { useApiMutation } from "@/lib/mutation";
import { CardLostDialog, CardManageDialog } from "./pipeline-card-dialogs";

export type PipelineSearch = { view?: "kanban" | "table"; q?: string; owner_id?: string; priority?: string; course_id?: number; stage?: string; page?: number };

const LOST = "__lost__";
const movable = (card: PipelineCard) => card.stage !== "Admitted" && card.stage !== "Lost - closed" && !PROTECTED_STAGES.includes(card.stage);
const courseNames = (card: PipelineCard) => card.courses.map((c) => c.course?.course_title ?? "No course yet");
/** Status dot per stage chip (V4). */
export const STAGE_DOTS: Record<string, string> = {
  Counselling: "#9b8cf0",
  "Demo Scheduled": "#3476cc",
  "Demo Attended": "#2a8fb8",
  "Fee Discussion / Payment Awaited": "#d89314",
  "Payment Pending Verification": "#9562c7",
  Admitted: "#1a9b52",
  "Lost - closed": "#c4484f",
};

type Dialog = { kind: "lost" | "manage"; card: PipelineCard } | null;

function useMoveStage() {
  return useApiMutation((v: { card: PipelineCard; stage: string }) => pipelineApi.moveStage(v.card.pipeline_entry_id, { stage: v.stage }), {
    success: (card) => `${card.person.full_name} moved to ${card.stage}`,
    invalidate: [pipelineKeys.all, leadKeys.all, ["persons"]],
  });
}

/** Move to a manual stage, or "Mark lost…" (opens the reason dialog). System-set stages can only be marked lost. */
function MoveSelect({ card, onMove, onLost, disabled }: { card: PipelineCard; onMove: (stage: string) => void; onLost: () => void; disabled?: boolean }) {
  if (card.stage === "Admitted" || card.stage === "Lost - closed") return null;
  if (!movable(card))
    return (
      <div className="flex items-center justify-between gap-2" onClick={(e) => e.stopPropagation()}>
        <span className="text-[11px] text-muted-foreground">System-set stage</span>
        <Button size="sm" variant="ghost" className="h-7 px-2 text-xs text-destructive" onClick={onLost}>
          Mark lost
        </Button>
      </div>
    );
  return (
    <div onClick={(e) => e.stopPropagation()} className="min-w-0">
      <NativeSelect
        aria-label={`Move ${card.person.full_name} to stage`}
        className="h-7 text-xs"
        value=""
        disabled={disabled}
        placeholder="Move to…"
        options={[...MANUAL_STAGES.filter((s) => s !== card.stage).map((s) => ({ value: s, label: s })), { value: LOST, label: "Mark lost…" }]}
        onChange={(e) => (e.target.value === LOST ? onLost() : e.target.value && onMove(e.target.value))}
      />
    </div>
  );
}

function CardDialogs({ dialog, onClose }: { dialog: Dialog; onClose: () => void }) {
  if (!dialog) return null;
  return dialog.kind === "lost" ? <CardLostDialog card={dialog.card} onClose={onClose} /> : <CardManageDialog card={dialog.card} onClose={onClose} />;
}

export function PipelineBoard({ search, onSearch }: { search: PipelineSearch; onSearch: (next: PipelineSearch) => void }) {
  const branchId = useBranchFilter();
  const lookups = useLookups();
  const [text, setText] = useState(search.q ?? "");
  const view = search.view ?? "kanban";
  const base: PipelineFilters = { branch_id: branchId, q: search.q, owner_id: search.owner_id, priority: search.priority, course_id: search.course_id };
  const filters: PipelineFilters = { ...base, stage: search.stage };
  const set = (patch: Partial<PipelineSearch>) => onSearch({ ...search, ...patch, page: undefined });
  // Chips and header always come from the unfiltered-by-stage board, so counts stay visible while a chip is selected
  const summary = useQuery({ queryKey: pipelineKeys.board({ ...base, per_stage: 1 }), queryFn: () => pipelineApi.board({ ...base, per_stage: 1 }), placeholderData: (prev) => prev });
  const stats = summary.data?.stats;
  const chipTotal = (summary.data?.chips ?? []).reduce((sum, c) => sum + c.count, 0);

  return (
    <>
      <PageHead
        title="Deal pipeline"
        description="A clear path from qualified interest to a confirmed admission."
        actions={
          <Button asChild>
            <Link to="/leads">
              <Plus />
              Convert a qualified lead
            </Link>
          </Button>
        }
      />
      <div className="mb-5 flex flex-wrap items-baseline gap-x-6 gap-y-2" aria-label="Pipeline summary">
        <span>
          <b className="text-xl">{stats?.open_opportunities ?? "—"}</b> <span className="text-sm text-muted-foreground">open opportunities</span>
        </span>
        <span className="sm:border-l sm:pl-6">
          <b className="text-xl">{stats ? money(stats.open_value) : "—"}</b> <span className="text-sm text-muted-foreground">open value</span>
        </span>
        <span className="sm:border-l sm:pl-6">
          <b className="text-xl">{stats?.admitted ?? "—"}</b> <span className="text-sm text-muted-foreground">admitted</span>
        </span>
      </div>

      <div className="mb-2 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="font-semibold">Opportunities by stage</h2>
          <p className="text-xs text-muted-foreground">
            {chipTotal} total · {branchId ? "Selected branch" : "All branches"} · Select a stage to filter
          </p>
        </div>
        {search.stage && (
          <Button size="sm" variant="ghost" onClick={() => set({ stage: undefined })}>
            Show all stages
          </Button>
        )}
      </div>
      <div className="stage-chips mb-4" role="group" aria-label="Stage filter">
        {(summary.data?.chips ?? []).map((chip) => (
          <button
            key={chip.stage}
            type="button"
            className="stage-chip"
            aria-pressed={search.stage === chip.stage}
            data-testid={`chip-${chip.stage}`}
            style={{ ["--stage-dot" as string]: STAGE_DOTS[chip.stage] }}
            onClick={() => set({ stage: search.stage === chip.stage ? undefined : chip.stage })}
          >
            <span>
              <i />
              {chip.label}
            </span>
            <b>{chip.count}</b>
          </button>
        ))}
      </div>

      <div className="mb-4 flex flex-wrap items-end gap-2">
        <form
          className="relative min-w-56 flex-[2_1_16rem]"
          onSubmit={(e) => {
            e.preventDefault();
            set({ q: text.trim() || undefined });
          }}
        >
          <Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" />
          <Input className="pl-9" placeholder="Search student, course or deal… (Enter)" value={text} onChange={(e) => setText(e.target.value)} aria-label="Search pipeline" />
        </form>
        <Field label="Owner" className="flex-[1_1_9rem]">
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
        <Field label="Priority" className="flex-[1_1_9rem]">
          <NativeSelect
            value={search.priority ?? ""}
            placeholder="Any"
            options={(lookups.data?.enums["lead_priorities"] ?? []).map((s) => ({ value: s, label: s }))}
            onChange={(e) => set({ priority: e.target.value || undefined })}
          />
        </Field>
        <Field label="Course" className="flex-[1_1_11rem]">
          <CourseSelect value={search.course_id ?? ""} placeholder="Any" onChange={(e) => set({ course_id: e.target.value ? Number(e.target.value) : undefined })} />
        </Field>
        <div className="flex rounded-md border bg-card p-1">
          <Button size="sm" variant={view === "kanban" ? "secondary" : "ghost"} onClick={() => set({ view: "kanban" })} aria-pressed={view === "kanban"} aria-label="Board view">
            <Columns3 />
          </Button>
          <Button size="sm" variant={view === "table" ? "secondary" : "ghost"} onClick={() => set({ view: "table" })} aria-pressed={view === "table"} aria-label="List view">
            <List />
          </Button>
        </div>
      </div>

      {view === "kanban" ? <Kanban filters={filters} /> : <PipelineTable filters={filters} page={search.page} onPage={(page) => onSearch({ ...search, page })} />}
      <NextActions filters={base} />
      <p className="mt-4 text-xs text-muted-foreground">
        Qualified lead → Deal → Accepted delivery plan → Invoice → Verified payment → Admission. Open a deal to review or update its next step.
      </p>
    </>
  );
}

function DealCard({ card, onManage, onLost, onMove, busy }: { card: PipelineCard; onManage: () => void; onLost: () => void; onMove: (stage: string) => void; busy: boolean }) {
  const first = card.courses[0];
  return (
    <article
      draggable={movable(card)}
      onDragStart={(e) => e.dataTransfer.setData("text/plain", String(card.pipeline_entry_id))}
      className="deal-card mb-2"
      aria-label={card.person.full_name}
    >
      <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span>{card.entry_code}</span>
        <span className="flex items-center gap-1">
          <span className="subtle-chip">{card.branch.branch_code.replace("NIT-", "")}</span>
          <Button size="icon" variant="ghost" className="size-6" title="Owner, follow-up & expected close" aria-label={`Manage ${card.person.full_name}`} onClick={onManage}>
            <Settings2 className="size-3.5" />
          </Button>
        </span>
      </div>
      <Link
        to={first ? "/leads/$leadId" : "/persons/$personId"}
        params={first ? { leadId: String(first.lead_id) } : { personId: String(card.person.person_id) }}
        className="mt-1 block font-semibold text-foreground hover:text-primary"
      >
        {card.person.full_name}
      </Link>
      <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
        {card.courses.map((course) => (
          <li key={course.lead_id} className="flex items-center gap-1.5 truncate">
            <BookOpen className="size-3 shrink-0" />
            <Link to="/leads/$leadId" params={{ leadId: String(course.lead_id) }} className="truncate hover:underline">
              {course.course?.course_title ?? "No course yet"}
            </Link>
            {course.invoice && <span className="text-[10px] text-primary">· {course.invoice.invoice_number}</span>}
          </li>
        ))}
      </ul>
      <div className="mt-2 text-lg font-bold">{money(card.value)}</div>
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Clock3 className="size-3.5" />
        {card.delivery_plan_status}
      </div>
      <div className="mt-2 flex items-center justify-between gap-2 border-t pt-2 text-xs">
        <span className="flex min-w-0 items-center gap-1.5">
          <Avatar name={card.owner?.full_name ?? "?"} className="size-6 text-[10px]" />
          <span className="truncate">{card.owner?.full_name ?? "Unassigned"}</span>
        </span>
        <span className="flex shrink-0 items-center gap-1 text-muted-foreground" title="Expected close">
          <CalendarDays className="size-3.5" />
          {card.expected_close_date ? date(card.expected_close_date).replace(/ \d{4}$/, "") : "—"}
        </span>
      </div>
      {card.ai_priority && (
        <div className="mt-2">
          <PriorityChip priority={card.ai_priority} score={card.ai_score} />
        </div>
      )}
      <div className="mt-2">
        <MoveSelect card={card} disabled={busy} onMove={onMove} onLost={onLost} />
      </div>
    </article>
  );
}

function Kanban({ filters }: { filters: PipelineFilters }) {
  const board = useQuery({ queryKey: pipelineKeys.board(filters), queryFn: () => pipelineApi.board(filters), placeholderData: (prev) => prev });
  const move = useMoveStage();
  const [over, setOver] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  if (board.isLoading) return <LoadingRows rows={6} />;
  if (board.error) return <ErrorPanel error={board.error} onRetry={() => void board.refetch()} />;
  const columns = board.data?.columns ?? [];
  const allCards = columns.flatMap((c) => c.cards);

  const onDrop = (e: DragEvent, stage: string | undefined) => {
    e.preventDefault();
    setOver(null);
    const card = allCards.find((c) => c.pipeline_entry_id === Number(e.dataTransfer.getData("text/plain")));
    if (card && stage && card.stage !== stage && movable(card) && MANUAL_STAGES.includes(stage)) move.mutate({ card, stage });
  };

  return (
    <>
      <div className="flex gap-3 overflow-x-auto pb-4" aria-label="Pipeline board">
        {columns.map((col) => {
          // Dropping on the Demo column means "Demo Scheduled"
          const dropStage = col.stages.find((s) => MANUAL_STAGES.includes(s));
          return (
            <section
              className={`board-column w-64 shrink-0 ${over === col.key ? "ring-2 ring-primary" : ""}`}
              key={col.key}
              aria-label={col.label}
              onDragOver={(e) => {
                if (dropStage) {
                  e.preventDefault();
                  setOver(col.key);
                }
              }}
              onDragLeave={() => setOver((o) => (o === col.key ? null : o))}
              onDrop={(e) => onDrop(e, dropStage)}
            >
              <div className="mb-3 px-1">
                <div className="flex items-center justify-between text-sm font-semibold">
                  <span className="flex items-center gap-1.5">
                    <i className="inline-block size-2 rounded-full" style={{ background: STAGE_DOTS[col.stages[0]!] }} />
                    {col.label}
                  </span>
                  <span className="queue-count" data-testid="stage-count">
                    {col.count}
                  </span>
                </div>
                <div className="text-xs text-muted-foreground">{money(col.value)}</div>
              </div>
              {col.cards.length === 0 && (
                <div className="empty-column">
                  <Columns3 className="size-5" />
                  No opportunities here
                </div>
              )}
              {col.cards.map((c) => (
                <DealCard
                  key={c.pipeline_entry_id}
                  card={c}
                  busy={move.isPending}
                  onManage={() => setDialog({ kind: "manage", card: c })}
                  onLost={() => setDialog({ kind: "lost", card: c })}
                  onMove={(stage) => move.mutate({ card: c, stage })}
                />
              ))}
              {col.count > col.cards.length && <p className="p-1 text-center text-xs text-muted-foreground">+{col.count - col.cards.length} more — switch to list</p>}
            </section>
          );
        })}
      </div>
      <CardDialogs dialog={dialog} onClose={() => setDialog(null)} />
    </>
  );
}

function PipelineTable({ filters, page, onPage }: { filters: PipelineFilters; page?: number | undefined; onPage: (page: number) => void }) {
  const navigate = useNavigate();
  const query = { ...filters, page, per_page: 25 };
  const table = useQuery({ queryKey: pipelineKeys.table(query), queryFn: () => pipelineApi.table(query), placeholderData: (prev) => prev });
  const move = useMoveStage();
  const [dialog, setDialog] = useState<Dialog>(null);
  return (
    <div className="panel">
      <DataTable
        stack
        rows={table.data?.data}
        loading={table.isLoading}
        error={table.error}
        onRetry={() => void table.refetch()}
        rowKey={(c) => c.pipeline_entry_id}
        onRowClick={(c) => c.courses[0] && void navigate({ to: "/leads/$leadId", params: { leadId: String(c.courses[0].lead_id) } })}
        empty={<Empty title="No opportunities match" />}
        columns={[
          {
            header: "Person",
            cell: (c) => (
              <span className="font-semibold">
                {c.person.full_name}
                <small className="block font-normal text-muted-foreground">{c.entry_code}</small>
              </span>
            ),
          },
          { header: "Courses", cell: (c) => <span className="block max-w-56 truncate" title={courseNames(c).join(", ")}>{courseNames(c).join(", ") || "—"}</span> },
          { header: "Value", cell: (c) => money(c.value) },
          { header: "Stage", cell: (c) => <Status>{c.stage}</Status> },
          { header: "Delivery plan", cell: (c) => c.delivery_plan_status },
          { header: "Owner", cell: (c) => c.owner?.full_name ?? <Status kind="warn">Unassigned</Status> },
          { header: "Expected close", cell: (c) => date(c.expected_close_date) },
          { header: "Follow-up", cell: followUpLabel },
          {
            header: "Actions",
            cell: (c) => (
              <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                <MoveSelect card={c} disabled={move.isPending} onMove={(stage) => move.mutate({ card: c, stage })} onLost={() => setDialog({ kind: "lost", card: c })} />
                <Button size="icon" variant="ghost" className="size-7" title="Owner & follow-up" aria-label={`Manage ${c.person.full_name}`} onClick={() => setDialog({ kind: "manage", card: c })}>
                  <Settings2 />
                </Button>
              </div>
            ),
          },
        ]}
      />
      <Pagination meta={table.data?.meta} onPage={onPage} />
      <CardDialogs dialog={dialog} onClose={() => setDialog(null)} />
    </div>
  );
}

/** Branch next actions (V4): pending payment evidence, demo outcome, delivery plan, invoice, balance follow-up. */
function NextActions({ filters }: { filters: PipelineFilters }) {
  const query = { branch_id: filters.branch_id, q: filters.q };
  const q = useQuery({ queryKey: pipelineKeys.nextActions(query), queryFn: () => pipelineApi.nextActions(query) });
  const rows = q.data ?? [];
  return (
    <Section
      className="mt-6"
      title="Next actions"
      subtitle={`${rows.length} open opportunit${rows.length === 1 ? "y" : "ies"} · ${filters.branch_id ? "Selected branch" : "All branches"}`}
      action={<span className="flex items-center gap-1.5 text-xs text-muted-foreground"><ClipboardList className="size-4" />Based on each deal's current progress</span>}
    >
      {q.isLoading && <LoadingRows rows={3} />}
      {q.error && <ErrorPanel error={q.error} onRetry={() => void q.refetch()} />}
      {!q.isLoading && rows.length === 0 && <Empty title="Nothing waiting — every deal is moving" />}
      <ul className="divide-y" aria-label="Next actions">
        {rows.map((a: NextAction) => (
          <li key={a.pipeline_entry_id} className="grid gap-2 py-3 sm:grid-cols-[1.2fr_1.6fr_1fr_auto] sm:items-center">
            <div className="min-w-0">
              <div className="text-sm font-semibold">{a.person.full_name}</div>
              <div className="truncate text-xs text-muted-foreground">
                {a.entry_code} · {a.course?.course_title ?? a.lead_code} · {a.branch.branch_name}
              </div>
            </div>
            <div className="min-w-0">
              <div className="text-sm font-semibold">{a.title}</div>
              <div className="text-xs text-muted-foreground">{a.detail}</div>
            </div>
            <div className="text-xs text-muted-foreground">{a.owner?.full_name ?? "Unassigned"}</div>
            <Button size="sm" variant="outline" asChild>
              {a.action === "review_payment" || a.action === "follow_up_balance" ? (
                <Link to="/invoices/$invoiceId" params={{ invoiceId: String(a.invoice?.invoice_id ?? 0) }}>
                  Review deal
                </Link>
              ) : (
                <Link to="/leads/$leadId" params={{ leadId: String(a.lead_id) }}>
                  Review deal
                </Link>
              )}
            </Button>
          </li>
        ))}
      </ul>
    </Section>
  );
}
