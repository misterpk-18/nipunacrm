import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Plus, Search } from "lucide-react";
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
        title="Invoices"
        description="Course charges, payment plans and balances in one clear ledger."
        actions={
          <>
            <Button asChild variant="outline">
              <Link to="/payments" search={{ tab: "record" } as never}>
                Record payment
              </Link>
            </Button>
            <Button asChild>
              <Link to="/pipeline">
                <Plus />
                Create from a deal
              </Link>
            </Button>
          </>
        }
      />
      <MoneyTiles
        loading={invoices.isLoading}
        items={[
          ["Total invoiced", money(totals?.billed)],
          ["Verified payments", money(totals?.verified_paid)],
          ["Pending verification", money(totals?.pending_verification), "Never counted as paid"],
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
                header: "Invoice / student",
                cell: (i) => (
                  <Link to="/invoices/$invoiceId" params={{ invoiceId: String(i.invoice_id) }} className="font-semibold text-primary" onClick={(e) => e.stopPropagation()}>
                    {i.invoice_number}
                    <small className="block font-normal text-muted-foreground">
                      {i.person.full_name} · {i.collecting_branch.branch_name}
                    </small>
                  </Link>
                ),
              },
              {
                header: "Courses",
                cell: (i) => (
                  <span className="block max-w-60">
                    {i.courses.map((c) => (
                      <span key={c.invoice_line_id} className="block truncate">
                        {c.course.course_title}
                      </span>
                    ))}
                    <small className="block text-muted-foreground">{date(i.issued_on)}</small>
                  </span>
                ),
              },
              { header: "Plan", cell: (i) => <span className="subtle-chip">{planLabel(i)}</span> },
              { header: "Amount", cell: (i) => money(i.billed_amount), className: "text-right" },
              { header: "Paid", cell: (i) => <span className="text-success">{money(i.verified_paid)}</span>, className: "text-right" },
              { header: "Pending", cell: (i) => money(i.pending_verification), className: "text-right" },
              { header: "Balance", cell: (i) => money(i.outstanding), className: "text-right" },
              { header: "Status", cell: (i) => <Status>{i.status === "Issued" ? (i.invoice_state === "Issued" ? "Unpaid" : i.invoice_state) : i.status}</Status> },
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
        <div className="mt-3 flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
          <span>One invoice can cover multiple courses.</span>
          <span>Receipts are issued only after payment verification.</span>
        </div>
      </div>
    </>
  );
}

const planLabel = (i: InvoiceRow) => ({ 1: "Full", 2: "2 instalments", 3: "3 instalments" })[i.payment_plan?.installments ?? 1] ?? i.payment_plan?.plan_name ?? "—";

function InvoiceCard({ invoice: i }: { invoice: InvoiceRow }) {
  return (
    <div className="mobile-lead-card">
      <div className="flex items-start justify-between gap-3">
        <Link to="/invoices/$invoiceId" params={{ invoiceId: String(i.invoice_id) }} className="min-w-0 font-semibold text-primary">
          {i.invoice_number}
          <span className="mt-1 block text-xs font-normal text-muted-foreground">
            {i.person.full_name} · {i.courses.map((c) => c.course.course_title).join(", ")}
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

