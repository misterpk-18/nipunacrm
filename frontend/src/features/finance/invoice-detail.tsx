import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, CalendarClock, CheckCircle2, CircleDollarSign, GraduationCap, Printer, XCircle } from "lucide-react";
import { invoiceKeys, invoicesApi, useInvoice, type InvoiceDetail as Invoice, type PrintableInvoice, type ScheduleRow } from "@/api/invoices";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ConfirmAction, DataTable, Empty, ErrorPanel, Facts, LoadingRows, PageHead, Section, Status } from "@/components/crm/ui";
import { Field } from "@/components/crm/forms";
import { date, money } from "@/lib/format";
import { useApiMutation } from "@/lib/mutation";
import { CorrectionsTable, FINANCE_INVALIDATE, LedgerTable, MoneyTiles, useFinanceRoles } from "./shared";

/** Invoice page (V4): balances, the branch invoice document (print / save PDF), schedule, courses with their own
 *  balances and admissions, the linked ledger incl. reversals, and corrections. */
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
  const [dueRow, setDueRow] = useState<ScheduleRow | null>(null);
  const issued = inv.status === "Issued";
  const cancel = useApiMutation((reason: string) => invoicesApi.cancel(inv.invoice_id, reason), {
    success: `${inv.invoice_number} cancelled`,
    invalidate: [...FINANCE_INVALIDATE, ["deals"], ["pipeline"]],
  });
  const lockedCorrections = inv.correction_requests.filter((c) => c.status !== "Rejected").map((c) => c.payment_id);
  const printable = useQuery({ queryKey: invoiceKeys.print(inv.invoice_id), queryFn: () => invoicesApi.print(inv.invoice_id) });
  const courses = inv.lines.map((l) => l.course.course_title).join(", ");

  return (
    <div className="print-only-doc">
      <Link to="/invoices" className="no-print mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-primary">
        <ArrowLeft className="size-4" />
        Invoices
      </Link>
      <PageHead
        title={inv.invoice_number}
        description={`${inv.person.full_name} · ${courses} · ${inv.collecting_branch.branch_name}`}
        actions={
          <>
            {issued && roles.canRecord && Number(inv.outstanding) > 0 && (
              <Button asChild>
                <Link to="/payments" search={{ invoice: inv.invoice_id, tab: "record" } as never}>
                  <CircleDollarSign />
                  Record payment
                </Link>
              </Button>
            )}
            <Button variant="outline" onClick={() => window.print()} disabled={!printable.data}>
              <Printer />
              Print / Save PDF
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
                description="Only invoices with no payments can be cancelled. The invoice stays as Cancelled and its courses can be invoiced again."
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
          ["Pending verification", `${money(inv.pending_verification)} · not counted`, "Claims awaiting Accounts"],
          ["Outstanding", money(inv.outstanding), Number(inv.waived) > 0 ? `After ${money(inv.waived)} waived` : undefined],
        ]}
      />
      <div className="invoice-doc-wrap mb-4 rounded-2xl bg-muted p-3 sm:p-6">
        {printable.isLoading && <LoadingRows rows={6} />}
        {printable.error && <ErrorPanel error={printable.error} onRetry={() => void printable.refetch()} />}
        {printable.data && <InvoiceDocument doc={printable.data} />}
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Section title="Invoice details" className="min-w-0">
          <Facts
            columns={1}
            items={[
              ["Person", `${inv.person.full_name} · ${inv.person.person_code ?? ""}`],
              ["Courses", String(inv.lines.length)],
              ["Admissions", inv.admissions.length ? inv.admissions.map((a) => a.admission_code).join(", ") : "None yet — created when ₹1,000 is verified on a course"],
              ["Issuing branch", `${inv.issuer.branch_name ?? inv.collecting_branch.branch_name} (${inv.issuer.branch_code ?? ""})`],
              ["Issued", date(inv.issued_on)],
              ["Plan", `${inv.payment_plan?.plan_name ?? "—"} · ${inv.split}`],
              ["Payment completion", <Status key="c">{inv.payment_completion}</Status>],
              ["Invoice state", <Status key="s">{issued ? inv.invoice_state : inv.status}</Status>],
              ...(inv.cancel_reason ? ([["Cancel reason", inv.cancel_reason]] as [string, string][]) : []),
            ]}
          />
        </Section>
        <div className="min-w-0 space-y-4 lg:col-span-2">
          <Section title="Instalment schedule" subtitle="Verified money covers the oldest instalment first">
            <DataTable
              stack
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
                    issued && roles.canChangeDueDate && s.due_position !== "Paid" ? (
                      <Button size="sm" variant="ghost" onClick={() => setDueRow(s)} aria-label={`Change due date of instalment ${s.installment_no}`}>
                        <CalendarClock />
                        Change date
                      </Button>
                    ) : null,
                },
              ]}
            />
          </Section>
        </div>
      </div>
      <Section title="Courses on this invoice" subtitle="Each course is paid, balanced and admitted on its own" className="mt-4">
        <DataTable
          stack
          rows={inv.lines}
          rowKey={(l) => l.invoice_line_id}
          columns={[
            { header: "Course", cell: (l) => <span className="font-medium">{l.course.course_title}<small className="block text-muted-foreground">{l.line_code}</small></span> },
            {
              header: "Deal",
              cell: (l) => (
                <Link to="/leads/$leadId" params={{ leadId: String(l.lead.lead_id) }} className="text-primary">
                  {l.lead.lead_code}
                </Link>
              ),
            },
            { header: "Charge", cell: (l) => money(l.billed_amount), className: "text-right" },
            { header: "Verified paid", cell: (l) => money(l.verified_paid), className: "text-right" },
            { header: "Pending", cell: (l) => money(l.pending_verification), className: "text-right" },
            { header: "Outstanding", cell: (l) => money(l.outstanding), className: "text-right" },
            {
              header: "Admission",
              cell: (l) => {
                const a = inv.admissions.find((x) => x.admission_id === l.admission_id);
                return a ? (
                  <span>
                    {a.admission_code}
                    <small className="block">
                      <Status>{a.enrolment_status}</Status>
                    </small>
                  </span>
                ) : (
                  <span className="text-xs text-muted-foreground">Not admitted</span>
                );
              },
            },
          ]}
        />
        <AdmissionReadiness invoiceId={inv.invoice_id} />
      </Section>
      <Section title="Linked payment history" subtitle="Immutable ledger · corrections are linked reversal entries · nothing is edited or deleted" className="mt-4">
        <LedgerTable rows={inv.payments} showInvoice={false} showPerson={false} pendingCorrectionFor={lockedCorrections} empty={<Empty title="No payments recorded against this invoice" />} />
      </Section>
      <Section title="Correction requests" subtitle="Requests never change the ledger. Only a distinct Founder / CEO or Super Admin approval appends a linked reversal." className="mt-4">
        <CorrectionsTable rows={inv.correction_requests} />
      </Section>
      <DueDateDialog invoice={inv} row={dueRow} onClose={() => setDueRow(null)} />
    </div>
  );
}

