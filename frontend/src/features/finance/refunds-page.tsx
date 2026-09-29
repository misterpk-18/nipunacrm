import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { paymentKeys, paymentsApi } from "@/api/payments";
import {
  EVIDENCE_STATUSES,
  PAYOUT_STATUSES,
  REFUND_DECISIONS,
  REFUND_STATUSES,
  SUPPORT_STATUSES,
  refundKeys,
  refundsApi,
  type RefundCase,
  type RefundFilters,
} from "@/api/refunds";
import { useLookups } from "@/api/reference";
import { useBranchFilter } from "@/auth/auth";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Field, LookupSelect, NativeSelect } from "@/components/crm/forms";
import { ConfirmAction, DataTable, Empty, Facts, PageHead, Pagination, QueryView, Section, Status } from "@/components/crm/ui";
import { date, dateTime, money, relative, sumMoney, todayIST } from "@/lib/format";
import { useApiMutation } from "@/lib/mutation";
import { FINANCE_INVALIDATE, useFinanceRoles } from "./shared";

export type RefundSearch = Pick<RefundFilters, "status" | "refund_decision" | "payout_status" | "page"> & { case?: number; tab?: "refunds" | "support"; sstatus?: string };

const INVALIDATE = [["refund-cases"], ["support-cases"], ...FINANCE_INVALIDATE];

/** Refund / cancellation cases (register → assess → decide → payout → reconcile) and support cases. */
export function RefundsPage({ search, onSearch }: { search: RefundSearch; onSearch: (next: RefundSearch) => void }) {
  const roles = useFinanceRoles();
  const branchId = useBranchFilter();
  const [registerOpen, setRegisterOpen] = useState(false);
  const tab = search.tab ?? "refunds";
  const filters: RefundFilters = { status: search.status, refund_decision: search.refund_decision, payout_status: search.payout_status, page: search.page, branch_id: branchId, per_page: 25 };
  const cases = useQuery({ queryKey: refundKeys.list(filters), queryFn: () => refundsApi.list(filters), placeholderData: (prev) => prev });

  const set = (patch: Partial<RefundSearch>) => {
    const next = { ...search, ...patch, page: undefined };
    for (const key of Object.keys(next) as (keyof RefundSearch)[]) if (next[key] === "" || next[key] === undefined) delete next[key];
    onSearch(next);
  };

  return (
    <>
      <PageHead
        title="Refund / Cancellation"
        description="Separate decisions and execution: managers register and assess, Founder / CEO or Super Admin decides, Accounts pays out and reconciles."
        actions={
          roles.canRegisterRefund && (
            <Button onClick={() => setRegisterOpen(true)}>
              <Plus />
              Register refund case
            </Button>
          )
        }
      />
      <Tabs value={tab} onValueChange={(v) => onSearch({ ...search, tab: v === "refunds" ? undefined : (v as RefundSearch["tab"]) })}>
        <TabsList className="mb-4">
          <TabsTrigger value="refunds">Refund cases</TabsTrigger>
          <TabsTrigger value="support">Support cases</TabsTrigger>
        </TabsList>
        <TabsContent value="refunds">
          <div className="grid gap-4 lg:grid-cols-3">
            <Section title="Refund cases" subtitle="Cases stay registered even when evidence is incomplete" className="lg:col-span-2">
              <div className="mb-3 grid gap-2 sm:grid-cols-3">
                <NativeSelect aria-label="Case status" value={search.status ?? ""} placeholder="Any status" options={REFUND_STATUSES.map((s) => ({ value: s, label: s }))} onChange={(e) => set({ status: e.target.value })} />
                <NativeSelect aria-label="Decision" value={search.refund_decision ?? ""} placeholder="Any decision" options={REFUND_DECISIONS.map((s) => ({ value: s, label: s }))} onChange={(e) => set({ refund_decision: e.target.value })} />
                <NativeSelect aria-label="Payout status" value={search.payout_status ?? ""} placeholder="Any payout" options={PAYOUT_STATUSES.map((s) => ({ value: s, label: s }))} onChange={(e) => set({ payout_status: e.target.value })} />
              </div>
              <DataTable
                rows={cases.data?.data}
                loading={cases.isLoading}
                error={cases.error}
                onRetry={() => void cases.refetch()}
                rowKey={(c) => c.refund_case_id}
                onRowClick={(c) => onSearch({ ...search, case: c.refund_case_id })}
                empty={<Empty title="No refund cases" />}
                columns={[
                  {
                    header: "Case",
                    cell: (c) => (
                      <span className={c.refund_case_id === search.case ? "font-semibold text-primary" : "font-semibold"}>
                        {c.case_code}
                        <small className="block font-normal text-muted-foreground">{dateTime(c.requested_at)}</small>
                      </span>
                    ),
                  },
                  { header: "Person", cell: (c) => c.person.full_name },
                  { header: "Admission", cell: (c) => c.admission.admission_code },
                  { header: "Status", cell: (c) => <Status>{c.status}</Status> },
                  { header: "Evidence", cell: (c) => <Status>{c.evidence_status}</Status> },
                  { header: "Decision", cell: (c) => <Status>{c.refund_decision}</Status> },
                  { header: "Decision target", cell: (c) => (c.refund_decision === "Pending" && c.decision_due_at ? relative(c.decision_due_at) : "—") },
                  { header: "Payout", cell: (c) => <Status>{c.payout_status}</Status> },
                ]}
              />
              <Pagination meta={cases.data?.meta} onPage={(page) => onSearch({ ...search, page })} />
            </Section>
            <Section title="Decision separation">
              <div className="space-y-2 text-sm">
                {[
                  ["Register & assess", "Branch Manager or Accounts"],
                  ["Financial refund / waiver decision", "Founder / CEO or Super Admin"],
                  ["Payout execution & reconciliation", "Accounts (not the decider)"],
                  ["Payout state", "Approved → Processing → Completed / Failed"],
                ].map(([k, v]) => (
                  <div className="rounded-md border p-3" key={k}>
                    <b>{k}</b>
                    <div>{v}</div>
                  </div>
                ))}
              </div>
              <p className="mt-3 text-xs text-muted-foreground">Completed only after payout execution and reconciliation. Refunds are capped at verified payments.</p>
            </Section>
          </div>
          {search.case && <CaseDetail key={search.case} caseId={search.case} onClose={() => onSearch({ ...search, case: undefined })} />}
        </TabsContent>
        <TabsContent value="support">
          <SupportCases status={search.sstatus} onStatus={(s) => onSearch({ ...search, sstatus: s || undefined })} />
        </TabsContent>
      </Tabs>
      <RegisterDialog open={registerOpen} onOpenChange={setRegisterOpen} onCreated={(id) => onSearch({ ...search, tab: undefined, case: id })} />
    </>
  );
}

