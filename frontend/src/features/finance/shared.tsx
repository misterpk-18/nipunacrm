/** Finance building blocks shared by invoices, payments, collections and refunds. */
import { useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, Printer, ReceiptText, RotateCcw, XCircle } from "lucide-react";
import { paymentKeys, paymentsApi, type CorrectionRequest, type PaymentRow } from "@/api/payments";
import { useAuth } from "@/auth/auth";
import { Button } from "@/components/ui/button";
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
    /** Refunds: register / assess (managers + Accounts), decide (admins), payout (Accounts only), withdraw (managers). */
    canRegisterRefund: isAdmin || accounts || hasRole("BRANCH_MANAGER"),
    canDecideRefund: isAdmin,
    canPayout: accounts,
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

/** Verify / Fail buttons for a pending positive receipt (Accounts and admins only). */
export function VerifyActions({ payment }: { payment: PaymentRow }) {
  const { canVerify } = useFinanceRoles();
  const verify = useApiMutation(paymentsApi.verify, { success: (p) => `${p.receipt_number} verified`, invalidate: FINANCE_INVALIDATE });
  const fail = useApiMutation((v: { id: number; reason: string }) => paymentsApi.fail(v.id, v.reason), {
    success: (p) => `${p.receipt_number} marked Failed`,
    invalidate: FINANCE_INVALIDATE,
  });
  if (!canVerify || !isVerifiable(payment)) return null;
  return (
    <>
      <ConfirmAction
        trigger={
          <Button size="sm" aria-label={`Verify ${payment.receipt_number}`}>
            <CheckCircle2 />
            Verify
          </Button>
        }
        title={`Verify ${payment.receipt_number}?`}
        description={`${money(payment.amount)} from ${payment.person.full_name} via ${payment.mode ?? "—"}${payment.reference ? ` (ref ${payment.reference})` : ""}. Verified money counts towards the invoice and can qualify the admission.`}
        action="Verify payment"
        onConfirm={() => verify.mutateAsync(payment.payment_id)}
      />
      <ConfirmAction
        trigger={
          <Button size="sm" variant="outline" aria-label={`Fail ${payment.receipt_number}`}>
            <XCircle />
            Fail
          </Button>
        }
        title={`Mark ${payment.receipt_number} as Failed?`}
        description="The money was not received (bounced, not in the bank statement…). The receipt stays in the ledger as Failed."
        action="Mark failed"
        destructive
        reason
        reasonLabel="Failure reason"
        onConfirm={(reason) => fail.mutateAsync({ id: payment.payment_id, reason })}
      />
    </>
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
        <Button size="sm" variant="ghost" aria-label={`Request correction for ${payment.receipt_number}`}>
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
      header: "Receipt / event",
      cell: (p) => (
        <span className="font-medium">
          {p.receipt_number}
          <small className="block text-muted-foreground">{date(p.payment_date)}</small>
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
  if (showPerson) columns.push({ header: "Person", cell: (p) => p.person.full_name }, { header: "Branch", cell: (p) => p.collecting_branch.branch_name });
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
          <Button size="sm" variant="outline" onClick={() => setReceiptFor(p.payment_id)} aria-label={`Receipt ${p.receipt_number}`}>
            <ReceiptText />
            Receipt
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

/** Payment receipt / acknowledgement from GET /payments/{id}/receipt, as a printable sheet. */
export function ReceiptDialog({ paymentId, onClose }: { paymentId: number | null; onClose: () => void }) {
  const receipt = useQuery({
    queryKey: paymentKeys.receipt(paymentId ?? 0),
    queryFn: () => paymentsApi.receipt(paymentId!),
    enabled: paymentId !== null,
  });
  return (
    <Dialog open={paymentId !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] w-[calc(100vw-1.5rem)] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{receipt.data?.document ?? "Receipt"}</DialogTitle>
          <DialogDescription>Printable copy from the payment ledger.</DialogDescription>
        </DialogHeader>
        <QueryView query={receipt}>
          {(r) => (
            <div className="print-sheet" data-testid="receipt-sheet">
              {r.verification_status !== "Verified" && (
                <div className="print-watermark" aria-hidden>
                  NOT VERIFIED
                </div>
              )}
              <div className="flex flex-wrap justify-between gap-2 text-sm">
                <div>
                  <b>Nipuna Technologies · {r.branch.name}</b>
                  <div className="text-muted-foreground">{[r.branch.address, r.branch.phone].filter(Boolean).join(" · ") || "—"}</div>
                </div>
                <div className="text-right">
                  <b>{r.receipt_number}</b>
                  <div>{date(r.payment_date)}</div>
                </div>
              </div>
              <div className="mt-3 text-sm">
                Received from: <b>{r.received_from.full_name}</b> · {r.received_from.person_code} {r.received_from.email ? `· ${r.received_from.email}` : ""}
              </div>
              <div className="table-wrap mt-3">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr>
                      <th>Invoice</th>
                      <th>Method</th>
                      <th>Reference</th>
                      <th className="text-right">Amount</th>
                      <th>Verification</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>{r.invoice_number ?? "Unallocated advance"}</td>
                      <td>{r.mode ?? "—"}</td>
                      <td>{r.reference ?? "—"}</td>
                      <td className="text-right">{money(r.amount)}</td>
                      <td>
                        {r.verification_status}
                        {r.verified_at && <small className="block text-muted-foreground">{dateTime(r.verified_at)}</small>}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              {r.verification_status !== "Verified" && <p className="mt-3 text-sm font-semibold">{r.document}</p>}
            </div>
          )}
        </QueryView>
        <DialogFooter>
          <Button onClick={() => window.print()} disabled={!receipt.data}>
            <Printer />
            Print
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
