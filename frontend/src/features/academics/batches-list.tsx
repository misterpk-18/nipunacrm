import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { admissionKeys, admissionsApi } from "@/api/admissions";
import { BATCH_STATUSES, batchKeys, batchesApi, type Batch, type BatchFilters } from "@/api/batches";
import { useAuth, useBranchFilter } from "@/auth/auth";
import { Button } from "@/components/ui/button";
import { CourseSelect, Field, NativeSelect } from "@/components/crm/forms";
import { DataTable, Empty, PageHead, Pagination, Section, Status, Warning } from "@/components/crm/ui";
import { date, dateTime, isPast } from "@/lib/format";
import { BatchDialog } from "./batch-dialog";
import { useCan } from "./can";
import { CurriculumVersions } from "./curriculum";

export type BatchSearch = Omit<BatchFilters, "per_page" | "branch_id">;

export function timing(b: Pick<Batch, "start_time" | "end_time">) {
  return b.start_time ? `${b.start_time}${b.end_time ? `–${b.end_time}` : ""}` : "—";
}

export function BatchesList({ search, onSearch }: { search: BatchSearch; onSearch: (s: BatchSearch) => void }) {
  const branchId = useBranchFilter();
  const { hasRole } = useAuth();
  const can = useCan();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const filters: BatchFilters = { ...search, branch_id: branchId, per_page: 25 };
  const batches = useQuery({ queryKey: batchKeys.list(filters), queryFn: () => batchesApi.list(filters), placeholderData: (p) => p });
  const academic = hasRole("FOUNDER_CEO", "SUPER_ADMIN", "BRANCH_MANAGER", "ACADEMIC_COORDINATOR");
  const queueQuery = { branch_id: branchId, per_page: 50 };
  const queue = useQuery({ queryKey: admissionKeys.queue(queueQuery), queryFn: () => admissionsApi.queue(queueQuery), enabled: academic });
  const set = (patch: Partial<BatchSearch>) => {
    const next = { ...search, ...patch, page: undefined };
    for (const k of Object.keys(next) as (keyof BatchSearch)[]) if (next[k] === "" || next[k] === undefined) delete next[k];
    onSearch(next);
  };

  return (
    <>
      <PageHead
        title="Batch Workspace"
        description="Schedule, capacity and allocation."
        actions={
          academic && (can.isAdmin || hasRole("BRANCH_MANAGER", "ACADEMIC_COORDINATOR")) ? (
            <Button onClick={() => setCreating(true)}>
              <Plus />
              New batch
            </Button>
          ) : undefined
        }
      />
      <div className="mb-4 grid gap-3 md:grid-cols-3">
        <Warning>Accepted delivery plan, enrolment, batch allocation and first regular attendance are separate records.</Warning>
        <Warning>Confirmed seat: allocate within 1 working day after Admission and before first class · future plan ≥ 48h before first class.</Warning>
        <Warning>Unresolved 24h before start escalates to Founder / CEO or Super Admin.</Warning>
      </div>
      <Section title="Batches">
        <div className="mb-3 grid gap-2 sm:grid-cols-3">
          <Field label="Status" htmlFor="bf-status">
            <NativeSelect id="bf-status" value={search.status ?? ""} placeholder="Any" options={BATCH_STATUSES.map((s) => ({ value: s, label: s }))} onChange={(e) => set({ status: e.target.value })} />
          </Field>
          <Field label="Course" htmlFor="bf-course">
            <CourseSelect id="bf-course" value={search.course_id ?? ""} placeholder="Any" onChange={(e) => set({ course_id: e.target.value ? Number(e.target.value) : undefined })} />
          </Field>
        </div>
        <DataTable
          rows={batches.data?.data}
          loading={batches.isLoading}
          error={batches.error}
          onRetry={() => void batches.refetch()}
          rowKey={(b) => b.batch_id}
          onRowClick={(b) => void navigate({ to: "/batches/$batchId", params: { batchId: String(b.batch_id) } })}
          empty={<Empty title="No batches match" />}
          columns={[
            {
              header: "Batch",
              cell: (b) => (
                <Link to="/batches/$batchId" params={{ batchId: String(b.batch_id) }} className="font-semibold text-primary" onClick={(e) => e.stopPropagation()}>
                  {b.batch_code}
                  <small className="block font-normal text-muted-foreground">{b.batch_name}</small>
                </Link>
              ),
            },
            { header: "Branch", cell: (b) => b.branch.branch_name },
            { header: "Course / curriculum", cell: (b) => <span className="block max-w-64 truncate" title={b.course.course_title}>{`${b.course.course_title} · ${b.curriculum_version?.version_label ?? "no curriculum"}`}</span> },
            { header: "Trainer", cell: (b) => b.trainer?.full_name ?? "—" },
            { header: "Mode", cell: (b) => b.delivery_mode },
            { header: "Start → expected end", cell: (b) => `${date(b.start_date)} → ${date(b.end_date)}` },
            { header: "Timing", cell: timing },
            { header: "Days", cell: (b) => b.schedule_days ?? "—" },
            { header: "Min", cell: (b) => b.min_students ?? "—" },
            { header: "Occupancy", cell: (b) => `${b.allocated}/${b.capacity}` },
            { header: "Status", cell: (b) => <Status>{b.is_full && b.status === "Open" ? "Full" : b.status}</Status> },
          ]}
        />
        <Pagination meta={batches.data?.meta} onPage={(page) => onSearch({ ...search, page })} />
      </Section>
      {academic && (
        <Section title="Awaiting batch allocation" className="mt-4" subtitle="Open an admission to map its curriculum and allocate it">
          <DataTable
            rows={queue.data?.data}
            loading={queue.isLoading}
            error={queue.error}
            onRetry={() => void queue.refetch()}
            rowKey={(r) => r.admission.admission_id}
            onRowClick={(r) => void navigate({ to: "/admissions", search: { admission: r.admission.admission_id } })}
            empty={<Empty title="No admissions awaiting allocation" />}
            columns={[
              { header: "Admission", cell: (r) => <span className="font-medium text-primary">{r.admission.admission_code}</span> },
              { header: "Person", cell: (r) => r.admission.person.full_name },
              { header: "Course", cell: (r) => r.admission.course.course_title },
              { header: "Service branch", cell: (r) => r.admission.service_branch.branch_name },
              { header: "Curriculum", cell: (r) => <Status>{r.admission.curriculum_status === "Mapped" ? "Mapped" : "Curriculum Mapping Pending"}</Status> },
              { header: "Admitted", cell: (r) => date(r.admission.admission_date) },
              { header: "Allocate by", cell: (r) => <span className={isPast(r.allocate_by) ? "font-medium text-destructive" : undefined}>{dateTime(r.allocate_by)}</span> },
            ]}
          />
        </Section>
      )}
      <CurriculumVersions className="mt-4" />
      <BatchDialog open={creating} onOpenChange={setCreating} />
    </>
  );
}
