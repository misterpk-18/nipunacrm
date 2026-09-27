import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { ENROLMENT_STATUSES, LMS_STATUSES } from "@/api/admissions";
import { studentKeys, studentsApi, type StudentFilters } from "@/api/students";
import { useBranchFilter } from "@/auth/auth";
import { Input } from "@/components/ui/input";
import { Field, NativeSelect } from "@/components/crm/forms";
import { DataTable, Empty, ErrorPanel, LoadingRows, PageHead, Pagination, Status } from "@/components/crm/ui";
import { maskPhone, money } from "@/lib/format";

export type StudentSearch = Omit<StudentFilters, "per_page" | "branch_id">;

export function StudentsList({ search, onSearch }: { search: StudentSearch; onSearch: (s: StudentSearch) => void }) {
  const branchId = useBranchFilter();
  const navigate = useNavigate();
  const [text, setText] = useState(search.q ?? "");
  const filters: StudentFilters = { ...search, branch_id: branchId, per_page: 25 };
  const students = useQuery({ queryKey: studentKeys.list(filters), queryFn: () => studentsApi.list(filters), placeholderData: (p) => p });
  const rows = students.data?.data;
  const set = (patch: Partial<StudentSearch>) => {
    const next = { ...search, ...patch, page: undefined };
    for (const k of Object.keys(next) as (keyof StudentSearch)[]) if (next[k] === "" || next[k] === undefined) delete next[k];
    onSearch(next);
  };
  const open = (id: number) => void navigate({ to: "/students/$personId", params: { personId: String(id) } });

  return (
    <>
      <PageHead title="Students" description="One Person / Student Master per learner · separate admissions per course." />
      <div className="panel">
        <div className="mb-3 grid gap-2 sm:grid-cols-[1fr_12rem_12rem] sm:items-end">
          <form
            className="relative min-w-0"
            onSubmit={(e) => {
              e.preventDefault();
              set({ q: text.trim() || undefined });
            }}
          >
            <Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" />
            <Input className="pl-9" placeholder="Search name, phone or person ID — press Enter" value={text} onChange={(e) => setText(e.target.value)} aria-label="Search students" />
          </form>
          <Field label="Enrolment" htmlFor="sf-enrol">
            <NativeSelect id="sf-enrol" value={search.enrolment_status ?? ""} placeholder="Any" options={ENROLMENT_STATUSES.map((s) => ({ value: s, label: s }))} onChange={(e) => set({ enrolment_status: e.target.value })} />
          </Field>
          <Field label="LMS" htmlFor="sf-lms">
            <NativeSelect id="sf-lms" value={search.lms_status ?? ""} placeholder="Any" options={LMS_STATUSES.map((s) => ({ value: s, label: s }))} onChange={(e) => set({ lms_status: e.target.value })} />
          </Field>
        </div>
        <div className="table-desktop">
          <DataTable
            rows={rows}
            loading={students.isLoading}
            error={students.error}
            onRetry={() => void students.refetch()}
            rowKey={(s) => s.person_id}
            onRowClick={(s) => open(s.person_id)}
            empty={<Empty title="No students match" />}
            columns={[
              { header: "Person ID", cell: (s) => s.person_code },
              {
                header: "Student",
                cell: (s) => (
                  <Link to="/students/$personId" params={{ personId: String(s.person_id) }} className="font-semibold text-primary" onClick={(e) => e.stopPropagation()}>
                    {s.full_name}
                  </Link>
                ),
              },
              { header: "Phone", cell: (s) => maskPhone(s.phone) },
              { header: "Original branch", cell: (s) => s.registered_branch.branch_name },
              { header: "Admissions", cell: (s) => s.admissions },
              { header: "Active courses", cell: (s) => <span className="block max-w-64 truncate" title={s.active_courses.join(", ")}>{s.active_courses.join(", ") || "—"}</span> },
              { header: "Verified paid", cell: (s) => money(s.verified_paid) },
              { header: "Outstanding", cell: (s) => money(s.outstanding) },
              { header: "LMS", cell: (s) => (s.lms_statuses.length ? s.lms_statuses.map((x) => <Status key={x}>{x}</Status>) : "—") },
            ]}
          />
        </div>
        <div className="mobile-lead-list">
          {students.isLoading ? (
            <LoadingRows />
          ) : students.error ? (
            <ErrorPanel error={students.error} onRetry={() => void students.refetch()} />
          ) : rows?.length ? (
            rows.map((s) => (
              <Link key={s.person_id} to="/students/$personId" params={{ personId: String(s.person_id) }} className="mobile-lead-card block">
                <div className="flex items-start justify-between gap-2">
                  <span className="font-semibold text-primary">{s.full_name}</span>
                  <small className="text-muted-foreground">{s.person_code}</small>
                </div>
                <div className="mt-1 text-xs text-muted-foreground">{s.active_courses.join(", ") || "No active course"}</div>
                <div className="mt-2 text-xs">
                  {s.registered_branch.branch_name} · paid {money(s.verified_paid)} · outstanding {money(s.outstanding)}
                </div>
              </Link>
            ))
          ) : (
            <Empty title="No students match" />
          )}
        </div>
        <Pagination meta={students.data?.meta} onPage={(page) => onSearch({ ...search, page })} />
      </div>
    </>
  );
}
