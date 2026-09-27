import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { useQuery } from "@tanstack/react-query";
import {
  APPLICATION_EVENT_TYPES,
  APPLICATION_STAGES,
  CLOSED_STAGES,
  CV_REVIEW_STATUSES,
  EMPLOYMENT_TYPES,
  EVIDENCE_STATUSES,
  JOB_STATUSES,
  PLACEMENT_READINESS,
  WORK_MODES,
  placementApi,
  placementKeys,
  type CompanyInput,
  type JobApplication,
  type JobInput,
  type PlacementProfile,
  type ProfileInput,
} from "@/api/placement";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { BranchSelect, Field, NativeSelect, StaffSelect, applyServerErrors } from "@/components/crm/forms";
import { ConfirmAction, DataTable, ErrorPanel, LoadingRows, Status, Warning } from "@/components/crm/ui";
import { date, dateTime, fromLocalInput } from "@/lib/format";
import { useApiMutation } from "@/lib/mutation";

const opts = (values: string[]) => values.map((v) => ({ value: v, label: v }));
const invalidate = [placementKeys.all, ["students"]];

// ---------------------------------------------------------------- company

type CompanyValues = { company_name: string; industry: string; city: string; website: string; contact_name: string; contact_email: string; contact_phone: string; notes: string };

