import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Filter, Plus, Search } from "lucide-react";
import {
  CURRICULUM_STATUSES,
  ENROLMENT_STATUSES,
  PAYMENT_COMPLETION,
  SEAT_TYPES,
  admissionKeys,
  admissionsApi,
  type AdmissionFilters,
  type AdmissionRow,
} from "@/api/admissions";
import { useAuth, useBranchFilter } from "@/auth/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { CourseSelect, Field, NativeSelect } from "@/components/crm/forms";
import { DataTable, Empty, PageHead, Pagination, Section, Status, Warning } from "@/components/crm/ui";
import { date, dateTime, isPast, money } from "@/lib/format";
import { AdmissionPanel } from "./admission-detail";
import { useCan } from "./can";

export type AdmissionSearch = Omit<AdmissionFilters, "per_page" | "branch_id"> & { admission?: number };

const FILTER_KEYS: (keyof AdmissionSearch)[] = ["enrolment_status", "curriculum_status", "payment_completion", "seat_type", "course_id"];

export function AdmissionsList({ search, onSearch }: { search: AdmissionSearch; onSearch: (next: AdmissionSearch) => void }) {
  const branchId = useBranchFilter();
  const { hasRole } = useAuth();
  const can = useCan();
  const [text, setText] = useState(search.q ?? "");
  const [showFilters, setShowFilters] = useState(FILTER_KEYS.some((k) => search[k] !== undefined));
  const { admission, ...rest } = search;
  const filters: AdmissionFilters = { ...rest, branch_id: branchId, per_page: 25 };
  const admissions = useQuery({ queryKey: admissionKeys.list(filters), queryFn: () => admissionsApi.list(filters), placeholderData: (p) => p });
  const canQueue = hasRole("FOUNDER_CEO", "SUPER_ADMIN", "BRANCH_MANAGER", "ACADEMIC_COORDINATOR");
  const queueQuery = { branch_id: branchId, per_page: 50 };
  const queue = useQuery({ queryKey: admissionKeys.queue(queueQuery), queryFn: () => admissionsApi.queue(queueQuery), enabled: canQueue });
  const canCreate = can.isAdmin || hasRole("BRANCH_MANAGER", "SALES", "FRONT_OFFICE");

  const set = (patch: Partial<AdmissionSearch>) => {
    const next = { ...search, ...patch, page: undefined };
    for (const key of Object.keys(next) as (keyof AdmissionSearch)[]) if (next[key] === "" || next[key] === undefined) delete next[key];
    onSearch(next);
  };
  const open = (id: number | undefined) => onSearch({ ...search, admission: id });
  const activeFilters = FILTER_KEYS.filter((k) => search[k] !== undefined).length;

  return (
    <>
      <PageHead
        title="Admissions"
        description="Delivery, allocation and academic handover."
        actions={
          <>
            {canCreate && (
              <Button asChild>
                <Link to="/admissions/new" search={{}}>
                  <Plus />
                  Create Admission
                </Link>
              </Button>
            )}
            {hasRole("FOUNDER_CEO", "SUPER_ADMIN", "BRANCH_MANAGER", "ACADEMIC_COORDINATOR", "TRAINER") && (
              <Button asChild variant="outline">
                <Link to="/batches">Batch Workspace</Link>
              </Button>
            )}
          </>
        }
      />
      <div className="mb-4 grid gap-3 md:grid-cols-3">
        <Warning>Confirmed seat: allocate within 1 working day after Admission and before first class.</Warning>
        <Warning>Future plan: allocate at least 48h before first class.</Warning>
        <Warning>Unresolved 24h before start escalates to Founder / CEO or Super Admin.</Warning>
      </div>
      {canQueue && (
        <Section title="Awaiting batch allocation" subtitle="Allocate-by and escalation deadlines from the allocation queue" className="mb-4">
          <DataTable
            rows={queue.data?.data}
            loading={queue.isLoading}
            error={queue.error}
            onRetry={() => void queue.refetch()}
            rowKey={(r) => r.admission.admission_id}
            onRowClick={(r) => open(r.admission.admission_id)}
            empty={<Empty title="No admissions awaiting allocation" />}
            columns={[
              { header: "Admission", cell: (r) => <span className="font-medium text-primary">{r.admission.admission_code}</span> },
              { header: "Person", cell: (r) => r.admission.person.full_name },
              { header: "Course", cell: (r) => <span className="block max-w-56 truncate">{r.admission.course.course_title}</span> },
              { header: "Service branch", cell: (r) => r.admission.service_branch.branch_name },
              { header: "Seat", cell: (r) => `${r.seat_type}${r.planned_start_date ? ` · ${date(r.planned_start_date)}` : ""}` },
              { header: "Curriculum", cell: (r) => <Status>{r.admission.curriculum_status === "Mapped" ? "Mapped" : "Curriculum Mapping Pending"}</Status> },
              { header: "Allocate by", cell: (r) => <span className={isPast(r.allocate_by) ? "font-medium text-destructive" : undefined}>{dateTime(r.allocate_by)}</span> },
              { header: "Escalates", cell: (r) => dateTime(r.escalate_at) },
            ]}
          />
        </Section>
      )}
      <Section title="Admission and enrolment records" subtitle="Each admission shows its accepted delivery plan and first qualifying verified payment">
        <div className="mb-3 flex flex-wrap gap-2">
          <form
            className="relative min-w-0 flex-1 basis-56"
            onSubmit={(e) => {
              e.preventDefault();
              set({ q: text.trim() || undefined });
            }}
          >
            <Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" />
            <Input className="pl-9" placeholder="Search name, phone or admission code — press Enter" value={text} onChange={(e) => setText(e.target.value)} aria-label="Search admissions" />
          </form>
          <Button variant={showFilters ? "secondary" : "outline"} onClick={() => setShowFilters((x) => !x)}>
            <Filter />
            Filters{activeFilters ? ` (${activeFilters})` : ""}
          </Button>
        </div>
        {showFilters && (
          <div className="mb-3 grid gap-2 rounded-md border p-3 sm:grid-cols-2 lg:grid-cols-5">
            <Field label="Enrolment" htmlFor="af-enrol">
              <NativeSelect id="af-enrol" value={search.enrolment_status ?? ""} placeholder="Any" options={ENROLMENT_STATUSES.map((s) => ({ value: s, label: s }))} onChange={(e) => set({ enrolment_status: e.target.value })} />
            </Field>
            <Field label="Curriculum" htmlFor="af-curr">
              <NativeSelect id="af-curr" value={search.curriculum_status ?? ""} placeholder="Any" options={CURRICULUM_STATUSES.map((s) => ({ value: s, label: s }))} onChange={(e) => set({ curriculum_status: e.target.value })} />
            </Field>
            <Field label="Payment" htmlFor="af-pay">
              <NativeSelect id="af-pay" value={search.payment_completion ?? ""} placeholder="Any" options={PAYMENT_COMPLETION.map((s) => ({ value: s, label: s }))} onChange={(e) => set({ payment_completion: e.target.value })} />
            </Field>
            <Field label="Seat type" htmlFor="af-seat">
              <NativeSelect id="af-seat" value={search.seat_type ?? ""} placeholder="Any" options={SEAT_TYPES.map((s) => ({ value: s, label: s }))} onChange={(e) => set({ seat_type: e.target.value })} />
            </Field>
            <Field label="Course" htmlFor="af-course">
              <CourseSelect id="af-course" value={search.course_id ?? ""} placeholder="Any" onChange={(e) => set({ course_id: e.target.value ? Number(e.target.value) : undefined })} />
            </Field>
            <div className="sm:col-span-2 lg:col-span-5">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setText("");
                  onSearch({});
                }}
              >
                Clear filters
              </Button>
            </div>
          </div>
        )}
        <DataTable<AdmissionRow>
          rows={admissions.data?.data}
          loading={admissions.isLoading}
          error={admissions.error}
          onRetry={() => void admissions.refetch()}
          rowKey={(a) => a.admission_id}
          onRowClick={(a) => open(a.admission_id)}
          empty={<Empty title="No admissions match">Try clearing the search or filters.</Empty>}
          columns={[
            {
              header: "Admission",
              cell: (a) => (
                <button type="button" className="text-left font-semibold text-primary" onClick={(e) => { e.stopPropagation(); open(a.admission_id); }}>
                  {a.admission_code}
                  <small className="block font-normal text-muted-foreground">{date(a.admission_date)}</small>
                </button>
              ),
            },
            {
              header: "Person",
              cell: (a) => (
                <Link to="/students/$personId" params={{ personId: String(a.person.person_id) }} className="text-primary" onClick={(e) => e.stopPropagation()}>
                  {a.person.full_name}
                  <small className="block text-muted-foreground">{a.person.person_code}</small>
                </Link>
              ),
            },
            { header: "Original / service", cell: (a) => `${a.original_branch.branch_code} / ${a.service_branch.branch_code}` },
            { header: "Course", cell: (a) => <span className="block max-w-56 truncate" title={a.course.course_title}>{a.course.course_title}</span> },
            { header: "Accepted plan", cell: (a) => `${a.seat_type} · ${a.delivery_mode}` },
            { header: "Fee · outstanding", cell: (a) => `${money(a.final_fee)} · ${money(a.outstanding)}` },
            { header: "Payment", cell: (a) => <Status>{a.payment_completion}</Status> },
            { header: "Curriculum", cell: (a) => <Status>{a.curriculum_status === "Mapped" ? "Mapped" : "Curriculum Mapping Pending"}</Status> },
            { header: "Enrolment", cell: (a) => <Status>{a.enrolment_status}</Status> },
            { header: "LMS", cell: (a) => a.lms_status },
          ]}
        />
        <Pagination meta={admissions.data?.meta} onPage={(page) => onSearch({ ...search, page })} />
      </Section>
      <Sheet open={!!admission} onOpenChange={(o) => !o && open(undefined)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-3xl">
          <SheetHeader className="mb-4">
            <SheetTitle>Admission detail</SheetTitle>
            <SheetDescription>Allocation, curriculum, fee changes and lifecycle actions.</SheetDescription>
          </SheetHeader>
          {admission && <AdmissionPanel key={admission} admissionId={admission} />}
        </SheetContent>
      </Sheet>
    </>
  );
}
