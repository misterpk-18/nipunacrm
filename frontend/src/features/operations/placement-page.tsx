import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Building2, Plus, Search } from "lucide-react";
import { JOB_STATUSES, placementApi, placementKeys, type JobOpening, type StudentRow } from "@/api/placement";
import { useBranches, useStaff } from "@/api/reference";
import { useAuth, useBranchFilter } from "@/auth/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, NativeSelect } from "@/components/crm/forms";
import { DataTable, Empty, Metric, PageHead, Pagination, Section, Status } from "@/components/crm/ui";
import { date, dateTime } from "@/lib/format";
import { useApiMutation } from "@/lib/mutation";
import { ApplicationsTable, CompanyDialog, JobDialog, ProfileDialog } from "./placement-dialogs";

const MANAGE_ROLES = ["FOUNDER_CEO", "SUPER_ADMIN", "BRANCH_MANAGER", "PLACEMENT"] as const;

/** Placement & Alumni: Job Opening Master, companies, profiles / consent, applications, alumni. */
export function PlacementPage() {
  const { hasRole } = useAuth();
  const branchId = useBranchFilter();
  const canManage = hasRole(...MANAGE_ROLES);
  const [jobStatus, setJobStatus] = useState("");
  const [jobPage, setJobPage] = useState(1);
  const [companyOpen, setCompanyOpen] = useState(false);
  const [jobOpen, setJobOpen] = useState(false);
  const [appStage, setAppStage] = useState("");

  const jobFilters = { status: jobStatus || undefined, page: jobPage, per_page: 25 };
  const jobs = useQuery({ queryKey: placementKeys.jobs(jobFilters), queryFn: () => placementApi.jobs(jobFilters), enabled: canManage, placeholderData: (p) => p });
  const openJobs = useQuery({ queryKey: placementKeys.jobs({ status: "Open", per_page: 1 }), queryFn: () => placementApi.jobs({ status: "Open", per_page: 1 }), enabled: canManage });
  const companies = useQuery({ queryKey: placementKeys.companies(), queryFn: () => placementApi.companies(), enabled: canManage });
  const appFilters = { stage: appStage || undefined };
  const apps = useQuery({ queryKey: placementKeys.applications(appFilters), queryFn: () => placementApi.applications(appFilters), enabled: canManage });
  const allApps = useQuery({ queryKey: placementKeys.applications({}), queryFn: () => placementApi.applications({}), enabled: canManage });
  const owners = useStaff(undefined, ["PLACEMENT"], canManage);
  const { data: branches } = useBranches();

  const updateJob = useApiMutation((v: { id: number; status?: string; verified?: boolean }) => placementApi.updateJob(v.id, { ...(v.status ? { status: v.status } : {}), ...(v.verified ? { verified: true } : {}) }), {
    success: (j) => `${j.job_code} updated`,
    invalidate: [placementKeys.all],
  });
  const toggleCompany = useApiMutation((v: { id: number; active: boolean }) => placementApi.updateCompany(v.id, { is_active: v.active }), {
    success: (c) => `${c.company_name} ${c.is_active ? "activated" : "deactivated"}`,
    invalidate: [placementKeys.all],
  });

  const active = (allApps.data ?? []).filter((a) => !["Joined", "Rejected", "Withdrawn", "Offer Declined"].includes(a.stage));
  const interviews = (allApps.data ?? []).filter((a) => a.stage === "Interview Scheduled").length;
  const evidencePending = (allApps.data ?? []).filter((a) => ["Offer Received", "Offer Accepted", "Joined"].includes(a.stage) && a.evidence_status !== "Verified").length;
  const ownerName = (id: number | null) => (id ? owners.data?.find((o) => o.user_id === id)?.full_name ?? `User #${id}` : "Placement team");
  const branchName = (id: number | null) => (id ? branches?.find((b) => b.branch_id === id)?.branch_name ?? String(id) : "All branches");

  return (
    <>
      <PageHead
        title="Placement & Alumni"
        description="Career assistance only — no guaranteed placement."
        actions={
          canManage && (
            <>
              <Button onClick={() => setJobOpen(true)}>
                <Plus />
                New job opening
              </Button>
              <Button variant="outline" onClick={() => setCompanyOpen(true)}>
                <Building2 />
                Add company
              </Button>
            </>
          )
        }
      />
      {canManage && (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
            <Metric label="Open jobs" value={openJobs.data?.meta.total ?? 0} loading={openJobs.isLoading} />
            <Metric label="Active applications" value={active.length} loading={allApps.isLoading} />
            <Metric label="Interviews scheduled" value={interviews} loading={allApps.isLoading} />
            <Metric label="Evidence pending" value={evidencePending} hint="Offers / joins not yet verified" loading={allApps.isLoading} />
          </div>

          <Section
            title="Job Opening Master"
            subtitle="Opening a job records it as verified now; re-verify when the employer confirms again."
            action={
              <div className="w-44">
                <NativeSelect aria-label="Job status filter" value={jobStatus} placeholder="All statuses" options={JOB_STATUSES.map((s) => ({ value: s, label: s }))} onChange={(e) => {
                  setJobStatus(e.target.value);
                  setJobPage(1);
                }} />
              </div>
            }
          >
            <DataTable
              rows={jobs.data?.data}
              loading={jobs.isLoading}
              error={jobs.error}
              onRetry={() => void jobs.refetch()}
              rowKey={(j) => j.job_opening_id}
              empty={<Empty title="No job openings" />}
              columns={[
                { header: "Job ID", cell: (j) => <span className="font-semibold">{j.job_code}</span> },
                { header: "Company", cell: (j) => j.company_name },
                { header: "Job title", cell: (j) => j.job_title },
                { header: "Employment type", cell: (j) => j.employment_type },
                { header: "Location / mode", cell: (j) => `${j.location ?? branchName(j.branch_id)} · ${j.work_mode}` },
                { header: "Required skills", cell: (j) => <span className="block max-w-48 truncate">{j.required_skills ?? "—"}</span> },
                { header: "Salary / CTC", cell: (j) => j.salary_ctc ?? "—" },
                { header: "Source / last verification", cell: (j: JobOpening) => `${j.source ?? "Manual"} · ${j.last_verified_at ? dateTime(j.last_verified_at) : "Not verified"}` },
                { header: "Placement owner", cell: (j) => ownerName(j.placement_owner_id) },
                {
                  header: "Status",
                  cell: (j) => (
                    <div className="flex items-center gap-1">
                      <NativeSelect
                        aria-label={`Status of ${j.job_code}`}
                        className="h-8 w-40"
                        value={j.status}
                        options={JOB_STATUSES.map((s) => ({ value: s, label: s }))}
                        onChange={(e) => updateJob.mutate({ id: j.job_opening_id, status: e.target.value })}
                      />
                      <Button size="sm" variant="ghost" title="Record that the opening was re-verified now" onClick={() => updateJob.mutate({ id: j.job_opening_id, verified: true })}>
                        Verify
                      </Button>
                    </div>
                  ),
                },
              ]}
            />
            <Pagination meta={jobs.data?.meta} onPage={setJobPage} />
          </Section>

          <Section title="Companies" className="mt-4" subtitle="Employers the placement team works with">
            <DataTable
              rows={companies.data}
              loading={companies.isLoading}
              error={companies.error}
              onRetry={() => void companies.refetch()}
              rowKey={(c) => c.company_id}
              empty={<Empty title="No companies yet" />}
              columns={[
                { header: "Company", cell: (c) => <span className="font-semibold">{c.company_name}</span> },
                { header: "Industry", cell: (c) => c.industry ?? "—" },
                { header: "City", cell: (c) => c.city ?? "—" },
                { header: "Contact", cell: (c) => [c.contact_name, c.contact_phone, c.contact_email].filter(Boolean).join(" · ") || "—" },
                { header: "Status", cell: (c) => <Status kind={c.is_active ? "good" : "neutral"}>{c.is_active ? "Active" : "Inactive"}</Status> },
                {
                  header: "",
                  cell: (c) => (
                    <Button size="sm" variant="ghost" onClick={() => toggleCompany.mutate({ id: c.company_id, active: !c.is_active })}>
                      {c.is_active ? "Deactivate" : "Activate"}
                    </Button>
                  ),
                },
              ]}
            />
          </Section>

          <Section title="Placement profiles" className="mt-4" subtitle="Open a student's profile to update readiness, CV, preferences and consent, and to apply to jobs.">
            <StudentPicker branchId={branchId} />
          </Section>

          <Section
            title="Applications"
            className="mt-4"
            action={
              <div className="w-48">
                <NativeSelect aria-label="Application stage filter" value={appStage} placeholder="All stages" options={["Applied", "Shortlisted", "Interview Scheduled", "Interview Attended", "Selected", "Offer Received", "Offer Accepted", "Joined", "Rejected", "Withdrawn", "Offer Declined"].map((s) => ({ value: s, label: s }))} onChange={(e) => setAppStage(e.target.value)} />
              </div>
            }
          >
            <ApplicationsTable query={apps} />
            <p className="mt-3 text-xs text-muted-foreground">
              Pipeline: Applied → Shortlisted → Interview Scheduled → Interview Attended → Selected → Offer Received → Offer Accepted → Joined. No-show is an interview event, not automatic closure.
            </p>
          </Section>
        </>
      )}
      <AlumniSection className={canManage ? "mt-4" : undefined} />
      <CompanyDialog open={companyOpen} onOpenChange={setCompanyOpen} />
      <JobDialog open={jobOpen} onOpenChange={setJobOpen} />
    </>
  );
}