function CaseDetail({ caseId, onClose }: { caseId: number; onClose: () => void }) {
  const detail = useQuery({ queryKey: refundKeys.detail(caseId), queryFn: () => refundsApi.get(caseId) });
  return (
    <Section title="Refund case" className="mt-4" action={<Button size="sm" variant="ghost" onClick={onClose}>Close</Button>}>
      <QueryView query={detail} rows={6}>
        {(c) => <CaseBody refund={c} />}
      </QueryView>
    </Section>
  );
}

function CaseBody({ refund: c }: { refund: RefundCase }) {
  const roles = useFinanceRoles();
  const lookups = useLookups();
  const closed = c.status === "Completed" || c.status === "Withdrawn";
  const ledger = useQuery({
    queryKey: paymentKeys.list({ admission_id: c.admission.admission_id, per_page: 50 }),
    queryFn: () => paymentsApi.list({ admission_id: c.admission.admission_id, per_page: 50 }),
  });
  const payments = ledger.data?.data ?? [];
  const verified = sumMoney(payments.filter((p) => p.verification_status === "Verified").map((p) => p.amount));
  const modeLabel = lookups.data?.payment_modes.find((m) => m.id === c.payout_mode_id)?.label;
  const withdraw = useApiMutation((reason: string) => refundsApi.withdraw(c.refund_case_id, reason), { success: `${c.case_code} withdrawn`, invalidate: INVALIDATE });
  const reconcile = useApiMutation(() => refundsApi.reconcile(c.refund_case_id), { success: "Payout reconciled", invalidate: INVALIDATE });
  const complete = useApiMutation(() => refundsApi.payout(c.refund_case_id, { status: "Completed" }), { success: `${c.case_code} completed`, invalidate: INVALIDATE });
  const failPayout = useApiMutation((reason: string) => refundsApi.payout(c.refund_case_id, { status: "Failed", failure_reason: reason }), {
    success: "Payout marked Failed",
    invalidate: INVALIDATE,
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-lg font-semibold">{c.case_code}</h3>
        <Status>{c.status}</Status>
        <Status>{c.refund_decision}</Status>
        <Status>{`Payout ${c.payout_status}`}</Status>
        {roles.canWithdrawRefund && !closed && !["Processing", "Completed"].includes(c.payout_status) && (
          <ConfirmAction
            trigger={
              <Button size="sm" variant="outline" className="ml-auto">
                Withdraw case
              </Button>
            }
            title={`Withdraw ${c.case_code}?`}
            description="The learner no longer wants a refund. The case closes as Withdrawn."
            action="Withdraw"
            destructive
            reason
            onConfirm={(reason) => withdraw.mutateAsync(reason)}
          />
        )}
      </div>
      <Facts
        columns={3}
        items={[
          ["Person", `${c.person.full_name} · ${c.person.person_code ?? ""}`],
          ["Admission", `${c.admission.admission_code} · ${c.admission.enrolment_status}`],
          ["Course", c.admission.course?.course_title ?? "—"],
          ["Request reason", c.request_reason],
          ["Request timing", c.request_timing ?? "—"],
          ["Requested", dateTime(c.requested_at)],
          ["Evidence", c.evidence_status],
          ["Assessment", c.assessment_date ? `${date(c.assessment_date)} · ${c.assessment_notes ?? ""}` : c.assessment_notes ?? "Not assessed yet"],
          ["Decision target", c.decision_due_at ? `${dateTime(c.decision_due_at)} (${relative(c.decision_due_at)})` : "—"],
          ["Decision", c.decided_at ? `${c.refund_decision} · ${dateTime(c.decided_at)}` : c.refund_decision],
          ["Approved refund", money(c.approved_refund_amount)],
          ["Approved waiver", money(c.approved_waiver_amount)],
          ["Decision reason", c.decision_reason ?? "—"],
          ["Payout target", c.payout_due_at ? dateTime(c.payout_due_at) : "—"],
          ["Payout", c.payout_amount ? `${money(c.payout_amount)} · ${modeLabel ?? "—"} · ${c.payout_reference ?? "no reference"}` : "—"],
          ["Reconciled", c.reconciled_at ? dateTime(c.reconciled_at) : "—"],
          ["Payout completed", c.payout_completed_at ? dateTime(c.payout_completed_at) : c.payout_failure_reason ? `Failed: ${c.payout_failure_reason}` : "—"],
        ]}
      />
      <div>
        <h4 className="mb-2 text-sm font-semibold">Linked immutable ledger · receipts on this admission</h4>
        <DataTable
          rows={payments}
          loading={ledger.isLoading}
          error={ledger.error}
          rowKey={(p) => p.payment_id}
          empty={<Empty title="No payments on this admission" />}
          columns={[
            { header: "Receipt", cell: (p) => `${p.receipt_number ?? p.transaction_number}${c.receipt_payment_ids.includes(p.payment_id) ? " · linked to case" : ""}` },
            { header: "Kind", cell: (p) => p.entry_type },
            {
              header: "Invoice",
              cell: (p) =>
                p.invoice ? (
                  <Link to="/invoices/$invoiceId" params={{ invoiceId: String(p.invoice.invoice_id) }} className="text-primary">
                    {p.invoice.invoice_number}
                  </Link>
                ) : (
                  "—"
                ),
            },
            { header: "Amount", cell: (p) => money(p.amount), className: "text-right" },
            { header: "Verification", cell: (p) => <Status>{p.verification_status}</Status> },
          ]}
        />
        <p className="mt-2 text-xs text-muted-foreground">Verified money on this admission: {money(verified)}. Any refund is assessed only against verified payments.</p>
      </div>
      {!closed && (
        <div className="grid gap-4 lg:grid-cols-2">
          {c.refund_decision === "Pending" && <AssessForm refund={c} />}
          {c.refund_decision === "Pending" && roles.canDecideRefund && <DecideForm refund={c} />}
          {c.refund_decision === "Refund Approved" && roles.canPayout && (
            <div className="rounded-md border p-3">
              <h4 className="mb-2 text-sm font-semibold">Payout (Accounts)</h4>
              {(c.payout_status === "Approved" || c.payout_status === "Failed") && <PayoutForm refund={c} />}
              {c.payout_status === "Processing" && (
                <div className="flex flex-wrap gap-2">
                  {!c.reconciled_at ? (
                    <Button onClick={() => reconcile.mutate()} disabled={reconcile.isPending || !c.payout_reference}>
                      Reconcile payout
                    </Button>
                  ) : (
                    <Button onClick={() => complete.mutate()} disabled={complete.isPending}>
                      Mark payout completed
                    </Button>
                  )}
                  <ConfirmAction
                    trigger={<Button variant="outline">Payout failed</Button>}
                    title="Mark the payout as failed?"
                    action="Mark failed"
                    destructive
                    reason
                    reasonLabel="Failure reason"
                    onConfirm={(reason) => failPayout.mutateAsync(reason)}
                  />
                </div>
              )}
            </div>
          )}
          {c.refund_decision === "Refund Approved" && !roles.canPayout && <p className="text-sm text-muted-foreground">Awaiting payout by Accounts at the service branch.</p>}
          {c.refund_decision === "Pending" && !roles.canDecideRefund && <p className="text-sm text-muted-foreground">Awaiting decision by Founder / CEO or Super Admin.</p>}
        </div>
      )}
    </div>
  );
}

function AssessForm({ refund: c }: { refund: RefundCase }) {
  const [assessmentDate, setAssessmentDate] = useState(c.assessment_date ?? todayIST());
  const [notes, setNotes] = useState(c.assessment_notes ?? "");
  const [evidence, setEvidence] = useState(c.evidence_status);
  const [timing, setTiming] = useState(c.request_timing ?? "");
  const save = useApiMutation(
    () => refundsApi.update(c.refund_case_id, { assessment_date: assessmentDate || null, assessment_notes: notes.trim() || null, evidence_status: evidence, request_timing: timing.trim() || null }),
    { success: "Assessment saved", invalidate: INVALIDATE },
  );
  return (
    <form
      className="grid gap-2 rounded-md border p-3 sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <h4 className="text-sm font-semibold sm:col-span-2">Assessment</h4>
      <Field label="Assessment date" htmlFor="as-date">
        <Input id="as-date" type="date" value={assessmentDate} onChange={(e) => setAssessmentDate(e.target.value)} />
      </Field>
      <Field label="Evidence" htmlFor="as-evidence">
        <NativeSelect id="as-evidence" value={evidence} options={EVIDENCE_STATUSES.map((s) => ({ value: s, label: s }))} onChange={(e) => setEvidence(e.target.value)} />
      </Field>
      <Field label="Request timing" htmlFor="as-timing" className="sm:col-span-2">
        <Input id="as-timing" placeholder="e.g. Within 3 calendar days of start" value={timing} onChange={(e) => setTiming(e.target.value)} />
      </Field>
      <Field label="Assessment notes" htmlFor="as-notes" className="sm:col-span-2">
        <Textarea id="as-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
      <div className="sm:col-span-2">
        <Button type="submit" variant="outline" disabled={save.isPending}>
          Save assessment
        </Button>
      </div>
    </form>
  );
}

function DecideForm({ refund: c }: { refund: RefundCase }) {
  const [decision, setDecision] = useState("Refund Approved");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const decide = useApiMutation(() => refundsApi.decide(c.refund_case_id, { decision, amount: decision === "Rejected" ? null : amount.trim() || null, reason: reason.trim() || null }), {
    success: (r) => `${r.case_code}: ${r.refund_decision}`,
    invalidate: INVALIDATE,
  });
  return (
    <form
      className="grid gap-2 rounded-md border p-3 sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        decide.mutate();
      }}
    >
      <h4 className="text-sm font-semibold sm:col-span-2">Decision (Founder / CEO or Super Admin)</h4>
      <Field label="Decision" htmlFor="dc-decision">
        <NativeSelect id="dc-decision" value={decision} options={["Refund Approved", "Waiver Approved", "Rejected"].map((s) => ({ value: s, label: s }))} onChange={(e) => setDecision(e.target.value)} />
      </Field>
      {decision !== "Rejected" && (
        <Field label={decision === "Refund Approved" ? "Refund amount (₹)" : "Waiver amount (₹)"} htmlFor="dc-amount">
          <Input id="dc-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} required />
        </Field>
      )}
      <Field label={decision === "Rejected" ? "Reason (required)" : "Reason"} htmlFor="dc-reason" className="sm:col-span-2">
        <Textarea id="dc-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} required={decision === "Rejected"} />
      </Field>
      <div className="sm:col-span-2">
        <Button type="submit" disabled={decide.isPending}>
          Record decision
        </Button>
      </div>
    </form>
  );
}

