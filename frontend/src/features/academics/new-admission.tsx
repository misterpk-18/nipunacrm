import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Check, CheckCircle2, Circle, Search, UserPlus, XCircle } from "lucide-react";
import { admissionKeys, admissionsApi, type AdmissionDetail } from "@/api/admissions";
import { useBranches } from "@/api/reference";
import { studentKeys } from "@/api/students";
import { useBranchFilter } from "@/auth/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, NativeSelect } from "@/components/crm/forms";
import { DataTable, Empty, ErrorPanel, Facts, LoadingRows, PageHead, QueryView, Section, Status, Warning } from "@/components/crm/ui";
import { date, money, todayIST } from "@/lib/format";
import { useApiMutation } from "@/lib/mutation";
import { useCan } from "./can";

const CHECK_LABELS: Record<string, string> = {
  invoice_issued: "Invoice issued",
  accepted_plan: "Accepted confirmed delivery plan",
  verified_payment: "First qualifying allocated payment Verified",
  not_yet_admitted: "Not yet admitted",
};

export function NewAdmission({ invoiceId }: { invoiceId?: number | undefined }) {
  return (
    <>
      <PageHead title="Create Admission" description="Two mandatory prerequisites: an accepted confirmed delivery plan and a verified qualifying payment." />
      <Warning>Payment proof or an Unallocated Advance alone cannot create an Admission. One Person creates one Student Master / LMS identity.</Warning>
      <div className="mt-4">{invoiceId ? <ReadinessStep invoiceId={invoiceId} /> : <InvoicePicker />}</div>
    </>
  );
}

function InvoicePicker() {
  const branchId = useBranchFilter();
  const navigate = useNavigate();
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  const invoices = useQuery({
    queryKey: ["invoices", "admission-candidates", branchId ?? null, q],
    queryFn: () => admissionsApi.issuedInvoices({ branch_id: branchId, q: q || undefined }),
  });
  const rows = (invoices.data?.data ?? []).filter((i) => !i.admission_id);
  return (
    <Section title="Choose an invoice" subtitle="Issued invoices without an admission. Invoices with a verified payment are ready once the delivery plan is accepted.">
      <form
        className="relative mb-3"
        onSubmit={(e) => {
          e.preventDefault();
          setQ(text.trim());
        }}
      >
        <Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" />
        <Input className="pl-9" placeholder="Search invoice number, name or phone — press Enter" value={text} onChange={(e) => setText(e.target.value)} aria-label="Search invoices" />
      </form>
      <DataTable
        rows={rows}
        loading={invoices.isLoading}
        error={invoices.error}
        onRetry={() => void invoices.refetch()}
        rowKey={(i) => i.invoice_id}
        onRowClick={(i) => void navigate({ to: "/admissions/new", search: { invoiceId: i.invoice_id } })}
        empty={<Empty title="No invoices awaiting admission">Issue an invoice from the fee discussion and have Accounts verify a payment first.</Empty>}
        columns={[
          { header: "Invoice", cell: (i) => <span className="font-medium text-primary">{i.invoice_number}</span> },
          { header: "Person", cell: (i) => i.person.full_name },
          { header: "Course", cell: (i) => <span className="block max-w-56 truncate">{i.course.course_title}</span> },
          { header: "Branch", cell: (i) => i.collecting_branch.branch_name },
          { header: "Billed", cell: (i) => money(i.billed_amount) },
          { header: "Verified paid", cell: (i) => money(i.verified_paid) },
          { header: "Pending verification", cell: (i) => money(i.pending_verification) },
          { header: "Payment", cell: (i) => (Number(i.verified_paid) > 0 ? <Status kind="good">Verified payment</Status> : <Status kind="warn">Awaiting verified payment</Status>) },
          {
            header: "",
            cell: (i) => (
              <Button size="sm" variant="outline" asChild onClick={(e) => e.stopPropagation()}>
                <Link to="/admissions/new" search={{ invoiceId: i.invoice_id }}>
                  Select
                </Link>
              </Button>
            ),
          },
        ]}
      />
    </Section>
  );
}

