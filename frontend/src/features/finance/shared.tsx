/** Finance building blocks shared by invoices, payments, collections and refunds. */
import { useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, Printer, ReceiptText, RotateCcw, XCircle } from "lucide-react";
import { paymentKeys, paymentsApi, type CorrectionRequest, type PaymentRow } from "@/api/payments";
import { useAuth } from "@/auth/auth";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ConfirmAction, DataTable, Empty, QueryView, Status, type Column } from "@/components/crm/ui";
import { date, dateTime, money } from "@/lib/format";
import { useApiMutation } from "@/lib/mutation";

/** Every query a money movement can change. */
export const FINANCE_INVALIDATE = [["payments"], ["invoices"], ["collections"], ["correction-requests"], ["refund-cases"], ["leads"], ["tasks"], ["admissions"], ["students"]];

export function useFinanceRoles() {
  const { hasRole, isAdmin, profile } = useAuth();
  const accounts = hasRole("ACCOUNTS");
  return {
    userId: profile?.user.user_id ?? null,
    isAdmin,
    isAccounts: accounts,
    /** Verify / fail / allocate / request corrections / cancel invoices (Accounts, Founder / CEO, Super Admin). */
    canVerify: accounts || isAdmin,
    canApproveCorrection: isAdmin,
    canSeeUnallocated: accounts || isAdmin || hasRole("BRANCH_MANAGER"),
    canRecord: hasRole("FOUNDER_CEO", "SUPER_ADMIN", "BRANCH_MANAGER", "SALES", "FRONT_OFFICE", "ACCOUNTS"),
    canChangeDueDate: hasRole("FOUNDER_CEO", "SUPER_ADMIN", "BRANCH_MANAGER", "SALES", "FRONT_OFFICE", "ACCOUNTS"),
    /** Refunds: register / assess (managers + Accounts), decide (admins), payout (Accounts, Founder / CEO, Super Admin), withdraw (managers). */
    canRegisterRefund: isAdmin || accounts || hasRole("BRANCH_MANAGER"),
    canDecideRefund: isAdmin,
    canPayout: accounts || isAdmin,
    canWithdrawRefund: isAdmin || hasRole("BRANCH_MANAGER"),
  };
}

export function MoneyTiles({ items, loading }: { items: [string, ReactNode, ReactNode?][]; loading?: boolean }) {
  return (
    <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {items.map(([label, value, hint]) => (
        <div className="metric-card" key={label}>
          <span className="text-xs font-medium text-muted-foreground">{label}</span>
          <strong className="mt-2 block text-xl font-semibold text-foreground">{loading ? "…" : value}</strong>
          {hint && <span className="mt-1 block text-xs text-muted-foreground">{hint}</span>}
        </div>
      ))}
    </div>
  );
}

export function isVerifiable(p: Pick<PaymentRow, "entry_type" | "amount" | "verification_status">) {
  return p.entry_type === "Payment" && Number(p.amount) > 0 && p.verification_status === "Pending Verification";
}

/** Verify (evidence reviewed + independent cash check for cash) / Fail for a pending payment claim. The receipt number
 *  is issued on verification; courses whose verified money reaches ₹1,000 get their admission then. */
export function VerifyActions({ payment }: { payment: PaymentRow }) {
  const { canVerify } = useFinanceRoles();
  const [open, setOpen] = useState(false);
  const fail = useApiMutation((v: { id: number; reason: string }) => paymentsApi.fail(v.id, v.reason), {
    success: (p) => `${p.transaction_number} marked Failed`,
    invalidate: FINANCE_INVALIDATE,
  });
  if (!canVerify || !isVerifiable(payment)) return null;
  return (
    <>
      <Button size="sm" aria-label={`Verify ${payment.transaction_number}`} onClick={() => setOpen(true)}>
        <CheckCircle2 />
        Verify
      </Button>
      <ConfirmAction
        trigger={
          <Button size="sm" variant="outline" aria-label={`Fail ${payment.transaction_number}`}>
            <XCircle />
            Fail
          </Button>
        }
        title={`Mark ${payment.transaction_number} as Failed?`}
        description="The money was not received (bounced, not in the bank statement…). The claim stays in the ledger as Failed and never gets a receipt."
        action="Mark failed"
        destructive
        reason
        reasonLabel="Failure reason"
        onConfirm={(reason) => fail.mutateAsync({ id: payment.payment_id, reason })}
      />
      {open && <VerifyDialog payment={payment} onClose={() => setOpen(false)} />}
    </>
  );
}

