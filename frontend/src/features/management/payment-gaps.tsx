import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { collectionsApi } from "@/api/collections";
import type { KpiTiles } from "@/api/dashboard";
import { useBranchFilter } from "@/auth/auth";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DataTable, Empty, Metric, Pagination } from "@/components/crm/ui";
import { date, money } from "@/lib/format";
import { useCanOpen } from "./shared";

/** Dashboard tile: plans whose next instalment is due more than 30 days after the last verified payment.
 *  Clicking lists the persons (finance roles — the same people who can open Collections). */
export function LongGapMetric({ tiles }: { tiles: KpiTiles }) {
  const canOpen = useCanOpen();
  const [open, setOpen] = useState(false);
  const gaps = tiles.long_gap_plans;
  const metric = (
    <Metric label="Long-gap plans" value={gaps.count} hint={`Next instalment 30+ days after last payment · ${money(gaps.outstanding)} outstanding`} />
  );
  if (!canOpen("/collections")) return metric;
  return (
    <>
      <button type="button" className="block w-full text-left" onClick={() => setOpen(true)} aria-label={`Long-gap plans: ${gaps.count}`}>
        {metric}
      </button>
      {open && <GapList onClose={() => setOpen(false)} />}
    </>
  );
}

function GapList({ onClose }: { onClose: () => void }) {
  const branchId = useBranchFilter();
  const canOpen = useCanOpen();
  const [page, setPage] = useState(1);
  const filters = { branch_id: branchId, page, per_page: 20 };
  const gaps = useQuery({ queryKey: ["collections", "payment-gaps", filters], queryFn: () => collectionsApi.paymentGaps(filters), placeholderData: (p) => p });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] w-[calc(100vw-1.5rem)] max-w-5xl overflow-y-auto sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>Long-gap plans</DialogTitle>
          <DialogDescription>Persons whose next instalment is due more than 30 days after their last verified payment, longest gap first.</DialogDescription>
        </DialogHeader>
        <DataTable
          rows={gaps.data?.data}
          loading={gaps.isLoading}
          error={gaps.error}
          onRetry={() => void gaps.refetch()}
          rowKey={(g) => g.invoice_id}
          empty={<Empty title="No long gaps">Every open plan has its next instalment within 30 days of the last payment.</Empty>}
          columns={[
            {
              header: "Person",
              // Sales roles open Person 360; everyone else Student 360
              cell: (g) => {
                const label = (
                  <>
                    {g.person.full_name}
                    <small className="block font-normal text-muted-foreground">{g.person.person_code}</small>
                  </>
                );
                const params = { personId: String(g.person.person_id) };
                if (!canOpen("/persons"))
                  return (
                    <Link to="/students/$personId" params={params} className="font-semibold text-primary" onClick={onClose}>
                      {label}
                    </Link>
                  );
                return canOpen("/persons") ? (
                  <Link to="/persons/$personId" params={params} className="font-semibold text-primary" onClick={onClose}>
                    {label}
                  </Link>
                ) : (
                  <span className="font-semibold">{label}</span>
                );
              },
            },
            { header: "Courses", cell: (g) => <span className="block max-w-48 truncate">{g.courses.map((c) => c.course_title).join(", ")}</span> },
            {
              header: "Invoice",
              cell: (g) => (
                <Link to="/invoices/$invoiceId" params={{ invoiceId: String(g.invoice_id) }} className="text-primary" onClick={onClose}>
                  {g.invoice_number}
                </Link>
              ),
            },
            { header: "Last payment", cell: (g) => date(g.last_payment_date) },
            { header: "Next due", cell: (g) => `#${g.next_installment_no} · ${date(g.next_due_date)}` },
            { header: "Gap", cell: (g) => <b>{g.gap_days} days</b> },
            { header: "Outstanding", cell: (g) => money(g.outstanding) },
            { header: "Owner", cell: (g) => g.owner?.full_name ?? "Unassigned" },
          ]}
        />
        <Pagination meta={gaps.data?.meta} onPage={setPage} />
      </DialogContent>
    </Dialog>
  );
}
