import { useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { FileUp, MessageCircle, Phone, Plus, PlusCircle } from "lucide-react";
import { ApiError } from "@/api/client";
import { useLookups } from "@/api/reference";
import {
  CERTIFICATE_DECISIONS,
  SUPPORT_CASE_STATUSES,
  studentKeys,
  studentsApi,
  useStudentTab,
  type Certificate,
  type PersonDetail,
  type Student,
  type SupportCase,
} from "@/api/students";
import { useAuth } from "@/auth/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Field, LookupSelect, NativeSelect } from "@/components/crm/forms";
import { ConfirmAction, DataTable, Empty, ErrorPanel, Facts, LoadingRows, Metric, PageHead, QueryView, Section, Status } from "@/components/crm/ui";
import { NewLeadDialog } from "@/features/leads/new-lead-dialog";
import { date, dateTime, money, phone, sumMoney } from "@/lib/format";
import { useApiMutation } from "@/lib/mutation";
import { useCan } from "./can";
import { FormDialog } from "./shared";

export function Student360({ personId }: { personId: number }) {
  const student = useQuery({ queryKey: studentKeys.detail(personId), queryFn: () => studentsApi.get(personId), retry: false });
  if (student.isLoading) return <LoadingRows rows={8} />;
  if (student.error instanceof ApiError && student.error.status === 404) return <PersonOnly personId={personId} />;
  if (student.error) return <ErrorPanel error={student.error} onRetry={() => void student.refetch()} />;
  return <StudentView s={student.data!} />;
}

function ContactActions({ p, onAdd }: { p: PersonDetail; onAdd?: () => void }) {
  const { hasRole } = useAuth();
  const digits = p.phone.replace(/\D/g, "");
  return (
    <>
      {onAdd && hasRole("FOUNDER_CEO", "SUPER_ADMIN", "BRANCH_MANAGER", "SALES", "FRONT_OFFICE") && (
        <Button onClick={onAdd}>
          <Plus />
          Add Another Course
        </Button>
      )}
      {hasRole("FOUNDER_CEO", "SUPER_ADMIN", "BRANCH_MANAGER", "SALES", "FRONT_OFFICE", "ACCOUNTS") && (
        <Button asChild variant="outline">
          <Link to="/payments">Record Payment</Link>
        </Button>
      )}
      <Button asChild variant="outline">
        <a href={`tel:+${digits}`}>
          <Phone />
          Call
        </a>
      </Button>
      <Button asChild variant="outline">
        <a href={`https://wa.me/${(p.whatsapp_number ?? p.phone).replace(/\D/g, "")}`} target="_blank" rel="noreferrer">
          <MessageCircle />
          WhatsApp
        </a>
      </Button>
    </>
  );
}

function PersonFacts({ p }: { p: PersonDetail }) {
  return (
    <Facts
      columns={3}
      items={[
        ["Person ID", p.person_code],
        ["Name", p.full_name],
        ["Mobile", phone(p.phone)],
        ["WhatsApp", p.whatsapp_number ? phone(p.whatsapp_number) : "Same as mobile"],
        ["Alternate mobile", phone(p.alternate_phone)],
        ["Email", p.email ?? "—"],
        ["City", p.city ?? "—"],
        ["Qualification", p.highest_qualification ?? "—"],
        ["Preferred language", p.preferred_language],
        ["Original branch", p.registered_branch.branch_name],
        ["Created", dateTime(p.created_at)],
        ["Identity", "One canonical Person / Student Master / LMS identity"],
      ]}
    />
  );
}

/** Leads for this person (matched by phone), when the viewer can see leads. */
function Opportunities({ p }: { p: PersonDetail }) {
  const { hasRole } = useAuth();
  const allowed = hasRole("FOUNDER_CEO", "SUPER_ADMIN", "BRANCH_MANAGER", "SALES", "FRONT_OFFICE");
  const leads = useQuery({ queryKey: ["leads", "person", p.person_id], queryFn: () => studentsApi.leadsByPhone(p.phone), enabled: allowed });
  if (!allowed) return <p className="text-sm text-muted-foreground">Enquiries are visible to the sales team.</p>;
  const rows = (leads.data?.data ?? []).filter((l) => l.phone.replace(/\D/g, "").endsWith(p.phone.replace(/\D/g, "").slice(-10)));
  return (
    <DataTable
      rows={leads.data ? rows : undefined}
      loading={leads.isLoading}
      error={leads.error}
      onRetry={() => void leads.refetch()}
      rowKey={(l) => l.lead_id}
      empty={<Empty title="No opportunities" />}
      columns={[
        {
          header: "Opportunity",
          cell: (l) => (
            <Link to="/leads/$leadId" params={{ leadId: String(l.lead_id) }} className="text-primary">
              {l.lead_code}
            </Link>
          ),
        },
        { header: "Course", cell: (l) => l.course?.course_title ?? "—" },
        { header: "Branch", cell: (l) => l.branch.branch_name },
        { header: "Stage", cell: (l) => <Status>{l.stage}</Status> },
        { header: "Owner", cell: (l) => l.owner?.full_name ?? "Unassigned" },
      ]}
    />
  );
}

/** A person with no admission (e.g. opened from Lead 360): person basics and their opportunities. */
function PersonOnly({ personId }: { personId: number }) {
  const person = useQuery({ queryKey: studentKeys.person(personId), queryFn: () => studentsApi.person(personId), retry: false });
  const [addOpen, setAddOpen] = useState(false);
  if (person.isLoading) return <LoadingRows rows={6} />;
  if (person.error)
    return (
      <>
        <PageHead title="Person not found" description="This person doesn't exist or is outside your branch scope." />
        <Empty>
          <Link to="/students" className="text-primary">
            Back to Students
          </Link>
        </Empty>
      </>
    );
  const p = person.data!;
  return (
    <>
      <PageHead title={p.full_name} description={`${p.person_code} · original branch ${p.registered_branch.branch_name} · no admission yet`} actions={<ContactActions p={p} onAdd={() => setAddOpen(true)} />} />
      <div className="space-y-4">
        <Section title="Person">
          <PersonFacts p={p} />
        </Section>
        <Section title="Enquiries / Opportunities" subtitle="Student records (admissions, finance, documents) appear after the first admission">
          <Opportunities p={p} />
        </Section>
      </div>
      <NewLeadDialog open={addOpen} onOpenChange={setAddOpen} person={{ ...p }} />
    </>
  );
}

function StudentView({ s }: { s: Student }) {
  const [addOpen, setAddOpen] = useState(false);
  const [tab, setTab] = useState("person");
  const p = s.person;
  const tabs: [string, string, ReactNode][] = [
    ["person", "Person", <PersonFacts p={p} />],
    ["opportunities", "Enquiries / Opportunities", <Opportunities p={p} />],
    ["admissions", "Admissions & Batches", <AdmissionsTab personId={s.person_id} />],
    ["finance", "Finance", <FinanceTab personId={s.person_id} />],
    ["academic", "Certificates", <AcademicTab personId={s.person_id} />],
    ["documents", "Documents", <DocumentsTab s={s} />],
    ["cases", "Support cases", <CasesTab s={s} />],
    ["placement", "Placement", <PlacementTab personId={s.person_id} />],
    ["timeline", "Timeline", <TimelineTab personId={s.person_id} />],
    ["audit", "Audit", <AuditTab personId={s.person_id} />],
  ];
  return (
    <>
      <PageHead
        title={s.full_name}
        description={`${s.person_code} · original branch ${s.registered_branch.branch_name}${s.is_alumni ? " · Alumni" : ""}${s.is_active ? " · Active" : ""}`}
        actions={<ContactActions p={p} onAdd={() => setAddOpen(true)} />}
      />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric label="Admissions" value={s.admissions} hint={s.admission_summaries.map((a) => a.admission_code).join(", ") || "None"} />
        <Metric label="Verified paid" value={money(s.verified_paid)} />
        <Metric label="Outstanding (verified basis)" value={money(s.outstanding)} />
        <Metric label="LMS" value={<span className="text-base">{s.lms_statuses.join(", ") || "—"}</span>} hint={s.active_courses.join(", ") || "No active course"} />
      </div>
      <div className="panel mt-4 overflow-x-auto">
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="min-w-max">
            {tabs.map(([key, label]) => (
              <TabsTrigger key={key} value={key}>
                {label}
              </TabsTrigger>
            ))}
          </TabsList>
          {tabs.map(([key, , content]) => (
            <TabsContent key={key} value={key}>
              <div className="mt-4">{tab === key && content}</div>
            </TabsContent>
          ))}
        </Tabs>
      </div>
      <NewLeadDialog open={addOpen} onOpenChange={setAddOpen} person={p} />
    </>
  );
}

// ---------------------------------------------------------------- tabs

function AdmissionsTab({ personId }: { personId: number }) {
  const admissions = useStudentTab(personId, "admissions");
  const academic = useStudentTab(personId, "academic");
  const allocationsOf = (id: number) => (academic.data?.allocations ?? []).filter((x) => x.admission_id === id);
  return (
    <QueryView query={admissions} empty={<Empty title="No admission yet" />}>
      {(rows) => (
        <DataTable
          rows={rows}
          rowKey={(a) => a.admission_id}
          columns={[
            {
              header: "Admission",
              cell: (a) => (
                <Link to="/admissions" search={{ admission: a.admission_id }} className="font-medium text-primary">
                  {a.admission_code}
                </Link>
              ),
            },
            { header: "Course", cell: (a) => <span className="block max-w-56 truncate">{a.course.course_title}</span> },
            { header: "Original / service", cell: (a) => `${a.original_branch.branch_code} / ${a.service_branch.branch_code}` },
            { header: "Accepted plan", cell: (a) => `${a.seat_type} · ${a.delivery_mode} · ${a.payment_plan?.plan_name ?? ""}` },
            { header: "Curriculum", cell: (a) => (a.curriculum_status === "Mapped" ? "Mapped" : <span>Curriculum Mapping Pending · recovery: Academic Coordinator ({a.service_branch.branch_code})</span>) },
            { header: "Enrolment", cell: (a) => <Status>{a.enrolment_status}</Status> },
            {
              header: "Batch",
              cell: (a) => {
                const active = allocationsOf(a.admission_id).filter((x) => x.status === "Active");
                return active.length
                  ? active.map((x) => (
                      <Link key={x.allocation_id} to="/batches/$batchId" params={{ batchId: String(x.batch_id) }} className="mr-2 text-primary">
                        {x.batch_code}
                      </Link>
                    ))
                  : "Awaiting allocation";
              },
            },
            { header: "Joining date", cell: (a) => date(allocationsOf(a.admission_id).find((x) => x.joining_date)?.joining_date) },
            { header: "Support until", cell: (a) => date(a.support_until) },
          ]}
        />
      )}
    </QueryView>
  );
}

function FinanceTab({ personId }: { personId: number }) {
  const finance = useStudentTab(personId, "finance");
  return (
    <QueryView query={finance} isEmpty={(d) => !d.invoices.length && !d.payments.length} empty={<Empty title="No invoices or payments" />}>
      {(d) => (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Metric label="Billed" value={money(sumMoney(d.invoices.map((i) => i.billed_amount)))} />
            <Metric label="Verified paid" value={money(sumMoney(d.invoices.map((i) => i.verified_paid)))} />
            <Metric label="Pending verification" value={money(sumMoney(d.invoices.map((i) => i.pending_verification)))} />
            <Metric label="Outstanding" value={money(sumMoney(d.balances.map((b) => b.outstanding)))} />
          </div>
          <h3 className="text-sm font-semibold">Invoices</h3>
          <DataTable
            rows={d.invoices}
            rowKey={(i) => i.invoice_id}
            empty={<Empty title="No invoices" />}
            columns={[
              {
                header: "Invoice",
                cell: (i) => (
                  <Link to="/invoices/$invoiceId" params={{ invoiceId: String(i.invoice_id) }} className="text-primary">
                    {i.invoice_number}
                  </Link>
                ),
              },
              { header: "Courses", cell: (i) => i.courses.map((c) => c.course.course_title).join(", ") },
              { header: "Admitted", cell: (i) => `${i.admitted_lines} of ${i.courses.length}` },
              { header: "Billed", cell: (i) => money(i.billed_amount) },
              { header: "Verified paid", cell: (i) => money(i.verified_paid) },
              { header: "Pending verification", cell: (i) => money(i.pending_verification) },
              { header: "Outstanding", cell: (i) => money(i.outstanding) },
              { header: "Due position", cell: (i) => <Status>{i.invoice_state}</Status> },
            ]}
          />
          <h3 className="text-sm font-semibold">Payments</h3>
          <DataTable
            rows={d.payments}
            rowKey={(x) => x.payment_id}
            empty={<Empty title="No payments" />}
            columns={[
              { header: "Transaction / receipt", cell: (x) => <span>{x.transaction_number}<small className="block text-muted-foreground">{x.receipt_number ?? "No receipt until verified"}</small></span> },
              { header: "Date", cell: (x) => date(x.payment_date) },
              { header: "Type", cell: (x) => x.entry_type },
              { header: "Amount", cell: (x) => money(x.amount) },
              { header: "Mode", cell: (x) => x.mode },
              { header: "Reference", cell: (x) => x.reference ?? "—" },
              { header: "Invoice", cell: (x) => x.invoice?.invoice_number ?? "Unallocated" },
              { header: "Verification", cell: (x) => <Status>{x.verification_status}</Status> },
            ]}
          />
        </div>
      )}
    </QueryView>
  );
}

function AcademicTab({ personId }: { personId: number }) {
  const academic = useStudentTab(personId, "academic");
  const admissions = useStudentTab(personId, "admissions");
  const can = useCan();
  const [form, setForm] = useState({ admission_id: "", status: "Eligibility Pending", eligibility_notes: "" });
  const [edit, setEdit] = useState({ status: "", eligibility_notes: "" });
  const invalidate = [studentKeys.tab(personId, "academic"), studentKeys.tab(personId, "audit")];
  const create = useApiMutation(
    () => studentsApi.createCertificate(Number(form.admission_id), { status: form.status, eligibility_notes: form.eligibility_notes || null }),
    { success: "Certificate record created", invalidate },
  );
  const update = useApiMutation((id: number) => studentsApi.updateCertificate(id, { status: edit.status, eligibility_notes: edit.eligibility_notes || null }), {
    success: "Certificate updated",
    invalidate,
  });
  const issue = useApiMutation(studentsApi.issueCertificate, { success: (c) => `Certificate ${c.certificate_number ?? ""} issued`, invalidate });
  const revoke = useApiMutation((v: { id: number; reason: string }) => studentsApi.revokeCertificate(v.id, v.reason), { success: "Certificate revoked", invalidate });
  const serviceOf = (admissionId: number) => admissions.data?.find((a) => a.admission_id === admissionId)?.service_branch.branch_id;
  const manageable = (admissions.data ?? []).filter((a) => can.coordinator(a.service_branch.branch_id));

  const certActions = (c: Certificate) => {
    const allowed = can.coordinator(serviceOf(c.admission_id));
    return (
      <div className="flex gap-1">
        {allowed && ["Eligibility Pending", "Eligible", "Not Eligible"].includes(c.status) && (
          <FormDialog
            title="Update certificate eligibility"
            onOpen={() => setEdit({ status: c.status, eligibility_notes: c.eligibility_notes ?? "" })}
            onSubmit={() => update.mutateAsync(c.certificate_id)}
            trigger={
              <Button size="sm" variant="outline">
                Update
              </Button>
            }
          >
            <Field label="Eligibility" htmlFor={`ce-${c.certificate_id}`}>
              <NativeSelect id={`ce-${c.certificate_id}`} value={edit.status} options={CERTIFICATE_DECISIONS.map((x) => ({ value: x, label: x }))} onChange={(e) => setEdit({ ...edit, status: e.target.value })} />
            </Field>
            <Field label="Eligibility notes" htmlFor={`cn-${c.certificate_id}`}>
              <Textarea id={`cn-${c.certificate_id}`} value={edit.eligibility_notes} onChange={(e) => setEdit({ ...edit, eligibility_notes: e.target.value })} />
            </Field>
          </FormDialog>
        )}
        {allowed && c.status === "Eligible" && (
          <ConfirmAction title="Issue certificate?" description="A certificate number is assigned on issue." action="Issue" onConfirm={() => issue.mutateAsync(c.certificate_id)} trigger={<Button size="sm">Issue</Button>} />
        )}
        {can.isAdmin && !can.lmsOwned && c.status === "Issued" && (
          <ConfirmAction
            title="Revoke certificate?"
            action="Revoke"
            destructive
            reason
            onConfirm={(reason) => revoke.mutateAsync({ id: c.certificate_id, reason })}
            trigger={
              <Button size="sm" variant="ghost" className="text-destructive">
                Revoke
              </Button>
            }
          />
        )}
      </div>
    );
  };

  return (
    <QueryView query={academic} isEmpty={() => false}>
      {(d) => (
        <div className="space-y-4">
          <Section
            title="Certificates"
            subtitle={can.lmsOwned ? "From the LMS Certificate Register: a reissue keeps the number with a new version" : "Eligibility is decided by the Academic Coordinator; issue assigns the number"}
            action={
              manageable.length ? (
                <FormDialog
                  title="Start certificate record"
                  disabled={!form.admission_id}
                  onOpen={() => setForm({ admission_id: manageable.length === 1 ? String(manageable[0]!.admission_id) : "", status: "Eligibility Pending", eligibility_notes: "" })}
                  onSubmit={() => create.mutateAsync(undefined)}
                  trigger={
                    <Button size="sm" variant="outline">
                      <PlusCircle />
                      Certificate
                    </Button>
                  }
                >
                  <Field label="Admission" htmlFor="cc-adm">
                    <NativeSelect
                      id="cc-adm"
                      value={form.admission_id}
                      placeholder="Choose admission…"
                      options={manageable.map((a) => ({ value: a.admission_id, label: `${a.admission_code} · ${a.course.course_title}` }))}
                      onChange={(e) => setForm({ ...form, admission_id: e.target.value })}
                    />
                  </Field>
                  <Field label="Eligibility" htmlFor="cc-status">
                    <NativeSelect id="cc-status" value={form.status} options={CERTIFICATE_DECISIONS.map((x) => ({ value: x, label: x }))} onChange={(e) => setForm({ ...form, status: e.target.value })} />
                  </Field>
                  <Field label="Eligibility notes" htmlFor="cc-notes">
                    <Textarea id="cc-notes" value={form.eligibility_notes} onChange={(e) => setForm({ ...form, eligibility_notes: e.target.value })} />
                  </Field>
                </FormDialog>
              ) : undefined
            }
          >
            <DataTable
              rows={d.certificates}
              rowKey={(c) => c.certificate_id}
              empty={<p className="text-sm text-muted-foreground">No certificate records yet.</p>}
              columns={[
                { header: "Admission", cell: (c) => d.admissions.find((a) => a.admission_id === c.admission_id)?.admission_code ?? `#${c.admission_id}` },
                { header: "Course", cell: (c) => c.course.course_title },
                { header: "Status", cell: (c) => <Status>{c.status}</Status> },
                { header: "Number", cell: (c) => (c.certificate_number ? `${c.certificate_number}${c.lms_mirrored ? ` · v${c.version}` : ""}` : "—") },
                { header: "Type", cell: (c) => c.certificate_type ?? "—" },
                { header: "Notes", cell: (c) => <span className="block max-w-56 truncate">{c.revoke_reason ?? c.reissue_reason ?? c.eligibility_notes ?? "—"}</span> },
                { header: "Issued", cell: (c) => dateTime(c.issued_at) },
                { header: "", cell: certActions },
              ]}
            />
          </Section>
          <Section title="Curriculum mapping">
            <DataTable
              rows={d.curricula}
              rowKey={(c) => `${c.admission_id}-${c.curriculum_version_id}`}
              empty={<p className="text-sm text-muted-foreground">No curriculum mapped.</p>}
              columns={[
                { header: "Admission", cell: (c) => d.admissions.find((a) => a.admission_id === c.admission_id)?.admission_code ?? `#${c.admission_id}` },
                { header: "Course", cell: (c) => c.course.course_title },
                { header: "Version", cell: (c) => c.version_label },
                { header: "Mapped", cell: (c) => dateTime(c.mapped_at) },
              ]}
            />
          </Section>
        </div>
      )}
    </QueryView>
  );
}

function DocumentsTab({ s }: { s: Student }) {
  const docs = useStudentTab(s.person_id, "documents");
  const can = useCan();
  const lookups = useLookups();
  const [upload, setUpload] = useState<{ document_type_id: string; admission_id: string; file: File | null }>({ document_type_id: "", admission_id: "", file: null });
  const invalidate = [studentKeys.tab(s.person_id, "documents"), studentKeys.tab(s.person_id, "audit"), ["tasks"]];
  const doUpload = useApiMutation(
    () => studentsApi.uploadDocument(s.person_id, { document_type_id: Number(upload.document_type_id), admission_id: upload.admission_id ? Number(upload.admission_id) : null, file: upload.file! }),
    { success: "Document uploaded — review required", invalidate },
  );
  const verify = useApiMutation((id: number) => studentsApi.reviewDocument(id, { status: "Verified" }), { success: "Document verified", invalidate });
  const reject = useApiMutation((v: { id: number; reason: string }) => studentsApi.reviewDocument(v.id, { status: "Rejected", rejection_reason: v.reason }), {
    success: "Document rejected",
    invalidate,
  });
  const reg = s.registered_branch.branch_id;
  const canReview = can.isAdmin || can.at(reg, "BRANCH_MANAGER", "ACADEMIC_COORDINATOR", "FRONT_OFFICE");
  const typeLabel = (id: number) => lookups.data?.document_types.find((t) => t.id === id);

  return (
    <QueryView query={docs} isEmpty={() => false}>
      {(d) => (
        <div className="space-y-4">
          <Section
            title="Document checklist"
            subtitle="Mandatory documents for admitted learners"
            action={
              <FormDialog
                title="Upload document"
                description="One live file per document type; re-upload only after a rejection."
                disabled={!upload.document_type_id || !upload.file}
                onOpen={() => setUpload({ document_type_id: "", admission_id: "", file: null })}
                onSubmit={() => doUpload.mutateAsync(undefined)}
                submitLabel="Upload"
                trigger={
                  <Button size="sm" variant="outline">
                    <FileUp />
                    Upload document
                  </Button>
                }
              >
                <Field label="Document type" htmlFor="doc-type">
                  <LookupSelect id="doc-type" lookup="document_types" value={upload.document_type_id} onChange={(e) => setUpload({ ...upload, document_type_id: e.target.value })} />
                </Field>
                <Field label="Admission (optional)" htmlFor="doc-adm">
                  <NativeSelect
                    id="doc-adm"
                    value={upload.admission_id}
                    placeholder="Person-level document"
                    options={s.admission_summaries.map((a) => ({ value: a.admission_id, label: `${a.admission_code} · ${a.course.course_title}` }))}
                    onChange={(e) => setUpload({ ...upload, admission_id: e.target.value })}
                  />
                </Field>
                <Field label="File" htmlFor="doc-file" hint="PDF or image">
                  <Input id="doc-file" type="file" accept=".pdf,image/*" onChange={(e) => setUpload({ ...upload, file: e.target.files?.[0] ?? null })} />
                </Field>
              </FormDialog>
            }
          >
            <DataTable
              rows={d.checklist}
              rowKey={(c) => c.document_type_id}
              empty={<p className="text-sm text-muted-foreground">No mandatory documents configured.</p>}
              columns={[
                { header: "Document", cell: (c) => c.document_type },
                { header: "Status", cell: (c) => <Status>{c.status}</Status> },
                { header: "Uploaded", cell: (c) => dateTime(c.uploaded_at) },
              ]}
            />
          </Section>
          <Section title="Documents">
            <DataTable
              rows={d.documents}
              rowKey={(x) => x.document_id}
              empty={<p className="text-sm text-muted-foreground">No documents uploaded.</p>}
              columns={[
                { header: "Type", cell: (x) => `${x.document_type.label}${x.document_type.is_mandatory || typeLabel(x.document_type.document_type_id)?.is_mandatory ? " · mandatory" : ""}` },
                { header: "File", cell: (x) => <span className="block max-w-48 truncate">{x.original_filename ?? "—"}</span> },
                { header: "Admission", cell: (x) => s.admission_summaries.find((a) => a.admission_id === x.admission_id)?.admission_code ?? "—" },
                { header: "Status", cell: (x) => <Status>{x.status}</Status> },
                { header: "Uploaded", cell: (x) => dateTime(x.uploaded_at) },
                { header: "Review", cell: (x) => (x.rejection_reason ? `Rejected: ${x.rejection_reason}` : x.reviewed_at ? dateTime(x.reviewed_at) : "—") },
                {
                  header: "",
                  cell: (x) =>
                    x.status === "Review Required" && canReview && x.uploaded_by !== can.userId ? (
                      <div className="flex gap-1">
                        <ConfirmAction title={`Verify ${x.document_type.label}?`} action="Verify" onConfirm={() => verify.mutateAsync(x.document_id)} trigger={<Button size="sm">Verify</Button>} />
                        <ConfirmAction
                          title={`Reject ${x.document_type.label}?`}
                          action="Reject"
                          destructive
                          reason
                          reasonLabel="Rejection reason"
                          onConfirm={(reason) => reject.mutateAsync({ id: x.document_id, reason })}
                          trigger={
                            <Button size="sm" variant="outline">
                              Reject
                            </Button>
                          }
                        />
                      </div>
                    ) : x.status === "Review Required" && x.uploaded_by === can.userId ? (
                      <small className="text-muted-foreground">Another reviewer must verify</small>
                    ) : null,
                },
              ]}
            />
          </Section>
        </div>
      )}
    </QueryView>
  );
}

function CasesTab({ s }: { s: Student }) {
  const cases = useStudentTab(s.person_id, "cases");
  const [form, setForm] = useState({ support_case_type_id: "", admission_id: "", subject: "", description: "" });
  const [edit, setEdit] = useState({ status: "", resolution_notes: "" });
  const invalidate = [studentKeys.tab(s.person_id, "cases"), studentKeys.tab(s.person_id, "timeline"), ["support-cases"]];
  const create = useApiMutation(
    () =>
      studentsApi.createCase({
        person_id: s.person_id,
        admission_id: form.admission_id ? Number(form.admission_id) : null,
        support_case_type_id: Number(form.support_case_type_id),
        subject: form.subject.trim(),
        description: form.description.trim() || null,
      }),
    { success: (c) => `Support case ${c.case_code} opened`, invalidate },
  );
  const update = useApiMutation((id: number) => studentsApi.updateCase(id, { status: edit.status, ...(edit.resolution_notes ? { resolution_notes: edit.resolution_notes } : {}) }), {
    success: "Support case updated",
    invalidate,
  });
  const caseActions = (c: SupportCase) =>
    ["Resolved", "Closed"].includes(c.status) ? null : (
      <FormDialog
        title={`Update ${c.case_code}`}
        onOpen={() => setEdit({ status: c.status, resolution_notes: c.resolution_notes ?? "" })}
        onSubmit={() => update.mutateAsync(c.support_case_id)}
        trigger={
          <Button size="sm" variant="outline">
            Update
          </Button>
        }
      >
        <Field label="Case status" htmlFor={`cs-${c.support_case_id}`}>
          <NativeSelect id={`cs-${c.support_case_id}`} value={edit.status} options={SUPPORT_CASE_STATUSES.map((x) => ({ value: x, label: x }))} onChange={(e) => setEdit({ ...edit, status: e.target.value })} />
        </Field>
        <Field label="Resolution notes" htmlFor={`cr-${c.support_case_id}`} hint="Required to resolve">
          <Textarea id={`cr-${c.support_case_id}`} value={edit.resolution_notes} onChange={(e) => setEdit({ ...edit, resolution_notes: e.target.value })} />
        </Field>
      </FormDialog>
    );

  return (
    <QueryView query={cases} isEmpty={() => false}>
      {(d) => (
        <div className="space-y-4">
          <Section
            title="Support cases"
            action={
              <FormDialog
                title="Open support case"
                disabled={!form.support_case_type_id || !form.subject.trim()}
                onOpen={() => setForm({ support_case_type_id: "", admission_id: "", subject: "", description: "" })}
                onSubmit={() => create.mutateAsync(undefined)}
                submitLabel="Open case"
                trigger={
                  <Button size="sm" variant="outline">
                    <PlusCircle />
                    Support case
                  </Button>
                }
              >
                <Field label="Case type" htmlFor="sc-type">
                  <LookupSelect id="sc-type" lookup="support_case_types" value={form.support_case_type_id} onChange={(e) => setForm({ ...form, support_case_type_id: e.target.value })} />
                </Field>
                <Field label="Admission (optional)" htmlFor="sc-adm">
                  <NativeSelect
                    id="sc-adm"
                    value={form.admission_id}
                    placeholder="Not admission-specific"
                    options={s.admission_summaries.map((a) => ({ value: a.admission_id, label: `${a.admission_code} · ${a.course.course_title}` }))}
                    onChange={(e) => setForm({ ...form, admission_id: e.target.value })}
                  />
                </Field>
                <Field label="Subject" htmlFor="sc-subject">
                  <Input id="sc-subject" value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} />
                </Field>
                <Field label="Description" htmlFor="sc-desc">
                  <Textarea id="sc-desc" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
                </Field>
              </FormDialog>
            }
          >
            <DataTable
              rows={d.support_cases}
              rowKey={(c) => c.support_case_id}
              empty={<p className="text-sm text-muted-foreground">No support cases.</p>}
              columns={[
                { header: "Case", cell: (c) => c.case_code },
                { header: "Type", cell: (c) => c.case_type },
                { header: "Subject", cell: (c) => <span className="block max-w-56 truncate" title={c.subject}>{c.subject}</span> },
                { header: "Branch", cell: (c) => c.branch.branch_name },
                { header: "Status", cell: (c) => <Status>{c.status}</Status> },
                { header: "Owner", cell: (c) => c.owner?.full_name ?? "—" },
                { header: "Opened", cell: (c) => dateTime(c.opened_at) },
                { header: "Resolution", cell: (c) => <span className="block max-w-48 truncate">{c.resolution_notes ?? "—"}</span> },
                { header: "", cell: caseActions },
              ]}
            />
          </Section>
          <Section title="Refund cases">
            <DataTable
              rows={d.refund_cases}
              rowKey={(r) => r.refund_case_id}
              empty={<p className="text-sm text-muted-foreground">No refund cases.</p>}
              columns={[
                { header: "Case", cell: (r) => r.case_code },
                { header: "Admission", cell: (r) => r.admission.admission_code },
                { header: "Status", cell: (r) => <Status>{r.status}</Status> },
                { header: "Decision", cell: (r) => r.refund_decision ?? "—" },
                { header: "Payout", cell: (r) => r.payout_status ?? "—" },
                { header: "Requested", cell: (r) => dateTime(r.requested_at) },
              ]}
            />
          </Section>
        </div>
      )}
    </QueryView>
  );
}

