import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, CalendarClock, CheckCircle2, CircleDollarSign, GraduationCap, Printer, XCircle } from "lucide-react";
import { invoiceKeys, invoicesApi, useInvoice, type InvoiceDetail as Invoice, type ScheduleRow } from "@/api/invoices";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ConfirmAction, DataTable, Empty, ErrorPanel, Facts, LoadingRows, PageHead, QueryView, Section, Status } from "@/components/crm/ui";
import { Field } from "@/components/crm/forms";
import { date, money } from "@/lib/format";
import { useApiMutation } from "@/lib/mutation";
import { RecordPaymentDialog } from "./record-payment";
import { CorrectionsTable, FINANCE_INVALIDATE, LedgerTable, MoneyTiles, useFinanceRoles } from "./shared";

/** Invoice page: balance, schedule, linked ledger incl. reversals, corrections, admission readiness, print. */
export function InvoiceDetail({ invoiceId }: { invoiceId: number }) {
  const invoice = useInvoice(invoiceId);
  if (invoice.isLoading) return <LoadingRows rows={8} />;
  if (invoice.error || !invoice.data)
    return (
      <>
        <PageHead title="Invoice" />
        <ErrorPanel error={invoice.error ?? new Error("Invoice not found")} onRetry={() => void invoice.refetch()} />
        <Link to="/invoices" className="mt-3 inline-block text-sm text-primary">
          Back to Invoice Register
        </Link>
      </>
    );
  return <InvoiceView invoice={invoice.data} />;
}

