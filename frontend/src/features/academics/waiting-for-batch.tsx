/**
 * Waiting for batch: admitted students the LMS has not allocated yet. Read-only here — the Branch Manager
 * allocates in the Nipuna LMS and the allocation comes back by the pull, which takes the student off this list.
 */
import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { ExternalLink, Search } from "lucide-react";
import { useWaitingForBatch, type DelayStage, type WaitingFilters, type WaitingRow } from "@/api/batch-waiting";
import { useBranchFilter } from "@/auth/auth";
import { CourseSelect, Field, NativeSelect } from "@/components/crm/forms";
import { DataTable, Empty, PageHead, Pagination, Section, Status, Warning } from "@/components/crm/ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { date } from "@/lib/format";

export type WaitingSearch = Omit<WaitingFilters, "per_page" | "branch_id">;

const DELAY_LABEL: Record<DelayStage, string> = {
  coordinator: "Late: Branch Manager tasked",
  manager: "Escalated: Branch Manager alerted",
  founder: "Escalated to Founder / Super Admin",
};
const DELAY_TONE: Record<DelayStage, "warn" | "danger"> = { coordinator: "warn", manager: "warn", founder: "danger" };

export function WaitingForBatch({ search, onSearch }: { search: WaitingSearch; onSearch: (next: WaitingSearch) => void }) {
  const branchId = useBranchFilter();
  const navigate = useNavigate();
  const [text, setText] = useState(search.q ?? "");
  const filters: WaitingFilters = { ...search, branch_id: branchId, per_page: 25 };
  const rows = useWaitingForBatch(filters);
  const set = (patch: Partial<WaitingSearch>) => {
    const next = { ...search, ...patch, page: undefined };
    for (const k of Object.keys(next) as (keyof WaitingSearch)[]) if (next[k] === "" || next[k] === undefined) delete next[k];
    onSearch(next);
  };

  return (
    <>
      <PageHead title="Waiting for batch" description="Admitted students who are not in a batch yet. The Branch Manager allocates them in the Nipuna LMS." />
      <div className="mb-4">
        <Warning>
          Confirmed seat: a batch is due within 1 working day of admission, or before the first class if sooner; future plan: 48 hours
          before the planned start. The Branch Manager is tasked and the owner counsellor told when it runs late, the Branch Manager is
          escalated to at 2 working days, then the Founder / Super Admin at 5. A student leaves this list as soon as the LMS reports the allocation.
        </Warning>
      </div>
      <Section title="Not yet allocated" subtitle={rows.data ? `${rows.data.meta.total} student(s), longest wait first` : undefined}>
        <div className="mb-3 grid gap-2 sm:grid-cols-3">
          <form
            className="relative sm:col-span-1"
            onSubmit={(e) => {
              e.preventDefault();
              set({ q: text.trim() || undefined });
            }}
          >
            <Search className="absolute left-3 top-3 size-4 text-muted-foreground" />
            <Input className="pl-9" placeholder="Search student or admission code" value={text} onChange={(e) => setText(e.target.value)} aria-label="Search waiting students" />
          </form>
          <Field label="Course" htmlFor="wf-course">
            <CourseSelect id="wf-course" value={search.course_id ?? ""} placeholder="Any" onChange={(e) => set({ course_id: e.target.value ? Number(e.target.value) : undefined })} />
          </Field>
          <Field label="Seat type" htmlFor="wf-seat">
            <NativeSelect
              id="wf-seat"
              value={search.seat_type ?? ""}
              placeholder="Any"
              options={[
                { value: "Confirmed Seat", label: "Confirmed Seat" },
                { value: "Future Plan", label: "Future Plan" },
              ]}
              onChange={(e) => set({ seat_type: e.target.value })}
            />
          </Field>
        </div>
        <DataTable
          stack
          rows={rows.data?.data}
          loading={rows.isLoading}
          error={rows.error}
          onRetry={() => void rows.refetch()}
          rowKey={(r) => r.admission_id}
          onRowClick={(r) => void navigate({ to: "/admissions", search: { admission: r.admission_id } as never })}
          empty={<Empty title="Nobody is waiting for a batch" />}
          columns={[
            {
              header: "Student",
              cell: (r) => (
                <span>
                  <Link to="/students/$personId" params={{ personId: String(r.person.person_id) }} className="font-semibold text-primary" onClick={(e) => e.stopPropagation()}>
                    {r.person.full_name}
                  </Link>
                  <small className="block text-muted-foreground">{r.admission_code}</small>
                </span>
              ),
            },
            { header: "Course", cell: (r) => <span className="block max-w-56 truncate" title={r.course.course_title}>{r.course.course_title}</span> },
            { header: "Admitted", cell: (r) => date(r.admission_date) },
            { header: "Days waiting", cell: (r) => <DaysWaiting row={r} /> },
            {
              header: "Seat · start",
              cell: (r) => (
                <span>
                  {r.seat_type}
                  <small className="block text-muted-foreground">{r.planned_start_date ? `Starts ${date(r.planned_start_date)}` : "No start date"}</small>
                </span>
              ),
            },
            {
              header: "Preferred batch",
              cell: (r) =>
                r.preferred_batch ? (
                  <span title="The counsellor's wish; the Branch Manager allocates in the LMS">
                    {r.preferred_batch.label ?? r.preferred_batch.code}
                    {r.preferred_batch.label && <small className="block text-muted-foreground">{r.preferred_batch.code}</small>}
                  </span>
                ) : (
                  <span className="text-muted-foreground">None chosen</span>
                ),
            },
            { header: "Branch", cell: (r) => r.service_branch.branch_name },
            {
              header: "LMS",
              cell: (r) =>
                r.lms_url ? (
                  <Button size="sm" variant="outline" asChild onClick={(e) => e.stopPropagation()}>
                    <a href={r.lms_url} target="_blank" rel="noreferrer">
                      Open in LMS
                      <ExternalLink />
                    </a>
                  </Button>
                ) : (
                  <span className="text-xs text-muted-foreground" title="Set LMS_WEB_URL on the server to enable this link">No LMS link set</span>
                ),
            },
          ]}
        />
        <Pagination meta={rows.data?.meta} onPage={(page) => onSearch({ ...search, page })} />
      </Section>
    </>
  );
}

function DaysWaiting({ row }: { row: WaitingRow }) {
  return (
    <span>
      <span className={row.delay ? "font-semibold text-destructive" : undefined}>{row.days_waiting}</span>
      {row.delay && (
        <small className="mt-0.5 block">
          <Status kind={DELAY_TONE[row.delay]}>{DELAY_LABEL[row.delay]}</Status>
        </small>
      )}
    </span>
  );
}