function PlacementTab({ personId }: { personId: number }) {
  const placement = useStudentTab(personId, "placement");
  return (
    <QueryView query={placement} isEmpty={(d) => !d.profile && !d.applications.length} empty={<Empty title="No placement profile">Career assistance only — no guaranteed placement.</Empty>}>
      {(d) => (
        <div className="space-y-4">
          {d.profile && (
            <Facts
              columns={3}
              items={[
                ["Readiness", <Status>{d.profile.readiness}</Status>],
                ["Consent", d.profile.consent_status],
                ["CV review", d.profile.cv_review_status],
                ["Evidence", d.profile.evidence_status],
                ["Preferred role", d.profile.preferred_role ?? "—"],
                ["Preferred location", d.profile.preferred_location ?? "—"],
              ]}
            />
          )}
          <DataTable
            rows={d.applications}
            rowKey={(a) => a.application_id}
            empty={<p className="text-sm text-muted-foreground">No applications.</p>}
            columns={[
              { header: "Job", cell: (a) => `${a.job_code} · ${a.job_title}` },
              { header: "Stage", cell: (a) => <Status>{a.stage}</Status> },
              { header: "Since", cell: (a) => dateTime(a.stage_changed_at) },
              { header: "Evidence", cell: (a) => a.evidence_status },
            ]}
          />
        </div>
      )}
    </QueryView>
  );
}