function PayoutForm({ refund: c }: { refund: RefundCase }) {
  const [amount, setAmount] = useState(c.approved_refund_amount ?? "");
  const [mode, setMode] = useState("");
  const [reference, setReference] = useState("");
  const start = useApiMutation(
    () => refundsApi.payout(c.refund_case_id, { status: "Processing", payout_amount: amount.trim() || null, payout_mode_id: mode ? Number(mode) : null, payout_reference: reference.trim() || null }),
    { success: "Payout started (Processing)", invalidate: INVALIDATE },
  );
  return (
    <form
      className="grid gap-2 sm:grid-cols-3"
      onSubmit={(e) => {
        e.preventDefault();
        start.mutate();
      }}
    >
      <Field label="Payout amount (₹)" htmlFor="po-amount">
        <Input id="po-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
      </Field>
      <Field label="Payout mode" htmlFor="po-mode">
        <LookupSelect id="po-mode" lookup="payment_modes" value={mode} onChange={(e) => setMode(e.target.value)} />
      </Field>
      <Field label="Payout reference" htmlFor="po-ref">
        <Input id="po-ref" value={reference} onChange={(e) => setReference(e.target.value)} />
      </Field>
      <div className="sm:col-span-3">
        <Button type="submit" disabled={start.isPending}>
          Start payout
        </Button>
      </div>
    </form>
  );
}

function RegisterDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: (id: number) => void }) {
  const branchId = useBranchFilter();
  const [q, setQ] = useState("");
  const [admissionId, setAdmissionId] = useState("");
  const [receipts, setReceipts] = useState<number[]>([]);
  const [reason, setReason] = useState("");
  const [timing, setTiming] = useState("");
  const [evidence, setEvidence] = useState<string>("Evidence Pending");
  useEffect(() => {
    if (open) {
      setQ("");
      setAdmissionId("");
      setReceipts([]);
      setReason("");
      setTiming("");
      setEvidence("Evidence Pending");
    }
  }, [open]);
  const admissions = useQuery({
    queryKey: refundKeys.admissions({ q, branch_id: branchId }),
    queryFn: () => refundsApi.admissions({ q: q || undefined, branch_id: branchId }),
    enabled: open,
  });
  const ledger = useQuery({
    queryKey: paymentKeys.list({ admission_id: Number(admissionId), per_page: 50 }),
    queryFn: () => paymentsApi.list({ admission_id: Number(admissionId), per_page: 50 }),
    enabled: open && !!admissionId,
  });
  const payments = (ledger.data?.data ?? []).filter((p) => p.entry_type === "Payment");
  const register = useApiMutation(
    () => refundsApi.register({ admission_id: Number(admissionId), request_reason: reason.trim(), request_timing: timing.trim() || null, evidence_status: evidence, payment_ids: receipts }),
    {
      success: (r) => `${r.case_code} registered`,
      invalidate: INVALIDATE,
      onSuccess: (r) => {
        onOpenChange(false);
        onCreated(r.refund_case_id);
      },
    },
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] w-[calc(100vw-1.5rem)] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Register refund case</DialogTitle>
          <DialogDescription>Registration is always allowed, even with incomplete evidence. The decision target is set automatically.</DialogDescription>
        </DialogHeader>
        <form
          id="register-refund"
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            register.mutate();
          }}
        >
          <Field label="Find admission" htmlFor="rf-search">
            <Input id="rf-search" placeholder="Name, phone or admission code" value={q} onChange={(e) => setQ(e.target.value)} />
          </Field>
          <Field label="Admission" htmlFor="rf-admission">
            <NativeSelect
              id="rf-admission"
              required
              value={admissionId}
              placeholder={admissions.isLoading ? "Loading…" : "Select admission…"}
              options={(admissions.data?.data ?? []).map((a) => ({ value: a.admission_id, label: `${a.admission_code} · ${a.person.full_name} · ${a.course?.course_title ?? ""}` }))}
              onChange={(e) => {
                setAdmissionId(e.target.value);
                setReceipts([]);
              }}
            />
          </Field>
          {admissionId && (
            <fieldset className="rounded-md border p-3">
              <legend className="px-1 text-sm font-medium">Receipts in question</legend>
              {ledger.isLoading ? (
                <p className="text-sm text-muted-foreground">Loading receipts…</p>
              ) : payments.length ? (
                payments.map((p) => (
                  <label key={p.payment_id} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={receipts.includes(p.payment_id)}
                      onChange={() => setReceipts((r) => (r.includes(p.payment_id) ? r.filter((x) => x !== p.payment_id) : [...r, p.payment_id]))}
                    />
                    {p.receipt_number ?? p.transaction_number} · {money(p.amount)} · {p.verification_status}
                  </label>
                ))
              ) : (
                <p className="text-sm text-muted-foreground">No receipts on this admission.</p>
              )}
            </fieldset>
          )}
          <Field label="Request reason" htmlFor="rf-reason">
            <Textarea id="rf-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} required />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Request timing" htmlFor="rf-timing">
              <Input id="rf-timing" placeholder="e.g. Before batch start" value={timing} onChange={(e) => setTiming(e.target.value)} />
            </Field>
            <Field label="Evidence" htmlFor="rf-evidence">
              <NativeSelect id="rf-evidence" value={evidence} options={EVIDENCE_STATUSES.map((s) => ({ value: s, label: s }))} onChange={(e) => setEvidence(e.target.value)} />
            </Field>
          </div>
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="register-refund" disabled={register.isPending || !admissionId || !reason.trim()}>
            Register case
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SupportCases({ status, onStatus }: { status: string | undefined; onStatus: (s: string) => void }) {
  const branchId = useBranchFilter();
  const [page, setPage] = useState(1);
  const query = { page, status, branch_id: branchId };
  const cases = useQuery({ queryKey: refundKeys.support(query), queryFn: () => refundsApi.supportCases(query) });
  const update = useApiMutation((v: { id: number; status: string }) => refundsApi.updateSupportCase(v.id, { status: v.status }), {
    success: (c) => `${c.case_code} → ${c.status}`,
    invalidate: [refundKeys.supportAll, ["students"]],
  });
  return (
    <Section
      title="Support cases"
      subtitle="Learner support requests (refund / cancellation, payment queries, LMS, academic…)"
      action={
        <div className="w-48">
          <NativeSelect
            aria-label="Support status"
            value={status ?? ""}
            placeholder="Any status"
            options={SUPPORT_STATUSES.map((s) => ({ value: s, label: s }))}
            onChange={(e) => {
              setPage(1);
              onStatus(e.target.value);
            }}
          />
        </div>
      }
    >
      <DataTable
        rows={cases.data?.data}
        loading={cases.isLoading}
        error={cases.error}
        onRetry={() => void cases.refetch()}
        rowKey={(c) => c.support_case_id}
        empty={<Empty title="No support cases" />}
        columns={[
          { header: "Case", cell: (c) => <span className="font-medium">{c.case_code}</span> },
          { header: "Person", cell: (c) => c.person.full_name },
          { header: "Type", cell: (c) => c.case_type },
          { header: "Subject", cell: (c) => <span className="block max-w-64 break-words">{c.subject}</span> },
          { header: "Branch", cell: (c) => c.branch?.branch_name ?? "—" },
          { header: "Owner", cell: (c) => c.owner?.full_name ?? "Unassigned" },
          { header: "Opened", cell: (c) => dateTime(c.opened_at) },
          {
            header: "Status",
            cell: (c) => (
              <NativeSelect
                aria-label={`Status of ${c.case_code}`}
                className="w-40"
                value={c.status}
                options={SUPPORT_STATUSES.map((s) => ({ value: s, label: s }))}
                onChange={(e) => update.mutate({ id: c.support_case_id, status: e.target.value })}
              />
            ),
          },
        ]}
      />
      <Pagination meta={cases.data?.meta} onPage={setPage} />
    </Section>
  );
}