function VerifyDialog({ payment, onClose }: { payment: PaymentRow; onClose: () => void }) {
  const cash = (payment.mode ?? "").toLowerCase() === "cash";
  const [evidence, setEvidence] = useState(false);
  const [cashChecked, setCashChecked] = useState(false);
  const verify = useApiMutation(() => paymentsApi.verify(payment.payment_id, { evidence_reviewed: evidence, cash_checked: cashChecked }), {
    success: (p) =>
      `${p.receipt_number} issued` + (p.admissions_created.length ? ` · admitted: ${p.admissions_created.map((a) => a.admission_code).join(", ")}` : ""),
    invalidate: [...FINANCE_INVALIDATE, ["pipeline"], ["deals"]],
    onSuccess: onClose,
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="w-[calc(100vw-1.5rem)] max-w-lg">
        <DialogHeader>
          <DialogTitle>Review before verifying {payment.transaction_number}</DialogTitle>
          <DialogDescription>
            {money(payment.amount)} from {payment.person.full_name} via {payment.mode ?? "—"}
            {payment.reference ? ` (ref ${payment.reference})` : ""}. Verification issues the receipt and counts the money towards each course on the invoice.
          </DialogDescription>
        </DialogHeader>
        {payment.allocations.length > 0 && (
          <ul className="grid gap-1 text-sm">
            {payment.allocations.map((a) => (
              <li key={a.invoice_line_id} className="flex justify-between gap-2">
                <span>{a.course.course_title}</span>
                <b>{money(a.amount)}</b>
              </li>
            ))}
          </ul>
        )}
        <label className="check-tile">
          <Checkbox aria-label="Evidence reviewed" checked={evidence} onCheckedChange={(v) => setEvidence(v === true)} />
          <span className="text-sm">Payment evidence reviewed (bank statement / UTR / proof)</span>
        </label>
        {cash && (
          <label className="check-tile">
            <Checkbox aria-label="Independent cash check completed" checked={cashChecked} onCheckedChange={(v) => setCashChecked(v === true)} />
            <span className="text-sm">Independent cash check completed</span>
          </label>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!evidence || (cash && !cashChecked) || verify.isPending} onClick={() => verify.mutate(undefined)}>
            <CheckCircle2 />
            Verify payment
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function RequestCorrection({ payment }: { payment: PaymentRow }) {
  const { canVerify } = useFinanceRoles();
  const request = useApiMutation((v: { id: number; reason: string }) => paymentsApi.requestCorrection(v.id, v.reason), {
    success: (r) => `${r.request_code} submitted for approval`,
    invalidate: FINANCE_INVALIDATE,
  });
  if (!canVerify || payment.entry_type !== "Payment" || payment.verification_status !== "Verified") return null;
  return (
    <ConfirmAction
      trigger={
        <Button size="sm" variant="ghost" aria-label={`Request correction for ${payment.receipt_number ?? payment.transaction_number}`}>
          <RotateCcw />
          Request correction
        </Button>
      }
      title={`Request correction for ${payment.receipt_number}`}
      description="Nothing changes in the ledger until a distinct Founder / CEO or Super Admin approves; approval appends a linked reversal."
      action="Submit for approval"
      reason
      reasonLabel="Reason (required)"
      onConfirm={(reason) => request.mutateAsync({ id: payment.payment_id, reason })}
    />
  );
}

/** Ledger table: receipts and reversals with receipt / verify / correction actions. */
export function LedgerTable({
  rows,
  loading,
  error,
  onRetry,
  showInvoice = true,
  showPerson = true,
  empty,
  pendingCorrectionFor = [],
}: {
  rows: PaymentRow[] | undefined;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  showInvoice?: boolean;
  showPerson?: boolean;
  empty?: ReactNode;
  /** Payment ids that already have a pending / approved correction (hide "Request correction"). */
  pendingCorrectionFor?: number[];
}) {
  const [receiptFor, setReceiptFor] = useState<number | null>(null);
  const columns: Column<PaymentRow>[] = [
    {
      header: "Transaction / receipt",
      cell: (p) => (
        <span className="font-medium">
          {p.transaction_number}
          <small className="block text-muted-foreground">
            {p.receipt_number ? `Receipt ${p.receipt_number}` : p.verification_status === "Failed" ? "Failed — no receipt" : "No receipt until verified"} · {date(p.payment_date)}
          </small>
        </span>
      ),
    },
    { header: "Kind", cell: (p) => (p.entry_type === "Reversal" ? <Status kind="danger">Reversal</Status> : "Payment") },
  ];
  if (showInvoice)
    columns.push({
      header: "Invoice",
      cell: (p) =>
        p.invoice ? (
          <Link to="/invoices/$invoiceId" params={{ invoiceId: String(p.invoice.invoice_id) }} className="text-primary">
            {p.invoice.invoice_number}
          </Link>
        ) : (
          <Status kind="warn">Unallocated advance</Status>
        ),
    });
  if (showPerson) columns.push({ header: "Payer / branch", cell: (p) => `${p.person.full_name} · ${p.collecting_branch.branch_name}` });
  columns.push({
    header: "Allocation",
    cell: (p) =>
      p.allocations.length ? (
        <span className="block max-w-64 text-xs">
          {p.allocations.map((a) => (
            <span key={a.invoice_line_id} className="block truncate">
              {a.course.course_title} · {money(a.amount)}
            </span>
          ))}
        </span>
      ) : (
        "—"
      ),
  });
  columns.push(
    { header: "Amount", cell: (p) => <span className={Number(p.amount) < 0 ? "text-destructive" : undefined}>{money(p.amount)}</span>, className: "text-right" },
    { header: "Method", cell: (p) => p.mode ?? "—" },
    { header: "Reference", cell: (p) => p.reference ?? "—" },
    { header: "Collector", cell: (p) => p.recorded_by?.full_name ?? "—" },
    { header: "Recorded", cell: (p) => dateTime(p.created_at) },
    { header: "Verification", cell: (p) => <Status>{p.verification_status}</Status> },
    {
      header: "Actions",
      cell: (p) => (
        <div className="flex flex-wrap gap-1" onClick={(e) => e.stopPropagation()}>
          <Button size="sm" variant="outline" onClick={() => setReceiptFor(p.payment_id)} aria-label={`${p.receipt_number ? "Receipt" : "Claim"} ${p.transaction_number}`}>
            <ReceiptText />
            {p.receipt_number ? "Receipt" : "Claim"}
          </Button>
          <VerifyActions payment={p} />
          {!pendingCorrectionFor.includes(p.payment_id) && <RequestCorrection payment={p} />}
        </div>
      ),
    },
  );
  return (
    <>
      <DataTable rows={rows} loading={loading} error={error} onRetry={onRetry} rowKey={(p) => p.payment_id} columns={columns} empty={empty ?? <Empty title="No payments" />} />
      <ReceiptDialog paymentId={receiptFor} onClose={() => setReceiptFor(null)} />
    </>
  );
}

/** Receipt (verified) or payment claim (pending / failed — no receipt number) from GET /payments/{id}/receipt. */
export function ReceiptDialog({ paymentId, onClose }: { paymentId: number | null; onClose: () => void }) {
  const receipt = useQuery({
    queryKey: paymentKeys.receipt(paymentId ?? 0),
    queryFn: () => paymentsApi.receipt(paymentId!),
    enabled: paymentId !== null,
  });
  return (
    <Dialog open={paymentId !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] w-[calc(100vw-1.5rem)] max-w-2xl overflow-y-auto">
        <DialogHeader className="no-print">
          <DialogTitle>{receipt.data?.document ?? "Receipt"}</DialogTitle>
          <DialogDescription>{receipt.data?.note ?? "Printable copy from the payment ledger."}</DialogDescription>
        </DialogHeader>
        <QueryView query={receipt}>
          {(r) => (
            <div className="invoice-doc" data-testid="receipt-sheet" style={{ ["--doc-accent" as string]: r.issuer.accent ?? "#6251DA" }}>
              <header>
                <div className="flex items-center gap-3">
                  <div className="doc-mark">N</div>
                  <div>
                    <div className="text-base font-bold">{r.issuer.legal_name}</div>
                    <div className="text-xs text-[#70788c]">
                      {r.issuer.branch_code} · {r.issuer.branch_name}
                    </div>
                  </div>
                </div>
                <div className="text-right">
                  <div className="doc-accent text-lg font-bold">{r.document}</div>
                  <div className="text-xs">{r.is_receipt ? r.receipt_number : `Transaction ${r.transaction_number}`}</div>
                </div>
              </header>
              <div className="doc-body">
                {!r.is_receipt && (
                  <div className="doc-box font-semibold" role="note">
                    {r.note}
                    {r.failure_reason ? ` · ${r.failure_reason}` : ""}
                  </div>
                )}
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <div className="doc-label">Received from</div>
                    <div className="font-semibold">{r.received_from.full_name}</div>
                    <div className="text-xs text-[#70788c]">{r.received_from.person_code}</div>
                  </div>
                  <div className="sm:text-right">
                    <div className="doc-label">Issued by</div>
                    <div className="whitespace-pre-line text-xs">{[r.issuer.address, r.issuer.phone, r.issuer.email].filter(Boolean).join("\n") || "—"}</div>
                  </div>
                </div>
                <table className="doc-stack">
                  <thead>
                    <tr>
                      <th>Invoice / course</th>
                      <th>Method</th>
                      <th>Reference</th>
                      <th className="num">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(r.allocations.length ? r.allocations : [null]).map((a, i) => (
                      <tr key={a?.invoice_line_id ?? i}>
                        <td>
                          {r.invoice_number ?? "Unallocated advance"}
                          {a && <small className="block text-[#70788c]">{a.course.course_title}</small>}
                        </td>
                        <td>{r.mode ?? "—"}</td>
                        <td>{r.reference ?? "—"}</td>
                        <td className="num">{money(a ? a.amount : r.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="flex flex-wrap justify-between gap-2 text-sm">
                  <span>
                    Paid on {date(r.payment_date)}
                    {r.verified_at ? ` · verified ${dateTime(r.verified_at)}` : ""}
                  </span>
                  <b>Total {money(r.amount)}</b>
                </div>
              </div>
              <footer>{r.is_receipt ? "Receipt issued after payment verification." : "Not a receipt. This payment is not counted until it is verified."}</footer>
            </div>
          )}
        </QueryView>
        <DialogFooter className="no-print">
          <Button onClick={() => window.print()} disabled={!receipt.data}>
            <Printer />
            Print / Save PDF
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Correction requests with approve / reject for a distinct Founder / CEO or Super Admin. */
export function CorrectionsTable({ rows, loading, error, onRetry }: { rows: CorrectionRequest[] | undefined; loading?: boolean; error?: unknown; onRetry?: () => void }) {
  const { canApproveCorrection, userId } = useFinanceRoles();
  const approve = useApiMutation((v: { id: number; note: string }) => paymentsApi.approveCorrection(v.id, v.note), {
    success: (r) => `${r.request_code} approved${r.reversal ? ` · reversal ${r.reversal.receipt_number}` : ""}`,
    invalidate: FINANCE_INVALIDATE,
  });
  const reject = useApiMutation((v: { id: number; note: string }) => paymentsApi.rejectCorrection(v.id, v.note), {
    success: (r) => `${r.request_code} rejected`,
    invalidate: FINANCE_INVALIDATE,
  });
  return (
    <DataTable
      rows={rows}
      loading={loading}
      error={error}
      onRetry={onRetry}
      rowKey={(c) => c.correction_request_id}
      empty={<Empty title="No correction requests" />}
      columns={[
        { header: "Request", cell: (c) => <span className="font-medium">{c.request_code}</span> },
        { header: "Receipt", cell: (c) => c.receipt_number },
        { header: "Amount", cell: (c) => money(c.amount), className: "text-right" },
        { header: "Reason", cell: (c) => <span className="block max-w-64 break-words">{c.reason}</span> },
        { header: "Requested by", cell: (c) => `${c.requested_by?.full_name ?? "—"} · ${dateTime(c.requested_at)}` },
        { header: "Status", cell: (c) => <Status>{c.status}</Status> },
        { header: "Decided by", cell: (c) => (c.decided_by ? `${c.decided_by.full_name} · ${dateTime(c.decided_at)}` : "—") },
        { header: "Reversal", cell: (c) => c.reversal?.receipt_number ?? "—" },
        {
          header: "Actions",
          cell: (c) => {
            if (c.status !== "Pending Approval") return c.decision_note ?? "—";
            if (!canApproveCorrection) return <span className="text-xs text-muted-foreground">Awaiting Founder / CEO or Super Admin</span>;
            if (c.requested_by?.user_id === userId) return <span className="text-xs text-muted-foreground">Self-approval not allowed — a distinct approver must decide</span>;
            return (
              <div className="flex flex-wrap gap-1">
                <ConfirmAction
                  trigger={<Button size="sm">Approve</Button>}
                  title={`Approve ${c.request_code}?`}
                  description={`Appends a linked reversal of ${money(c.amount)} against ${c.receipt_number}. The original receipt is never edited.`}
                  action="Approve & reverse"
                  onConfirm={() => approve.mutateAsync({ id: c.correction_request_id, note: "" })}
                />
                <ConfirmAction
                  trigger={
                    <Button size="sm" variant="outline">
                      Reject
                    </Button>
                  }
                  title={`Reject ${c.request_code}?`}
                  action="Reject"
                  destructive
                  reason
                  reasonLabel="Decision note"
                  onConfirm={(note) => reject.mutateAsync({ id: c.correction_request_id, note })}
                />
              </div>
            );
          },
        },
      ]}
    />
  );
}