function InvoiceView({ invoice: inv }: { invoice: Invoice }) {
  const roles = useFinanceRoles();
  const [payOpen, setPayOpen] = useState(false);
  const [printOpen, setPrintOpen] = useState(false);
  const [dueRow, setDueRow] = useState<ScheduleRow | null>(null);
  const issued = inv.status === "Issued";
  const cancel = useApiMutation((reason: string) => invoicesApi.cancel(inv.invoice_id, reason), {
    success: `${inv.invoice_number} cancelled`,
    invalidate: FINANCE_INVALIDATE,
  });
  const lockedCorrections = inv.correction_requests.filter((c) => c.status !== "Rejected").map((c) => c.payment_id);

  return (
    <>
      <Link to="/invoices" className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-primary">
        <ArrowLeft className="size-4" />
        Invoice Register
      </Link>
      <PageHead
        title={inv.invoice_number}
        description={`${inv.person.full_name} · ${inv.course?.course_title ?? "—"} · ${inv.collecting_branch.branch_name}`}
        actions={
          <>
            {issued && roles.canRecord && Number(inv.outstanding) > 0 && (
              <Button onClick={() => setPayOpen(true)}>
                <CircleDollarSign />
                Record payment
              </Button>
            )}
            <Button variant="outline" onClick={() => setPrintOpen(true)}>
              <Printer />
              Print invoice
            </Button>
            {issued && roles.canVerify && inv.payments.length === 0 && (
              <ConfirmAction
                trigger={
                  <Button variant="outline">
                    <XCircle />
                    Cancel invoice
                  </Button>
                }
                title={`Cancel ${inv.invoice_number}?`}
                description="Only invoices with no payments can be cancelled. The invoice stays in the register as Cancelled."
                action="Cancel invoice"
                destructive
                reason
                onConfirm={(reason) => cancel.mutateAsync(reason)}
              />
            )}
          </>
        }
      />
      <MoneyTiles
        items={[
          ["Billed", money(inv.billed_amount), inv.original_billed_amount ? `Originally ${money(inv.original_billed_amount)}` : undefined],
          ["Verified paid", money(inv.verified_paid)],
          ["Pending verification", money(inv.pending_verification), "Not counted until verified"],
          ["Outstanding", money(inv.outstanding), Number(inv.waived) > 0 ? `After ${money(inv.waived)} waived` : undefined],
        ]}
      />
      <div className="grid gap-4 lg:grid-cols-3">
        <Section title="Invoice details" className="min-w-0">
          <Facts
            columns={1}
            items={[
              ["Person", `${inv.person.full_name} · ${inv.person.person_code ?? ""}`],
              [
                "Opportunity",
                inv.lead_id ? (
                  <Link to="/leads/$leadId" params={{ leadId: String(inv.lead_id) }} className="text-primary">
                    {inv.lead_code ?? `Lead #${inv.lead_id}`}
                  </Link>
                ) : (
                  "—"
                ),
              ],
              ["Admission", inv.admission_id ? `#${inv.admission_id}` : "Pre-admission (no admission until a verified qualifying payment + accepted plan)"],
              ["Course", inv.course ? `${inv.course.course_code} · ${inv.course.course_title}` : "—"],
              ["Collecting branch", inv.collecting_branch.branch_name],
              ["Issued", date(inv.issued_on)],
              ["Approved terms", inv.terms ?? "—"],
              ["Plan", inv.payment_plan?.plan_name ?? "—"],
              ["Payment completion", <Status key="c">{inv.payment_completion}</Status>],
              ["Invoice state", <Status key="s">{issued ? inv.invoice_state : inv.status}</Status>],
              ...(inv.cancel_reason ? ([["Cancel reason", inv.cancel_reason]] as [string, string][]) : []),
            ]}
          />
        </Section>
        <div className="min-w-0 space-y-4 lg:col-span-2">
          <Section title="Instalment schedule" subtitle="Allocated from verified payments only">
            <DataTable
              rows={inv.schedule}
              rowKey={(s) => s.installment_no}
              empty={<Empty title="No schedule" />}
              columns={[
                { header: "#", cell: (s) => s.installment_no },
                { header: "Due date", cell: (s) => date(s.due_date) },
                { header: "Amount", cell: (s) => money(s.amount_due), className: "text-right" },
                { header: "Verified allocated", cell: (s) => money(s.amount_covered), className: "text-right" },
                { header: "Remaining", cell: (s) => money(s.balance ?? s.amount_due), className: "text-right" },
                {
                  header: "Position",
                  cell: (s) => (
                    <span>
                      <Status>{s.due_position ?? "—"}</Status>
                      {s.days_overdue ? <small className="block text-muted-foreground">{`${s.days_overdue} days · band ${s.age_band ?? "—"}`}</small> : null}
                      {s.contact_hold ? <small className="block text-muted-foreground">Contact hold (payment pending verification)</small> : null}
                    </span>
                  ),
                },
                {
                  header: "",
                  cell: (s) =>
                    issued && roles.canChangeDueDate && s.due_position !== "Paid" && s.installment_no > 1 ? (
                      <Button size="sm" variant="ghost" onClick={() => setDueRow(s)} aria-label={`Change due date of instalment ${s.installment_no}`}>
                        <CalendarClock />
                        Change date
                      </Button>
                    ) : null,
                },
              ]}
            />
          </Section>
          <AdmissionReadiness invoiceId={inv.invoice_id} />
        </div>
      </div>
      <Section title="Linked payment history" subtitle="Immutable ledger · corrections are linked reversal entries · nothing is edited or deleted" className="mt-4">
        <LedgerTable rows={inv.payments} showInvoice={false} showPerson={false} pendingCorrectionFor={lockedCorrections} empty={<Empty title="No payments recorded against this invoice" />} />
      </Section>
      <Section title="Correction requests" subtitle="Requests never change the ledger. Only a distinct Founder / CEO or Super Admin approval appends a linked reversal." className="mt-4">
        <CorrectionsTable rows={inv.correction_requests} />
      </Section>
      <RecordPaymentDialog open={payOpen} onOpenChange={setPayOpen} invoice={inv} />
      <PrintInvoiceDialog invoiceId={inv.invoice_id} open={printOpen} onOpenChange={setPrintOpen} />
      <DueDateDialog invoice={inv} row={dueRow} onClose={() => setDueRow(null)} />
    </>
  );
}

