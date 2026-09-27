import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { CircleDollarSign, Search } from "lucide-react";
import { invoiceKeys, invoicesApi } from "@/api/invoices";
import { paymentKeys, paymentsApi, type PaymentFilters, type UnallocatedAdvance } from "@/api/payments";
import { useLookups } from "@/api/reference";
import { useAuth, useBranchFilter } from "@/auth/auth";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Field, NativeSelect } from "@/components/crm/forms";
import { DataTable, Empty, PageHead, Pagination, Section, Status } from "@/components/crm/ui";
import { date, money } from "@/lib/format";
import { useApiMutation } from "@/lib/mutation";
import { RecordPaymentDialog } from "./record-payment";
import { CorrectionsTable, FINANCE_INVALIDATE, LedgerTable, useFinanceRoles } from "./shared";

export type PaymentSearch = Pick<PaymentFilters, "page" | "q" | "status" | "entry_type" | "payment_mode_id" | "from" | "to"> & {
  tab?: "ledger" | "unallocated" | "corrections";
  cstatus?: string;
};

/** Payments & Receipts: immutable ledger, record payment, verification, unallocated advances, correction requests. */
export function PaymentsPage({ search, onSearch }: { search: PaymentSearch; onSearch: (next: PaymentSearch) => void }) {
  const roles = useFinanceRoles();
  const branchId = useBranchFilter();
  const lookups = useLookups();
  const [recordOpen, setRecordOpen] = useState(false);
  const [text, setText] = useState(search.q ?? "");
  const tab = search.tab ?? "ledger";
  const { tab: _tab, cstatus, ...ledgerSearch } = search;
  const filters: PaymentFilters = { ...ledgerSearch, branch_id: branchId, per_page: 25 };
  const payments = useQuery({ queryKey: paymentKeys.list(filters), queryFn: () => paymentsApi.list(filters), placeholderData: (prev) => prev });
  const totals = payments.data?.totals;

  const set = (patch: Partial<PaymentSearch>) => {
    const next = { ...search, ...patch, page: undefined };
    for (const key of Object.keys(next) as (keyof PaymentSearch)[]) if (next[key] === "" || next[key] === undefined) delete next[key];
    onSearch(next);
  };

  return (
    <>
      <PageHead
        title="Payments & Receipts"
        description="Immutable ledger. New payments start as Pending Verification; corrections are linked reversals."
        actions={
          <>
            {roles.canRecord && (
              <Button onClick={() => setRecordOpen(true)}>
                <CircleDollarSign />
                Record payment
              </Button>
            )}
            <Button asChild variant="outline">
              <Link to="/invoices">Invoice Register</Link>
            </Button>
          </>
        }
      />
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="metric-card">
          <span className="text-xs font-medium text-muted-foreground">Verified net (filtered)</span>
          <strong className="mt-2 block text-xl font-semibold">{money(totals?.verified_net)}</strong>
        </div>
        <div className="metric-card">
          <span className="text-xs font-medium text-muted-foreground">Pending verification (excluded)</span>
          <strong className="mt-2 block text-xl font-semibold">{money(totals?.pending_verification)}</strong>
        </div>
        <div className="metric-card sm:col-span-2">
          <span className="text-xs font-medium text-muted-foreground">Payment truth</span>
          <span className="mt-2 block text-xs leading-5">
            Completion: Unpaid / Part Paid / Paid · Due position: Upcoming / Due Today / Overdue · Verification: Pending Verification / Verified / Failed.
            {!roles.canVerify && " Only Accounts (or an admin) can verify payments."}
          </span>
        </div>
      </div>
      <div className="panel overflow-x-auto">
        <Tabs value={tab} onValueChange={(v) => onSearch({ ...search, tab: v === "ledger" ? undefined : (v as PaymentSearch["tab"]), page: undefined })}>
          <TabsList className="min-w-max">
            <TabsTrigger value="ledger">Payment ledger</TabsTrigger>
            {roles.canSeeUnallocated && <TabsTrigger value="unallocated">Unallocated advances</TabsTrigger>}
            {roles.canVerify && <TabsTrigger value="corrections">Correction requests</TabsTrigger>}
          </TabsList>
          <TabsContent value="ledger" className="mt-4">
            <div className="mb-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-6">
              <form
                className="relative sm:col-span-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  set({ q: text.trim() || undefined });
                }}
              >
                <Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" />
                <Input className="pl-9" placeholder="Receipt, reference, name — Enter" aria-label="Search payments" value={text} onChange={(e) => setText(e.target.value)} />
              </form>
              <NativeSelect
                aria-label="Verification"
                value={search.status ?? ""}
                placeholder="Any verification"
                options={["Pending Verification", "Verified", "Failed"].map((s) => ({ value: s, label: s }))}
                onChange={(e) => set({ status: e.target.value })}
              />
              <NativeSelect
                aria-label="Entry type"
                value={search.entry_type ?? ""}
                placeholder="Payments & reversals"
                options={["Payment", "Reversal"].map((s) => ({ value: s, label: s }))}
                onChange={(e) => set({ entry_type: e.target.value })}
              />
              <NativeSelect
                aria-label="Payment mode"
                value={search.payment_mode_id ?? ""}
                placeholder="Any mode"
                options={(lookups.data?.payment_modes ?? []).map((m) => ({ value: m.id, label: m.label }))}
                onChange={(e) => set({ payment_mode_id: e.target.value ? Number(e.target.value) : undefined })}
              />
              <div className="flex gap-1">
                <Input type="date" aria-label="From date" value={search.from ?? ""} onChange={(e) => set({ from: e.target.value })} />
                <Input type="date" aria-label="To date" value={search.to ?? ""} onChange={(e) => set({ to: e.target.value })} />
              </div>
            </div>
            <LedgerTable
              rows={payments.data?.data}
              loading={payments.isLoading}
              error={payments.error}
              onRetry={() => void payments.refetch()}
              empty={<Empty title="No payments match">Try clearing the filters.</Empty>}
            />
            <Pagination meta={payments.data?.meta} onPage={(page) => onSearch({ ...search, page })} />
          </TabsContent>
          {roles.canSeeUnallocated && (
            <TabsContent value="unallocated" className="mt-4">
              <Unallocated />
            </TabsContent>
          )}
          {roles.canVerify && (
            <TabsContent value="corrections" className="mt-4">
              <Corrections status={cstatus} onStatus={(s) => onSearch({ ...search, cstatus: s || undefined })} />
            </TabsContent>
          )}
        </Tabs>
      </div>
      <RecordPaymentDialog open={recordOpen} onOpenChange={setRecordOpen} />
    </>
  );
}