function StudentPicker({ branchId }: { branchId: number | undefined }) {
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [person, setPerson] = useState<StudentRow | null>(null);
  const filters = { q: q || undefined, page, branch_id: branchId };
  const students = useQuery({ queryKey: placementKeys.students(filters), queryFn: () => placementApi.students(filters), placeholderData: (p) => p });
  return (
    <>
      <form
        className="relative mb-3 max-w-md"
        onSubmit={(e) => {
          e.preventDefault();
          setQ(text.trim());
          setPage(1);
        }}
      >
        <Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" />
        <Input className="pl-9" placeholder="Search students — press Enter" aria-label="Search students" value={text} onChange={(e) => setText(e.target.value)} />
      </form>
      <DataTable
        rows={students.data?.data}
        loading={students.isLoading}
        error={students.error}
        onRetry={() => void students.refetch()}
        rowKey={(s) => s.person_id}
        empty={<Empty title="No students found" />}
        columns={[
          {
            header: "Student",
            cell: (s) => (
              <Link to="/students/$personId" params={{ personId: String(s.person_id) }} className="font-semibold text-primary">
                {s.full_name}
                <small className="block font-normal text-muted-foreground">{s.person_code}</small>
              </Link>
            ),
          },
          { header: "Branch", cell: (s) => s.registered_branch.branch_name },
          { header: "Active courses", cell: (s) => <span className="block max-w-72 truncate">{s.active_courses.join(", ") || "—"}</span> },
          {
            header: "",
            cell: (s) => (
              <Button size="sm" variant="outline" onClick={() => setPerson(s)}>
                Placement profile
              </Button>
            ),
          },
        ]}
      />
      <Pagination meta={students.data?.meta} onPage={setPage} />
      <ProfileDialog person={person} onClose={() => setPerson(null)} />
    </>
  );
}

