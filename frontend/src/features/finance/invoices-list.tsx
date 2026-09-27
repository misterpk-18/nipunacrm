import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { invoiceKeys, invoicesApi, type InvoiceFilters, type InvoiceRow } from "@/api/invoices";
import { useBranchFilter } from "@/auth/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/crm/forms";
import { DataTable, Empty, ErrorPanel, LoadingRows, PageHead, Pagination, Status } from "@/components/crm/ui";
import { date, money } from "@/lib/format";
import { MoneyTiles } from "./shared";

export type InvoiceSearch = Pick<InvoiceFilters, "page" | "q" | "status" | "completion">;

/** Invoice Register (GET /invoices): totals, filters in the URL, rows link to the invoice page. */
export function InvoicesList({ search, onSearch }: { search: InvoiceSearch; onSearch: (next: InvoiceSearch) => void }) {
  const branchId = useBranchFilter();
  const navigate = useNavigate();
  const [text, setText] = useState(search.q ?? "");
  const filters: InvoiceFilters = { ...search, branch_id: branchId, per_page: 25 };
  const invoices = useQuery({ queryKey: invoiceKeys.list(filters), queryFn: () => invoicesApi.list(filters), placeholderData: (prev) => prev });
  const totals = invoices.data?.totals;
  const rows = invoices.data?.data;

  const set = (patch: Partial<InvoiceSearch>) => {
    const next = { ...search, ...patch, page: undefined };
    for (const key of Object.keys(next) as (keyof InvoiceSearch)[]) if (next[key] === "" || next[key] === undefined) delete next[key];
    onSearch(next);
  };

  return (
    <>
      <PageHead
        title="Invoice Register"
        description="Invoices by collecting branch. Pending verification is shown separately and never counted as paid."
        actions={
          <Button asChild variant="outline">
            <Link to="/payments">Payments & Receipts</Link>
          </Button>
        }
      />
      <MoneyTiles
        loading={invoices.isLoading}
        items={[
          ["Invoice billed", money(totals?.billed)],
          ["Verified paid", money(totals?.verified_paid)],
          ["Pending verification (excluded)", money(totals?.pending_verification)],
          ["Outstanding", money(totals?.outstanding)],
        ]}
      />
      <div className="panel">
        <div className="mb-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <form
            className="relative sm:col-span-2"
            onSubmit={(e) => {
              e.preventDefault();
              set({ q: text.trim() || undefined });
            }}
          >
            <Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" />
            <Input className="pl-9" placeholder="Invoice number, name or phone — press Enter" aria-label="Search invoices" value={text} onChange={(e) => setText(e.target.value)} />
          </form>
          <NativeSelect
            aria-label="Invoice status"
            value={search.status ?? ""}
            placeholder="Any status"
            options={["Issued", "Superseded", "Cancelled"].map((s) => ({ value: s, label: s }))}
            onChange={(e) => set({ status: e.target.value })}
          />
          <NativeSelect
            aria-label="Payment completion"
            value={search.completion ?? ""}
            placeholder="Any completion"
            options={["Unpaid", "Part Paid", "Paid"].map((s) => ({ value: s, label: s }))}
            onChange={(e) => set({ completion: e.target.value })}
          />
        </div>
        <div className="table-desktop">
          <DataTable
            rows={rows}
            loading={invoices.isLoading}
            error={invoices.error}
            onRetry={() => void invoices.refetch()}
            rowKey={(i) => i.invoice_id}
            onRowClick={(i) => void navigate({ to: "/invoices/$invoiceId", params: { invoiceId: String(i.invoice_id) } })}
            empty={<Empty title="No invoices match">Try clearing the search or filters.</Empty>}
            columns={[
              {
                header: "Invoice",
                cell: (i) => (
                  <Link to="/invoices/$invoiceId" params={{ invoiceId: String(i.invoice_id) }} className="font-semibold text-primary" onClick={(e) => e.stopPropagation()}>
                    {i.invoice_number}
                    <small className="block font-normal text-muted-foreground">{date(i.issued_on)}</small>
                  </Link>
                ),
              },
              { header: "Person", cell: (i) => i.person.full_name },
              { header: "Admission", cell: (i) => (i.admission_id ? `#${i.admission_id}` : <span className="text-muted-foreground">Pre-admission</span>) },
              { header: "Course", cell: (i) => <span className="block max-w-56 truncate">{i.course?.course_title ?? "—"}</span> },
              { header: "Branch", cell: (i) => i.collecting_branch.branch_name },
              { header: "Plan", cell: (i) => i.payment_plan?.plan_name ?? "—" },
              { header: "Billed", cell: (i) => money(i.billed_amount), className: "text-right" },
              { header: "Verified paid", cell: (i) => money(i.verified_paid), className: "text-right" },
              { header: "Pending verification", cell: (i) => money(i.pending_verification), className: "text-right" },
              { header: "Outstanding", cell: (i) => money(i.outstanding), className: "text-right" },
              { header: "Completion", cell: (i) => <Status>{i.payment_completion}</Status> },
              { header: "State", cell: (i) => <Status>{i.status === "Issued" ? i.invoice_state : i.status}</Status> },
            ]}
          />
        </div>
        <div className="mobile-lead-list">
          {invoices.isLoading ? (
            <LoadingRows />
          ) : invoices.error ? (
            <ErrorPanel error={invoices.error} onRetry={() => void invoices.refetch()} />
          ) : rows?.length ? (
            rows.map((i) => <InvoiceCard key={i.invoice_id} invoice={i} />)
          ) : (
            <Empty title="No invoices match" />
          )}
        </div>
        <Pagination meta={invoices.data?.meta} onPage={(page) => onSearch({ ...search, page })} />
      </div>
    </>
  );
}

function InvoiceCard({ invoice: i }: { invoice: InvoiceRow }) {
  return (
    <div className="mobile-lead-card">
      <div className="flex items-start justify-between gap-3">
        <Link to="/invoices/$invoiceId" params={{ invoiceId: String(i.invoice_id) }} className="min-w-0 font-semibold text-primary">
          {i.invoice_number}
          <span className="mt-1 block text-xs font-normal text-muted-foreground">
            {i.person.full_name} · {i.course?.course_title ?? "—"}
          </span>
        </Link>
        <Status>{i.payment_completion}</Status>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-1 text-xs">
        <span>Billed {money(i.billed_amount)}</span>
        <span>Outstanding {money(i.outstanding)}</span>
        <span>Verified {money(i.verified_paid)}</span>
        <span>Pending {money(i.pending_verification)}</span>
      </div>
    </div>
  );
}