function Unallocated() {
  const roles = useFinanceRoles();
  const { branches } = useAuth();
  const [page, setPage] = useState(1);
  const [allocating, setAllocating] = useState<UnallocatedAdvance | null>(null);
  const advances = useQuery({ queryKey: paymentKeys.unallocated({ page }), queryFn: () => paymentsApi.unallocated({ page }) });
  return (
    <Section title="Unallocated advances" subtitle="Money received with no invoice (or above the outstanding). Accounts allocates each advance to one invoice of the same person.">
      <DataTable
        rows={advances.data?.data}
        loading={advances.isLoading}
        error={advances.error}
        onRetry={() => void advances.refetch()}
        rowKey={(a) => a.payment_id}
        empty={<Empty title="No unallocated advances" />}
        columns={[
          { header: "Receipt", cell: (a) => <span className="font-medium">{a.receipt_number}</span> },
          { header: "Person", cell: (a) => `${a.person.full_name} · ${a.person.person_code ?? ""}` },
          { header: "Branch", cell: (a) => branches.find((b) => b.branch_id === a.collecting_branch_id)?.branch_name ?? a.collecting_branch_id },
          { header: "Date", cell: (a) => date(a.payment_date) },
          { header: "Amount", cell: (a) => money(a.amount), className: "text-right" },
          { header: "Verification", cell: (a) => <Status>{a.verification_status}</Status> },
          {
            header: "Actions",
            cell: (a) =>
              roles.canVerify ? (
                <Button size="sm" variant="outline" onClick={() => setAllocating(a)}>
                  Allocate
                </Button>
              ) : (
                "—"
              ),
          },
        ]}
      />
      <Pagination meta={advances.data?.meta} onPage={setPage} />
      <AllocateDialog advance={allocating} onClose={() => setAllocating(null)} />
    </Section>
  );
}

function AllocateDialog({ advance, onClose }: { advance: UnallocatedAdvance | null; onClose: () => void }) {
  const [invoiceId, setInvoiceId] = useState("");
  const personId = advance?.person.person_id;
  const invoices = useQuery({
    queryKey: invoiceKeys.list({ person_id: personId, status: "Issued" }),
    queryFn: () => invoicesApi.list({ person_id: personId, status: "Issued", per_page: 50 }),
    enabled: !!personId,
  });
  const allocate = useApiMutation((v: { id: number; invoice: number }) => paymentsApi.allocate(v.id, v.invoice), {
    success: (p) => `${p.receipt_number} allocated to ${p.invoice?.invoice_number ?? "invoice"}`,
    invalidate: FINANCE_INVALIDATE,
    onSuccess: () => {
      setInvoiceId("");
      onClose();
    },
  });
  const options = (invoices.data?.data ?? []).filter((i) => Number(i.outstanding) > 0);
  return (
    <Dialog open={advance !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="w-[calc(100vw-1.5rem)] max-w-md">
        <DialogHeader>
          <DialogTitle>Allocate {advance?.receipt_number}</DialogTitle>
          <DialogDescription>
            {money(advance?.amount)} from {advance?.person.full_name}. The allocation is capped at the invoice outstanding and cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <Field label="Invoice" htmlFor="alloc-invoice">
          <NativeSelect
            id="alloc-invoice"
            value={invoiceId}
            placeholder={invoices.isLoading ? "Loading…" : options.length ? "Select invoice…" : "No open invoice for this person"}
            options={options.map((i) => ({ value: i.invoice_id, label: `${i.invoice_number} · outstanding ${money(i.outstanding)}` }))}
            onChange={(e) => setInvoiceId(e.target.value)}
          />
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!invoiceId || allocate.isPending} onClick={() => advance && allocate.mutate({ id: advance.payment_id, invoice: Number(invoiceId) })}>
            Allocate
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Corrections({ status, onStatus }: { status: string | undefined; onStatus: (s: string) => void }) {
  const [page, setPage] = useState(1);
  const query = { page, status };
  const corrections = useQuery({ queryKey: paymentKeys.corrections(query), queryFn: () => paymentsApi.corrections(query) });
  return (
    <Section
      title="Correction requests"
      subtitle="Accounts requests with a reason; a distinct Founder / CEO or Super Admin approves, which appends a linked reversal."
      action={
        <div className="w-48">
          <NativeSelect
            aria-label="Correction status"
            value={status ?? ""}
            placeholder="Any status"
            options={["Pending Approval", "Approved", "Rejected"].map((s) => ({ value: s, label: s }))}
            onChange={(e) => {
              setPage(1);
              onStatus(e.target.value);
            }}
          />
        </div>
      }
    >
      <CorrectionsTable rows={corrections.data?.data} loading={corrections.isLoading} error={corrections.error} onRetry={() => void corrections.refetch()} />
      <Pagination meta={corrections.data?.meta} onPage={setPage} />
    </Section>
  );
}