function AlumniSection({ className }: { className?: string | undefined }) {
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  const [support, setSupport] = useState("");
  const [page, setPage] = useState(1);
  const filters = { q: q || undefined, support_active: support === "" ? undefined : support === "true", page };
  const alumni = useQuery({ queryKey: placementKeys.alumni(filters), queryFn: () => placementApi.alumni(filters), placeholderData: (p) => p });
  return (
    <Section title="Alumni and support" className={className} subtitle="Alumni begins after authorised completion of one standalone course or a full combo. Alumni + Active may coexist.">
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <form
          className="min-w-0 flex-1 basis-56"
          onSubmit={(e) => {
            e.preventDefault();
            setQ(text.trim());
            setPage(1);
          }}
        >
          <Field label="Search alumni" htmlFor="al-q">
            <Input id="al-q" placeholder="Name — press Enter" value={text} onChange={(e) => setText(e.target.value)} />
          </Field>
        </form>
        <Field label="Support" htmlFor="al-support" className="w-44">
          <NativeSelect
            id="al-support"
            value={support}
            placeholder="Any"
            options={[
              { value: "true", label: "Support active" },
              { value: "false", label: "Support ended" },
            ]}
            onChange={(e) => {
              setSupport(e.target.value);
              setPage(1);
            }}
          />
        </Field>
      </div>
      <DataTable
        rows={alumni.data?.data}
        loading={alumni.isLoading}
        error={alumni.error}
        onRetry={() => void alumni.refetch()}
        rowKey={(a) => a.person_id}
        empty={<Empty title="No alumni yet">Students become alumni after an authorised course completion.</Empty>}
        columns={[
          {
            header: "Alumnus",
            cell: (a) => (
              <Link to="/students/$personId" params={{ personId: String(a.person_id) }} className="font-semibold text-primary">
                {a.full_name}
                <small className="block font-normal text-muted-foreground">{a.person_code}</small>
              </Link>
            ),
          },
          { header: "Alumni since", cell: (a) => date(a.alumni_since) },
          { header: "Completed admissions", cell: (a) => a.completed_admissions },
          { header: "Also active", cell: (a) => (a.is_also_active ? <Status kind="good">Active</Status> : "No") },
          { header: "Support until", cell: (a) => date(a.support_until) },
          { header: "Support", cell: (a) => <Status kind={a.support_active ? "good" : "neutral"}>{a.support_active ? "Support active" : "Support ended"}</Status> },
        ]}
      />
      <Pagination meta={alumni.data?.meta} onPage={setPage} />
      <p className="mt-3 text-xs text-muted-foreground">Standard support is 6 months after academic completion for new admissions; extensions require Founder / CEO or Super Admin.</p>
    </Section>
  );
}