function AdmissionReadiness({ invoiceId }: { invoiceId: number }) {
  const readiness = useQuery({ queryKey: invoiceKeys.readiness(invoiceId), queryFn: () => invoicesApi.readiness(invoiceId) });
  return (
    <Section title="Admission readiness" subtitle="Admission needs an issued invoice, an accepted delivery plan and a verified qualifying payment">
      <QueryView query={readiness} rows={3}>
        {(r) => (
          <div className="space-y-3">
            <ul className="space-y-1.5 text-sm">
              {r.checks.map((c) => (
                <li key={c.check} className="flex items-start gap-2">
                  {c.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" /> : <XCircle className="mt-0.5 size-4 shrink-0 text-destructive" />}
                  <span>{c.detail}</span>
                </li>
              ))}
            </ul>
            {r.ready ? (
              <Button asChild>
                <Link to="/admissions/new" search={{ invoiceId } as never}>
                  <GraduationCap />
                  Create admission
                </Link>
              </Button>
            ) : r.admission_id ? (
              <Status kind="good">Admitted</Status>
            ) : (
              <Status kind="warn">Not ready for admission</Status>
            )}
          </div>
        )}
      </QueryView>
    </Section>
  );
}

function PrintInvoiceDialog({ invoiceId, open, onOpenChange }: { invoiceId: number; open: boolean; onOpenChange: (open: boolean) => void }) {
  const printable = useQuery({ queryKey: invoiceKeys.print(invoiceId), queryFn: () => invoicesApi.print(invoiceId), enabled: open });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] w-[calc(100vw-1.5rem)] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Print invoice</DialogTitle>
          <DialogDescription>Printable copy generated from the invoice record.</DialogDescription>
        </DialogHeader>
        <QueryView query={printable}>
          {(p) => (
            <div className="print-sheet" data-testid="invoice-sheet">
              <div className="flex flex-wrap justify-between gap-2 text-sm">
                <div>
                  <b>Nipuna Technologies · {p.branch.name}</b>
                  <div className="text-muted-foreground">{[p.branch.address, p.branch.phone, p.branch.email].filter(Boolean).join(" · ") || "—"}</div>
                </div>
                <div className="text-right">
                  <div className="text-xs uppercase text-muted-foreground">{p.document}</div>
                  <b>{p.invoice_number}</b>
                  <div>{date(p.issued_on)}</div>
                </div>
              </div>
              <div className="mt-3 text-sm">
                Bill to: <b>{p.bill_to.full_name}</b> · {p.bill_to.person_code} {p.bill_to.email ? `· ${p.bill_to.email}` : ""}
              </div>
              <div className="table-wrap mt-3">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr>
                      <th>Course</th>
                      <th>Terms</th>
                      <th className="text-right">Billed</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>{p.course ? `${p.course.course_code} · ${p.course.course_title}` : "—"}</td>
                      <td>{p.terms ?? "—"}</td>
                      <td className="text-right">{money(p.billed_amount)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <h3 className="mb-1 mt-3 text-sm font-semibold">{p.plan ?? "Schedule"}</h3>
              <div className="table-wrap">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Due date</th>
                      <th className="text-right">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {p.schedule.map((s) => (
                      <tr key={s.installment_no}>
                        <td>{s.installment_no}</td>
                        <td>{date(s.due_date)}</td>
                        <td className="text-right">{money(s.amount_due)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-3 text-sm">
                Verified paid {money(p.balance.verified_paid)} · Outstanding {money(p.balance.outstanding)}
              </p>
            </div>
          )}
        </QueryView>
        <DialogFooter>
          <Button onClick={() => window.print()} disabled={!printable.data}>
            <Printer />
            Print
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DueDateDialog({ invoice, row, onClose }: { invoice: Invoice; row: ScheduleRow | null; onClose: () => void }) {
  const [value, setValue] = useState("");
  const save = useApiMutation((v: { no: number; due: string }) => invoicesApi.setDueDate(invoice.invoice_id, v.no, v.due), {
    success: (r) => `Instalment ${r.installment_no} now due ${date(r.due_date)}`,
    invalidate: FINANCE_INVALIDATE,
    onSuccess: onClose,
  });
  return (
    <Dialog
      open={row !== null}
      onOpenChange={(o) => {
        if (!o) onClose();
        else setValue(row?.due_date ?? "");
      }}
    >
      <DialogContent className="w-[calc(100vw-1.5rem)] max-w-md">
        <DialogHeader>
          <DialogTitle>Change due date · instalment {row?.installment_no}</DialogTitle>
          <DialogDescription>The date must stay inside the approved plan window ({invoice.payment_plan?.plan_name ?? "plan"}).</DialogDescription>
        </DialogHeader>
        <Field label="New due date" htmlFor="due-date">
          <Input id="due-date" type="date" value={value || row?.due_date || ""} onChange={(e) => setValue(e.target.value)} />
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={save.isPending || !row} onClick={() => row && save.mutate({ no: row.installment_no, due: value || row.due_date })}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