export function CompanyDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const empty: CompanyValues = { company_name: "", industry: "", city: "", website: "", contact_name: "", contact_email: "", contact_phone: "", notes: "" };
  const form = useForm<CompanyValues>({ defaultValues: empty });
  const { register, handleSubmit, formState, reset } = form;
  useEffect(() => {
    if (open) reset(empty);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const create = useApiMutation(placementApi.createCompany, {
    success: (c) => `${c.company_name} added`,
    invalidate,
    silentValidation: true,
    onSuccess: () => onOpenChange(false),
    onError: (e) => applyServerErrors(form, e),
  });
  const submit = handleSubmit((v) => {
    const body: CompanyInput = {};
    for (const [k, val] of Object.entries(v)) if (val.trim()) (body as Record<string, string>)[k] = val.trim();
    create.mutate(body);
  });
  const err = (n: keyof CompanyValues) => formState.errors[n]?.message;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] w-[calc(100vw-1.5rem)] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add company</DialogTitle>
          <DialogDescription>Employers we assist students with. Company names are unique.</DialogDescription>
        </DialogHeader>
        <form id="company-form" onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
          <Field label="Company name" error={err("company_name")} htmlFor="co-name" className="sm:col-span-2">
            <Input id="co-name" {...register("company_name", { required: "Required" })} />
          </Field>
          <Field label="Industry" error={err("industry")} htmlFor="co-industry">
            <Input id="co-industry" {...register("industry")} />
          </Field>
          <Field label="City" error={err("city")} htmlFor="co-city">
            <Input id="co-city" {...register("city")} />
          </Field>
          <Field label="Website" error={err("website")} htmlFor="co-web" className="sm:col-span-2">
            <Input id="co-web" {...register("website")} />
          </Field>
          <Field label="Contact name" error={err("contact_name")} htmlFor="co-contact">
            <Input id="co-contact" {...register("contact_name")} />
          </Field>
          <Field label="Contact phone" error={err("contact_phone")} htmlFor="co-phone">
            <Input id="co-phone" inputMode="tel" {...register("contact_phone")} />
          </Field>
          <Field label="Contact email" error={err("contact_email")} htmlFor="co-email" className="sm:col-span-2">
            <Input id="co-email" type="email" {...register("contact_email")} />
          </Field>
          <Field label="Notes" htmlFor="co-notes" className="sm:col-span-2">
            <Textarea id="co-notes" rows={2} {...register("notes")} />
          </Field>
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="company-form" disabled={create.isPending}>
            Save company
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- job opening

type JobValues = {
  company_id: string;
  job_title: string;
  employment_type: string;
  work_mode: string;
  location: string;
  branch_id: string;
  required_skills: string;
  salary_ctc: string;
  openings_count: string;
  closing_date: string;
  source: string;
  status: string;
  placement_owner_id: string;
};

export function JobDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const companies = useQuery({ queryKey: placementKeys.companies(), queryFn: () => placementApi.companies() });
  const empty: JobValues = {
    company_id: "",
    job_title: "",
    employment_type: "Full-time",
    work_mode: "On-site",
    location: "",
    branch_id: "",
    required_skills: "",
    salary_ctc: "",
    openings_count: "",
    closing_date: "",
    source: "",
    status: "Review Required",
    placement_owner_id: "",
  };
  const form = useForm<JobValues>({ defaultValues: empty });
  const { register, handleSubmit, formState, reset, watch } = form;
  const branch = watch("branch_id");
  useEffect(() => {
    if (open) reset(empty);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const create = useApiMutation(placementApi.createJob, {
    success: (j) => `${j.job_code} created`,
    invalidate,
    silentValidation: true,
    onSuccess: () => onOpenChange(false),
    onError: (e) => applyServerErrors(form, e),
  });
  const submit = handleSubmit((v) => {
    const body: JobInput = {
      company_id: Number(v.company_id),
      job_title: v.job_title.trim(),
      employment_type: v.employment_type,
      work_mode: v.work_mode,
      status: v.status,
      location: v.location.trim() || null,
      branch_id: v.branch_id ? Number(v.branch_id) : null,
      required_skills: v.required_skills.trim() || null,
      salary_ctc: v.salary_ctc.trim() || null,
      openings_count: v.openings_count ? Number(v.openings_count) : null,
      closing_date: v.closing_date || null,
      source: v.source.trim() || null,
      placement_owner_id: v.placement_owner_id ? Number(v.placement_owner_id) : null,
    };
    create.mutate(body);
  });
  const err = (n: keyof JobValues) => formState.errors[n]?.message;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] w-[calc(100vw-1.5rem)] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New job opening</DialogTitle>
          <DialogDescription>Opening a job records it as verified now. Students can only apply to Open jobs.</DialogDescription>
        </DialogHeader>
        <form id="job-form" onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
          <Field label="Company" error={err("company_id")} htmlFor="job-company">
            <NativeSelect
              id="job-company"
              placeholder="Select company…"
              options={(companies.data ?? []).filter((c) => c.is_active).map((c) => ({ value: c.company_id, label: c.company_name }))}
              {...register("company_id", { required: "Required" })}
            />
          </Field>
          <Field label="Job title" error={err("job_title")} htmlFor="job-title">
            <Input id="job-title" {...register("job_title", { required: "Required" })} />
          </Field>
          <Field label="Employment type" error={err("employment_type")} htmlFor="job-type">
            <NativeSelect id="job-type" options={opts(EMPLOYMENT_TYPES)} {...register("employment_type")} />
          </Field>
          <Field label="Work mode" error={err("work_mode")} htmlFor="job-mode">
            <NativeSelect id="job-mode" options={opts(WORK_MODES)} {...register("work_mode")} />
          </Field>
          <Field label="Location" error={err("location")} htmlFor="job-location">
            <Input id="job-location" {...register("location")} />
          </Field>
          <Field label="Branch (optional)" error={err("branch_id")} htmlFor="job-branch">
            <BranchSelect id="job-branch" placeholder="All branches" {...register("branch_id")} />
          </Field>
          <Field label="Required skills" error={err("required_skills")} htmlFor="job-skills" className="sm:col-span-2">
            <Input id="job-skills" {...register("required_skills")} />
          </Field>
          <Field label="Salary / CTC" error={err("salary_ctc")} htmlFor="job-ctc" hint="e.g. 3–4 LPA or Not Disclosed">
            <Input id="job-ctc" {...register("salary_ctc")} />
          </Field>
          <Field label="Openings" error={err("openings_count")} htmlFor="job-openings">
            <Input id="job-openings" type="number" min={1} {...register("openings_count")} />
          </Field>
          <Field label="Closing date" error={err("closing_date")} htmlFor="job-closing">
            <Input id="job-closing" type="date" {...register("closing_date")} />
          </Field>
          <Field label="Source" error={err("source")} htmlFor="job-source">
            <Input id="job-source" {...register("source")} />
          </Field>
          <Field label="Status" error={err("status")} htmlFor="job-status">
            <NativeSelect id="job-status" options={opts(JOB_STATUSES)} {...register("status")} />
          </Field>
          <Field label="Placement owner" error={err("placement_owner_id")} htmlFor="job-owner">
            <StaffSelect id="job-owner" branchId={branch ? Number(branch) : undefined} roles={["PLACEMENT"]} placeholder="Placement team" {...register("placement_owner_id")} />
          </Field>
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="job-form" disabled={create.isPending}>
            Save job opening
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- placement profile

type ProfileValues = {
  readiness: string;
  cv_file_path: string;
  cv_review_status: string;
  skills: string;
  projects: string;
  qualification: string;
  career_gap_notes: string;
  expected_salary: string;
  preferred_location: string;
  preferred_mode: string;
  preferred_role: string;
  evidence_status: string;
};

const toValues = (p: PlacementProfile | null): ProfileValues => ({
  readiness: p?.readiness ?? "Not Yet Assessed",
  cv_file_path: p?.cv_file_path ?? "",
  cv_review_status: p?.cv_review_status ?? "No CV",
  skills: p?.skills ?? "",
  projects: p?.projects ?? "",
  qualification: p?.qualification ?? "",
  career_gap_notes: p?.career_gap_notes ?? "",
  expected_salary: p?.expected_salary ?? "",
  preferred_location: p?.preferred_location ?? "",
  preferred_mode: p?.preferred_mode ?? "",
  preferred_role: p?.preferred_role ?? "",
  evidence_status: p?.evidence_status ?? "Student Reported",
});

export function ProfileDialog({ person, onClose }: { person: { person_id: number; full_name: string; person_code: string } | null; onClose: () => void }) {
  const personId = person?.person_id ?? 0;
  const profile = useQuery({ queryKey: placementKeys.profile(personId), queryFn: () => placementApi.profile(personId), enabled: person !== null });
  return (
    <Dialog open={person !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] w-[calc(100vw-1.5rem)] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Placement profile · {person?.full_name}</DialogTitle>
          <DialogDescription>{person?.person_code} · Career assistance only — no guaranteed placement. Student-reported details stay marked until verified.</DialogDescription>
        </DialogHeader>
        {profile.isLoading ? (
          <LoadingRows rows={6} />
        ) : profile.error ? (
          <ErrorPanel error={profile.error} onRetry={() => void profile.refetch()} />
        ) : (
          <ProfileBody personId={personId} profile={profile.data ?? null} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function ProfileBody({ personId, profile }: { personId: number; profile: PlacementProfile | null }) {
  const form = useForm<ProfileValues>({ defaultValues: toValues(profile) });
  const { register, handleSubmit, formState, reset } = form;
  useEffect(() => reset(toValues(profile)), [profile, reset]);
  const save = useApiMutation((body: ProfileInput) => placementApi.saveProfile(personId, body), {
    success: "Placement profile saved",
    invalidate,
    silentValidation: true,
    onError: (e) => applyServerErrors(form, e),
  });
  const consent = useApiMutation((status: "Explicit Consent" | "Withdrawn") => placementApi.consent(profile!.profile_id, status), {
    success: (p) => (p.consent_status === "Withdrawn" ? "Consent withdrawn" : "Explicit referral consent recorded"),
    invalidate,
  });
  const submit = handleSubmit((v) => {
    const body: ProfileInput = {
      readiness: v.readiness,
      cv_review_status: v.cv_review_status,
      evidence_status: v.evidence_status,
      preferred_mode: v.preferred_mode || null,
    };
    for (const key of ["cv_file_path", "skills", "projects", "qualification", "career_gap_notes", "expected_salary", "preferred_location", "preferred_role"] as const) {
      body[key] = v[key].trim() || null;
    }
    save.mutate(body);
  });
  const err = (n: keyof ProfileValues) => formState.errors[n]?.message;

  return (
    <div className="space-y-5">
      {profile && (
        <div className="rounded-md border p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm">
              <b>Referral consent:</b> <Status kind={profile.consent_status === "Explicit Consent" ? "good" : profile.consent_status === "Withdrawn" ? "danger" : "neutral"}>{profile.consent_status}</Status>
              {profile.consent_recorded_at && <span className="ml-2 text-xs text-muted-foreground">recorded {dateTime(profile.consent_recorded_at)}</span>}
            </div>
            <div className="flex gap-2">
              {profile.consent_status !== "Explicit Consent" && (
                <ConfirmAction
                  trigger={<Button size="sm">Record explicit consent</Button>}
                  title="Record explicit referral consent?"
                  description="Confirm the student explicitly agreed to be referred to employers. This is audited."
                  action="Record consent"
                  onConfirm={() => consent.mutateAsync("Explicit Consent")}
                />
              )}
              {profile.consent_status === "Explicit Consent" && (
                <ConfirmAction
                  trigger={
                    <Button size="sm" variant="outline">
                      Withdraw consent
                    </Button>
                  }
                  title="Withdraw referral consent?"
                  description="No new applications can be made without explicit consent."
                  action="Withdraw"
                  destructive
                  onConfirm={() => consent.mutateAsync("Withdrawn")}
                />
              )}
            </div>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">Applications need explicit referral consent and an Open job. CV version: {profile.cv_version ? `v${profile.cv_version}` : "none"}.</p>
        </div>
      )}
      {!profile && <Warning>No placement profile yet — save the form below to create one, then record consent.</Warning>}
      <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
        <Field label="Readiness" error={err("readiness")} htmlFor="pp-readiness">
          <NativeSelect id="pp-readiness" options={opts(PLACEMENT_READINESS)} {...register("readiness")} />
        </Field>
        <Field label="Evidence state" error={err("evidence_status")} htmlFor="pp-evidence">
          <NativeSelect id="pp-evidence" options={opts(EVIDENCE_STATUSES)} {...register("evidence_status")} />
        </Field>
        <Field label="CV file / link" error={err("cv_file_path")} htmlFor="pp-cv" hint="A new CV bumps the version and sets review to pending">
          <Input id="pp-cv" {...register("cv_file_path")} />
        </Field>
        <Field label="CV review" error={err("cv_review_status")} htmlFor="pp-cv-review">
          <NativeSelect id="pp-cv-review" options={opts(CV_REVIEW_STATUSES)} {...register("cv_review_status")} />
        </Field>
        <Field label="Skills" error={err("skills")} htmlFor="pp-skills">
          <Input id="pp-skills" {...register("skills")} />
        </Field>
        <Field label="Qualification" error={err("qualification")} htmlFor="pp-qual">
          <Input id="pp-qual" {...register("qualification")} />
        </Field>
        <Field label="Projects" error={err("projects")} htmlFor="pp-projects" className="sm:col-span-2">
          <Textarea id="pp-projects" rows={2} {...register("projects")} />
        </Field>
        <Field label="Career gap notes (optional)" error={err("career_gap_notes")} htmlFor="pp-gap">
          <Input id="pp-gap" {...register("career_gap_notes")} />
        </Field>
        <Field label="Expected salary (optional)" error={err("expected_salary")} htmlFor="pp-salary">
          <Input id="pp-salary" {...register("expected_salary")} />
        </Field>
        <Field label="Preferred location" error={err("preferred_location")} htmlFor="pp-loc">
          <Input id="pp-loc" {...register("preferred_location")} />
        </Field>
        <Field label="Preferred mode" error={err("preferred_mode")} htmlFor="pp-mode">
          <NativeSelect id="pp-mode" placeholder="No preference" options={opts(WORK_MODES)} {...register("preferred_mode")} />
        </Field>
        <Field label="Preferred role" error={err("preferred_role")} htmlFor="pp-role">
          <Input id="pp-role" {...register("preferred_role")} />
        </Field>
        <div className="flex items-end">
          <Button type="submit" disabled={save.isPending}>
            Save profile
          </Button>
        </div>
      </form>
      {profile && <ProfileApplications profile={profile} />}
    </div>
  );
}

function ProfileApplications({ profile }: { profile: PlacementProfile }) {
  const [jobId, setJobId] = useState("");
  const [notes, setNotes] = useState("");
  const apps = useQuery({ queryKey: placementKeys.applications({ profile_id: profile.profile_id }), queryFn: () => placementApi.applications({ profile_id: profile.profile_id }) });
  const jobs = useQuery({ queryKey: placementKeys.jobs({ status: "Open", per_page: 100 }), queryFn: () => placementApi.jobs({ status: "Open", per_page: 100 }) });
  const applied = new Set((apps.data ?? []).map((a) => a.job_opening_id));
  const apply = useApiMutation(() => placementApi.apply({ profile_id: profile.profile_id, job_opening_id: Number(jobId), notes: notes.trim() || null }), {
    success: (a) => `Applied to ${a.job_title}`,
    invalidate,
    onSuccess: () => {
      setJobId("");
      setNotes("");
    },
  });
  return (
    <div className="space-y-3 border-t pt-4">
      <h3 className="text-sm font-semibold">Applications</h3>
      <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <Field label="Job opening" htmlFor="pa-job">
          <NativeSelect
            id="pa-job"
            value={jobId}
            placeholder="Select an open job…"
            options={(jobs.data?.data ?? []).filter((j) => !applied.has(j.job_opening_id)).map((j) => ({ value: j.job_opening_id, label: `${j.job_code} · ${j.job_title} · ${j.company_name}` }))}
            onChange={(e) => setJobId(e.target.value)}
          />
        </Field>
        <Field label="Application notes" htmlFor="pa-notes">
          <Input id="pa-notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        <Button disabled={!jobId || apply.isPending || profile.consent_status !== "Explicit Consent"} onClick={() => apply.mutate()}>
          Apply
        </Button>
      </div>
      {profile.consent_status !== "Explicit Consent" && <p className="text-xs text-muted-foreground">Record explicit referral consent before applying.</p>}
      <ApplicationsTable query={apps} showStudent={false} />
    </div>
  );
}

// ---------------------------------------------------------------- applications

export function ApplicationsTable({
  query,
  showStudent = true,
}: {
  query: { data: JobApplication[] | undefined; isLoading: boolean; error: unknown; refetch: () => unknown };
  showStudent?: boolean;
}) {
  const [stageFor, setStageFor] = useState<JobApplication | null>(null);
  const [eventFor, setEventFor] = useState<JobApplication | null>(null);
  const [historyFor, setHistoryFor] = useState<JobApplication | null>(null);
  return (
    <>
      <DataTable
        rows={query.data}
        loading={query.isLoading}
        error={query.error}
        onRetry={() => void query.refetch()}
        rowKey={(a) => a.application_id}
        empty={<p className="text-sm text-muted-foreground">No applications yet.</p>}
        columns={[
          ...(showStudent ? [{ header: "Student", cell: (a: JobApplication) => a.person.full_name }] : []),
          { header: "Job", cell: (a) => `${a.job_code} · ${a.job_title}` },
          { header: "Stage", cell: (a) => <Status>{a.stage}</Status> },
          { header: "Interview", cell: (a) => dateTime(a.interview_at) },
          { header: "Offer / joined", cell: (a) => [a.offer_ctc, a.joined_date ? `Joined ${date(a.joined_date)}` : null].filter(Boolean).join(" · ") || "—" },
          { header: "Evidence", cell: (a) => <Status>{a.evidence_status}</Status> },
          {
            header: "Actions",
            cell: (a) => (
              <div className="flex gap-1">
                {!CLOSED_STAGES.includes(a.stage) && (
                  <Button size="sm" variant="outline" onClick={() => setStageFor(a)}>
                    Change stage
                  </Button>
                )}
                <Button size="sm" variant="outline" onClick={() => setEventFor(a)}>
                  Add event
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setHistoryFor(a)}>
                  History ({a.events.length})
                </Button>
              </div>
            ),
          },
        ]}
      />
      <StageDialog app={stageFor} onClose={() => setStageFor(null)} />
      <EventDialog app={eventFor} onClose={() => setEventFor(null)} />
      <Dialog open={historyFor !== null} onOpenChange={(o) => !o && setHistoryFor(null)}>
        <DialogContent className="max-h-[90vh] w-[calc(100vw-1.5rem)] max-w-lg overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Application history</DialogTitle>
            <DialogDescription>
              {historyFor?.person.full_name} · {historyFor?.job_title}
            </DialogDescription>
          </DialogHeader>
          <ol className="space-y-2 text-sm">
            {(historyFor?.events ?? []).map((e) => (
              <li key={e.event_id} className="rounded-md border p-2">
                <b>{e.event_type}</b>
                {e.from_stage || e.to_stage ? ` · ${e.from_stage ?? "—"} → ${e.to_stage ?? "—"}` : ""}
                <span className="block text-xs text-muted-foreground">{dateTime(e.occurred_at)}</span>
                {e.notes && <span className="block">{e.notes}</span>}
              </li>
            ))}
            {historyFor && historyFor.events.length === 0 && <li className="text-muted-foreground">No events yet.</li>}
          </ol>
        </DialogContent>
      </Dialog>
    </>
  );
}

function StageDialog({ app, onClose }: { app: JobApplication | null; onClose: () => void }) {
  const [stage, setStage] = useState("");
  const [interview, setInterview] = useState("");
  const [ctc, setCtc] = useState("");
  const [joined, setJoined] = useState("");
  const [evidence, setEvidence] = useState("");
  const [notes, setNotes] = useState("");
  useEffect(() => {
    if (app) {
      setStage("");
      setInterview("");
      setCtc(app.offer_ctc ?? "");
      setJoined("");
      setEvidence(app.evidence_status);
      setNotes("");
    }
  }, [app]);
  const change = useApiMutation(
    () =>
      placementApi.changeStage(app!.application_id, {
        stage,
        ...(interview ? { interview_at: fromLocalInput(interview) } : {}),
        ...(ctc.trim() ? { offer_ctc: ctc.trim() } : {}),
        ...(joined ? { joined_date: joined } : {}),
        evidence_status: evidence,
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      }),
    { success: (a) => `Stage changed to ${a.stage}`, invalidate, onSuccess: onClose },
  );
  return (
    <Dialog open={app !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] w-[calc(100vw-1.5rem)] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Change application stage</DialogTitle>
          <DialogDescription>
            {app?.person.full_name} · {app?.job_title} · currently {app?.stage}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="New stage" htmlFor="st-stage">
            <NativeSelect id="st-stage" value={stage} placeholder="Select stage…" options={opts(APPLICATION_STAGES.filter((s) => s !== app?.stage))} onChange={(e) => setStage(e.target.value)} />
          </Field>
          <Field label="Evidence state" htmlFor="st-evidence">
            <NativeSelect id="st-evidence" value={evidence} options={opts(EVIDENCE_STATUSES)} onChange={(e) => setEvidence(e.target.value)} />
          </Field>
          {stage === "Interview Scheduled" && (
            <Field label="Interview at" htmlFor="st-interview">
              <Input id="st-interview" type="datetime-local" value={interview} onChange={(e) => setInterview(e.target.value)} />
            </Field>
          )}
          {["Offer Received", "Offer Accepted", "Joined", "Selected"].includes(stage) && (
            <Field label="Offer CTC" htmlFor="st-ctc">
              <Input id="st-ctc" value={ctc} onChange={(e) => setCtc(e.target.value)} />
            </Field>
          )}
          {stage === "Joined" && (
            <Field label="Joined date" htmlFor="st-joined">
              <Input id="st-joined" type="date" value={joined} onChange={(e) => setJoined(e.target.value)} />
            </Field>
          )}
          <Field label="Notes" htmlFor="st-notes" className="sm:col-span-2">
            <Textarea id="st-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!stage || (stage === "Joined" && !joined) || change.isPending} onClick={() => change.mutate()}>
            Save stage
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EventDialog({ app, onClose }: { app: JobApplication | null; onClose: () => void }) {
  const [type, setType] = useState("Note");
  const [interview, setInterview] = useState("");
  const [notes, setNotes] = useState("");
  useEffect(() => {
    if (app) {
      setType("Note");
      setInterview("");
      setNotes("");
    }
  }, [app]);
  const add = useApiMutation(
    () => placementApi.addEvent(app!.application_id, { event_type: type, interview_at: type === "Interview Scheduled" ? fromLocalInput(interview) : null, notes: notes.trim() || null }),
    { success: "Event recorded", invalidate, onSuccess: onClose },
  );
  return (
    <Dialog open={app !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="w-[calc(100vw-1.5rem)] max-w-lg">
        <DialogHeader>
          <DialogTitle>Add application event</DialogTitle>
          <DialogDescription>A no-show is an interview event, not an automatic closure.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <Field label="Event type" htmlFor="ev-type">
            <NativeSelect id="ev-type" value={type} options={opts(APPLICATION_EVENT_TYPES)} onChange={(e) => setType(e.target.value)} />
          </Field>
          {type === "Interview Scheduled" && (
            <Field label="Interview at" htmlFor="ev-interview">
              <Input id="ev-interview" type="datetime-local" value={interview} onChange={(e) => setInterview(e.target.value)} />
            </Field>
          )}
          <Field label="Event notes" htmlFor="ev-notes">
            <Textarea id="ev-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={(type === "Interview Scheduled" && !interview) || add.isPending} onClick={() => add.mutate()}>
            Record event
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