function ReadinessStep({ invoiceId }: { invoiceId: number }) {
  const can = useCan();
  const branches = useBranches();
  const invoice = useQuery({ queryKey: ["invoices", "detail", invoiceId], queryFn: () => admissionsApi.invoice(invoiceId) });
  const readiness = useQuery({ queryKey: admissionKeys.readiness(invoiceId), queryFn: () => admissionsApi.readiness(invoiceId) });
  const [serviceBranch, setServiceBranch] = useState("");
  const [admissionDate, setAdmissionDate] = useState("");
  const [created, setCreated] = useState<AdmissionDetail | null>(null);

  const create = useApiMutation(
    () =>
      admissionsApi.create({
        invoice_id: invoiceId,
        service_branch_id: serviceBranch ? Number(serviceBranch) : null,
        admission_date: admissionDate || null,
      }),
    {
      success: (a) => `Admission ${a.admission_code} created`,
      invalidate: [admissionKeys.all, studentKeys.all, ["invoices"], ["leads"], ["tasks"]],
      onSuccess: (a) => setCreated(a),
    },
  );

  if (created) return <Created a={created} />;
  if (invoice.isLoading || readiness.isLoading) return <LoadingRows rows={6} />;
  if (invoice.error) return <ErrorPanel error={invoice.error} onRetry={() => void invoice.refetch()} />;
  const inv = invoice.data!;
  const r = readiness.data;
  const canCreate = can.sell(inv.collecting_branch.branch_id);

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Section
        title="Invoice"
        action={
          <Button size="sm" variant="ghost" asChild>
            <Link to="/admissions/new" search={{}}>
              Choose another invoice
            </Link>
          </Button>
        }
      >
        <Facts
          items={[
            [
              "Invoice",
              <Link to="/invoices/$invoiceId" params={{ invoiceId: String(inv.invoice_id) }} className="text-primary">
                {inv.invoice_number}
              </Link>,
            ],
            ["Status", <Status>{inv.status}</Status>],
            ["Person", `${inv.person.full_name} · ${inv.person.person_code ?? ""}`],
            ["Branch", inv.collecting_branch.branch_name],
            ["Course", `${inv.course.course_title} (${inv.course.course_code})`],
            ["Agreed fee", money(inv.billed_amount)],
            ["Payment plan", inv.payment_plan?.plan_name ?? "—"],
            ["Issued", date(inv.issued_on)],
            ["Verified paid", money(inv.verified_paid)],
            ["Pending verification", money(inv.pending_verification)],
          ]}
        />
      </Section>
      <Section title="Admission readiness" subtitle="Checked by the server; the database enforces both prerequisites again on create">
        {readiness.error ? (
          <ErrorPanel error={readiness.error} onRetry={() => void readiness.refetch()} />
        ) : (
          <QueryView query={readiness} isEmpty={() => false}>
            {(data) => (
              <>
                <ul className="space-y-2" aria-label="Admission prerequisites">
                  {data.checks.map((c) => (
                    <li key={c.check} className={`flex items-start gap-3 rounded-md border p-3 ${c.ok ? "border-success/40" : "border-destructive/40"}`}>
                      {c.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" /> : <XCircle className="mt-0.5 size-4 shrink-0 text-destructive" />}
                      <span>
                        <b className="text-sm">{CHECK_LABELS[c.check] ?? c.check}</b>
                        <small className="block text-muted-foreground">{c.detail}</small>
                      </span>
                      <span className="sr-only">{c.ok ? "met" : "missing"}</span>
                    </li>
                  ))}
                </ul>
                {data.admission_id && (
                  <div className="mt-3">
                    <Button size="sm" variant="outline" asChild>
                      <Link to="/admissions" search={{ admission: data.admission_id }}>
                        Open existing admission
                      </Link>
                    </Button>
                  </div>
                )}
              </>
            )}
          </QueryView>
        )}
        {r?.ready && canCreate && (
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <Field label="Service branch" htmlFor="na-service" hint="Defaults to the collecting branch">
              <NativeSelect
                id="na-service"
                value={serviceBranch}
                placeholder={`Same as collecting (${inv.collecting_branch.branch_name})`}
                options={(branches.data ?? []).filter((b) => b.branch_id !== inv.collecting_branch.branch_id).map((b) => ({ value: b.branch_id, label: b.branch_name }))}
                onChange={(e) => setServiceBranch(e.target.value)}
              />
            </Field>
            <Field label="Admission date" htmlFor="na-date" hint="Defaults to today">
              <Input id="na-date" type="date" max={todayIST()} value={admissionDate} onChange={(e) => setAdmissionDate(e.target.value)} />
            </Field>
          </div>
        )}
        {!canCreate && <p className="mt-3 text-sm text-muted-foreground">Admissions are created by counsellors or the branch manager of {inv.collecting_branch.branch_name}.</p>}
        <Button className="mt-4" disabled={!r?.ready || !canCreate || create.isPending} onClick={() => create.mutate(undefined)}>
          <UserPlus />
          Create Admission
        </Button>
      </Section>
    </div>
  );
}

function Created({ a }: { a: AdmissionDetail }) {
  return (
    <div className="panel py-6 text-center">
      <Check className="mx-auto size-10 text-success" />
      <h2 className="mt-3 text-xl font-semibold">Admission created</h2>
      <div className="mx-auto mt-5 grid max-w-2xl gap-3 text-left sm:grid-cols-3">
        {(
          [
            ["Person ID", `${a.person.person_code} · ${a.person.full_name}`],
            ["Admission ID", a.admission_code],
            ["CRM Status", "Admitted"],
            ["Enrolment", a.enrolment_status],
            ["Final Fee", money(a.final_fee)],
            ["LMS Provisioning", a.lms_status],
          ] as const
        ).map(([k, v]) => (
          <div className="rounded-md border p-3" key={k}>
            <small className="text-muted-foreground">{k}</small>
            <div className="font-semibold">{v}</div>
          </div>
        ))}
      </div>
      <div className="mt-5 flex flex-wrap justify-center gap-2">
        <Button asChild>
          <Link to="/students/$personId" params={{ personId: String(a.person.person_id) }}>
            Open Student 360
          </Link>
        </Button>
        <Button asChild variant="outline">
          <Link to="/admissions" search={{ admission: a.admission_id }}>
            Open admission
          </Link>
        </Button>
      </div>
      <p className="mt-4 flex items-center justify-center gap-1 text-xs text-muted-foreground">
        <Circle className="size-3" /> Next: curriculum mapping and batch allocation by the Academic Coordinator.
      </p>
    </div>
  );
}