function TimelineTab({ personId }: { personId: number }) {
  const timeline = useStudentTab(personId, "timeline");
  return (
    <QueryView query={timeline} empty={<Empty title="No events" />}>
      {(events) => (
        <div className="space-y-3 border-l-2 pl-5">
          {events.map((t, i) => (
            <div key={`${t.at}-${i}`}>
              <div className="text-xs text-muted-foreground">
                {dateTime(t.at)} · {t.kind.replace(/_/g, " ")}
              </div>
              <div className="text-sm font-semibold">{t.title}</div>
              {t.detail && <div className="text-sm text-muted-foreground">{t.detail}</div>}
            </div>
          ))}
        </div>
      )}
    </QueryView>
  );
}

function AuditTab({ personId }: { personId: number }) {
  const audit = useStudentTab(personId, "audit");
  const show = (v: Record<string, unknown> | null) => (v ? Object.entries(v).map(([k, x]) => `${k}: ${typeof x === "object" ? JSON.stringify(x) : String(x)}`).join(" · ") : "—");
  return (
    <DataTable
      rows={audit.data}
      loading={audit.isLoading}
      error={audit.error}
      onRetry={() => void audit.refetch()}
      rowKey={(e) => e.audit_id}
      empty={<Empty title="No audit entries" />}
      columns={[
        { header: "When", cell: (e) => dateTime(e.occurred_at) },
        { header: "Action", cell: (e) => e.action.replace(/_/g, " ") },
        { header: "Record", cell: (e) => `${e.entity_type} #${e.entity_id}` },
        { header: "Changes", cell: (e) => <span className="block max-w-80 truncate" title={show(e.new_values)}>{show(e.new_values)}</span> },
        { header: "Reason", cell: (e) => e.reason ?? "—" },
      ]}
    />
  );
}