/** Per course: accepted plan, ₹1,000 verified, admitted. Admissions are created on verification; this shows what's missing. */
function AdmissionReadiness({ invoiceId }: { invoiceId: number }) {
  const readiness = useQuery({ queryKey: invoiceKeys.readiness(invoiceId), queryFn: () => invoicesApi.readiness(invoiceId) });
  const pending = (readiness.data?.lines ?? []).filter((l) => !l.admission);
  if (!pending.length) return null;
  return (
    <div className="mt-4 grid gap-3 sm:grid-cols-2">
      {pending.map((line) => (
        <div key={line.invoice_line_id} className="rounded-lg border p-3">
          <div className="mb-1.5 text-sm font-semibold">{line.course.course_title} · admission readiness</div>
          <ul className="space-y-1 text-xs">
            {line.checks
              .filter((c) => c.check !== "not_yet_admitted")
              .map((c) => (
                <li key={c.check} className="flex items-start gap-1.5">
                  {c.ok ? <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-success" /> : <XCircle className="mt-0.5 size-3.5 shrink-0 text-destructive" />}
                  <span>{c.detail}</span>
                </li>
              ))}
          </ul>
          {line.ready && (
            <Button asChild size="sm" variant="outline" className="mt-2">
              <Link to="/admissions/new" search={{ invoiceId } as never}>
                <GraduationCap />
                Review admission
              </Link>
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}

/** Branch invoice document (Guntur violet, Vijayawada teal): the issuer snapshot, never the viewer's branch filter. */
export function InvoiceDocument({ doc }: { doc: PrintableInvoice }) {
  const accent = doc.issuer.accent ?? "#6251DA";
  return (
    <article className="invoice-doc" data-testid="invoice-sheet" style={{ ["--doc-accent" as string]: accent }}>
      <header>
        <div className="flex items-center gap-3">
          <div className="doc-mark">N</div>
          <div>
            <div className="text-base font-bold">{doc.issuer.legal_name}</div>
            <div className="text-xs text-[#70788c]">Course fees &amp; receipts</div>
          </div>
        </div>
        <div className="text-right">
          <div className="doc-accent text-xs font-semibold">
            {doc.issuer.branch_code} · {doc.issuer.branch_name}
          </div>
          <div className="text-xl font-bold">{doc.document}</div>
        </div>
      </header>
      <div className="doc-body">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <div className="doc-label">Issued by · {doc.issuer.branch_name}</div>
            <div className="mt-1 font-semibold">{doc.issuer.legal_name}</div>
            <div className="whitespace-pre-line text-xs leading-relaxed">{doc.issuer.address ?? "—"}</div>
            <div className="mt-1 text-xs">{doc.issuer.phone}</div>
            <div className="text-xs">{doc.issuer.email}</div>
          </div>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1 self-start text-xs">
            <dt className="text-[#70788c]">Invoice no.</dt>
            <dd className="text-right font-semibold">{doc.invoice_number}</dd>
            <dt className="text-[#70788c]">Invoice date</dt>
            <dd className="text-right font-semibold">{date(doc.issued_on)}</dd>
            <dt className="text-[#70788c]">Payment status</dt>
            <dd className="text-right">
              <Status>{doc.payment_status}</Status>
            </dd>
          </dl>
        </div>
        <div className="doc-box">
          <div className="doc-label">Bill to</div>
          <div className="mt-1 text-base font-semibold">{doc.bill_to.full_name}</div>
          <div className="text-xs text-[#70788c]">
            {doc.bill_to.person_code} {doc.bill_to.phone ? `· ${doc.bill_to.phone}` : ""}
          </div>
          {doc.bill_to.email && <div className="text-xs text-[#70788c]">{doc.bill_to.email}</div>}
        </div>
        <table className="doc-stack">
          <thead>
            <tr>
              <th>#</th>
              <th>Course</th>
              <th className="num">Standard</th>
              <th className="num">Amount</th>
            </tr>
          </thead>
          <tbody>
            {doc.lines.map((l) => (
              <tr key={l.line_code}>
                <td>{l.line_no}</td>
                <td>
                  <span className="font-semibold">{l.course.course_title}</span>
                  <small className="block text-[#70788c]">
                    {l.course.course_code} · {l.lead_code}
                  </small>
                </td>
                <td className="num text-[#70788c]">{money(l.standard_fee)}</td>
                <td className="num font-semibold">{money(l.billed_amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <div className="doc-label">Payment terms</div>
            <p className="mt-1 text-xs">
              {doc.plan.plan_name} · {doc.plan.split}
            </p>
            <p className="mt-1 text-xs text-[#70788c]">
              Payments are allocated to individual course lines. One invoice can have multiple receipts. Receipts are issued only after verification.
            </p>
            {doc.terms && <p className="mt-1 text-xs text-[#70788c]">{doc.terms}</p>}
          </div>
          <dl className="grid grid-cols-2 gap-y-1.5 text-sm">
            <dt>Invoice total</dt>
            <dd className="num font-semibold">{money(doc.totals.billed_amount)}</dd>
            {Number(doc.totals.discount) > 0 && (
              <>
                <dt className="text-[#70788c]">Discount on standard fee</dt>
                <dd className="num text-[#70788c]">−{money(doc.totals.discount)}</dd>
              </>
            )}
            <dt>Verified payments, net</dt>
            <dd className="num font-semibold">{money(doc.totals.verified_paid)}</dd>
            {Number(doc.totals.waived) > 0 && (
              <>
                <dt>Waived</dt>
                <dd className="num">{money(doc.totals.waived)}</dd>
              </>
            )}
            <dt className="doc-accent mt-2 border-t pt-2 font-semibold">Balance due</dt>
            <dd className="doc-due num mt-2 border-t pt-2">{money(doc.totals.balance_due)}</dd>
          </dl>
        </div>
        {doc.installments.length > 0 && (
          <div>
            <div className="doc-label mb-2">Payment schedule</div>
            <div className="grid gap-2 sm:grid-cols-3">
              {doc.installments.map((i) => (
                <div key={i.installment_no} className="instalment-card">
                  <div className="text-[11px] text-[#70788c]">Instalment {i.installment_no}</div>
                  <div className="font-bold">{money(i.amount_due)}</div>
                  <div className="text-[11px] text-[#70788c]">Due {date(i.due_date)}</div>
                  {i.due_position && <div className="doc-accent text-[11px] font-semibold">{i.due_position}</div>}
                </div>
              ))}
            </div>
          </div>
        )}
        <div>
          <div className="doc-label mb-1">Receipts against this invoice</div>
          {doc.receipts.length === 0 ? (
            <p className="text-xs text-[#70788c]">No verified receipts yet. Payment claims awaiting verification are not receipts.</p>
          ) : (
            <ul className="divide-y">
              {doc.receipts.map((r) => (
                <li key={r.receipt_number} className="flex justify-between gap-2 py-1.5 text-xs">
                  <span>
                    <b>{r.receipt_number}</b>
                    <span className="block text-[#70788c]">
                      {date(r.payment_date)} · {r.mode ?? r.entry_type}
                    </span>
                  </span>
                  <b className={Number(r.amount) < 0 ? "text-destructive" : undefined}>{money(r.amount)}</b>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <footer>
        {doc.issuer.legal_name} · {doc.issuer.branch_name}
      </footer>
    </article>
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
          <DialogDescription>Any date can be agreed with the learner; reminders follow the new date.</DialogDescription>
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
