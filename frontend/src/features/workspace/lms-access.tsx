/**
 * LMS access (V4, Phase 9): every admission with its curriculum, LMS and enrolment status. Read-only — the LMS
 * creates the login from the CRM's AdmissionQualified event (db 026) and its status comes back by the pull (db 028).
 */
import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { CURRICULUM_STATUSES, ENROLMENT_STATUSES, LMS_STATUSES } from "@/api/admissions";
import { useLmsAccess, useLmsStatusCounts, useLmsSyncStatus, type LmsFilters } from "@/api/lms";
import { useBranchFilter } from "@/auth/auth";
import { dateTime } from "@/lib/format";
import { NativeSelect } from "@/components/crm/forms";
import { DataTable, Empty, PageHead, Pagination, StatTile, Status, Warning } from "@/components/crm/ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export type LmsSearch = Omit<LmsFilters, "per_page" | "branch_id">;

/** LMS status → chip tone (Active is live access; Not Created / Invited still need the learner's LMS account). */
const LMS_TONE: Record<string, "good" | "warn" | "neutral" | "info" | "danger"> = {
  "Not Created": "warn",
  Invited: "info",
  Active: "good",
  Inactive: "danger",
  Completed: "neutral",
};

export function LmsAccessPage({ search, onSearch }: { search: LmsSearch; onSearch: (next: LmsSearch) => void }) {
  const branchId = useBranchFilter();
  const navigate = useNavigate();
  const [text, setText] = useState(search.q ?? "");
  const filters: LmsFilters = { ...search, branch_id: branchId, per_page: 25 };
  const rows = useLmsAccess(filters);
  const counts = useLmsStatusCounts(branchId);
  const sync = useLmsSyncStatus().data;
  const pull = sync?.pull;
  const set = (patch: Partial<LmsSearch>) => onSearch({ ...search, ...patch, page: undefined });

  return (
    <>
      <PageHead
        eyebrow=""
        title="LMS access"
        description="One row per admission: curriculum mapping, LMS account status and enrolment. Read-only here."
      />
      <div className="mb-5">
        <Warning>
          The LMS creates each learner's login when the admission reaches it, and sends the activation link itself; the LMS
          status here comes back from the LMS.{" "}
          {pull?.last_success_at ? `Last synced ${dateTime(pull.last_success_at)}.` : "Not synced yet."}
          {pull?.last_error ? ` Last attempt failed: ${pull.last_error}.` : ""}
          {sync?.held ? ` ${sync.held} record(s) waiting to apply.` : ""} The admission and its verified receipts stay valid
          whatever the LMS status.
        </Warning>
      </div>
      <div className="mb-5 grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5 lg:gap-4" aria-label="LMS status">
        {LMS_STATUSES.map((s) => (
          <StatTile key={s} label={s} value={counts[s] ?? "…"} active={search.lms_status === s} onClick={() => set({ lms_status: search.lms_status === s ? undefined : s })} />
        ))}
      </div>
      <section className="panel">
        <div className="section-head mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2>Access review</h2>
          {rows.data && <span className="text-xs text-muted-foreground">{rows.data.meta.total} admissions</span>}
        </div>
        <div className="mb-4 flex flex-wrap gap-2">
          <form
            className="relative min-w-0 flex-1 basis-60"
            onSubmit={(e) => {
              e.preventDefault();
              set({ q: text.trim() || undefined });
            }}
          >
            <Search className="absolute left-3 top-3 size-4 text-muted-foreground" />
            <Input className="pl-9" placeholder="Search learner, person code or admission code" value={text} onChange={(e) => setText(e.target.value)} aria-label="Search LMS access" />
          </form>
          <div className="min-w-0 flex-1 basis-40 sm:max-w-52 sm:flex-none">
            <NativeSelect aria-label="LMS status" value={search.lms_status ?? ""} placeholder="Any LMS status" options={LMS_STATUSES.map((s) => ({ value: s, label: s }))} onChange={(e) => set({ lms_status: e.target.value || undefined })} />
          </div>
          <div className="min-w-0 flex-1 basis-40 sm:max-w-52 sm:flex-none">
            <NativeSelect aria-label="Curriculum" value={search.curriculum_status ?? ""} placeholder="Any curriculum" options={CURRICULUM_STATUSES.map((s) => ({ value: s, label: s }))} onChange={(e) => set({ curriculum_status: e.target.value || undefined })} />
          </div>
          <div className="min-w-0 flex-1 basis-40 sm:max-w-56 sm:flex-none">
            <NativeSelect aria-label="Enrolment" value={search.enrolment_status ?? ""} placeholder="Any enrolment" options={ENROLMENT_STATUSES.map((s) => ({ value: s, label: s }))} onChange={(e) => set({ enrolment_status: e.target.value || undefined })} />
          </div>
          {Object.keys(search).some((k) => k !== "page") && (
            <Button
              variant="ghost"
              onClick={() => {
                setText("");
                onSearch({});
              }}
            >
              Clear
            </Button>
          )}
        </div>
        <DataTable
          stack
          rows={rows.data?.data}
          loading={rows.isLoading}
          error={rows.error}
          onRetry={() => void rows.refetch()}
          rowKey={(a) => a.admission_id}
          onRowClick={(a) => void navigate({ to: "/admissions", search: { admission: a.admission_id } as never })}
          empty={<Empty title="No admissions match">Admissions appear here once they are created.</Empty>}
          columns={[
            {
              header: "Learner",
              cell: (a) => (
                <span className="block">
                  <span className="font-semibold text-foreground">{a.person.full_name}</span>
                  <small className="block font-normal">{a.person.person_code ?? `Person #${a.person.person_id}`}</small>
                </span>
              ),
            },
            {
              header: "Admission / course",
              cell: (a) => (
                <span className="block">
                  {a.admission_code}
                  <small className="block">
                    {a.course.course_title} · {a.service_branch.branch_name}
                  </small>
                </span>
              ),
            },
            { header: "Curriculum", cell: (a) => <Status kind={a.curriculum_status === "Mapped" ? "good" : "warn"}>{a.curriculum_status}</Status> },
            { header: "LMS status", cell: (a) => <Status kind={LMS_TONE[a.lms_status] ?? "neutral"}>{a.lms_status}</Status> },
            { header: "Enrolment", cell: (a) => <Status>{a.enrolment_status}</Status> },
          ]}
        />
        <Pagination meta={rows.data?.meta} onPage={(page) => onSearch({ ...search, page })} />
      </section>
    </>
  );
}
