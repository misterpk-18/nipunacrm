/** New Admission (V4): an eligibility review. Admissions are created automatically when a payment verification
 *  brings a course's verified money to ₹1,000 (or its whole amount); this screen lists the invoiced courses still
 *  waiting, what each needs, and a manual fallback (e.g. when the automatic creation was refused). */
import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, GraduationCap, Search } from "lucide-react";
import { admissionKeys, admissionsApi, type EligibleCourse } from "@/api/admissions";
import { useBranchFilter } from "@/auth/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DataTable, Empty, PageHead, Pagination, Section, Status, Warning } from "@/components/crm/ui";
import { date, money } from "@/lib/format";
import { useApiMutation } from "@/lib/mutation";
import { useCan } from "./can";

export function NewAdmission({ invoiceId }: { invoiceId?: number | undefined }) {
  const branchId = useBranchFilter();
  const navigate = useNavigate();
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const query = { branch_id: branchId, invoice_id: invoiceId, q: q || undefined, page };
  const rows = useQuery({ queryKey: [...admissionKeys.all, "eligibility", query], queryFn: () => admissionsApi.eligibility(query), placeholderData: (prev) => prev });
  const can = useCan();
  const create = useApiMutation((line: EligibleCourse) => admissionsApi.create({ invoice_line_id: line.invoice_line_id }), {
    success: (a) => `Admission ${a.admission_code} created`,
    invalidate: [admissionKeys.all, ["invoices"], ["students"], ["pipeline"]],
    onSuccess: (a) => void navigate({ to: "/admissions", search: { q: a.admission_code } as never }),
  });

  return (
    <>
      <PageHead
        title="Admission eligibility"
        description="Invoiced courses without an admission yet. Each course is admitted when ₹1,000 is verified on it (or its whole amount, if smaller) and its delivery plan is accepted."
      />
      <Warning>
        Admissions are created automatically on payment verification — once per course, reusing the person and student record. Pending payment claims or an
        unallocated advance never create one. Complimentary courses are added from the paid admission.
      </Warning>
      <Section title="Waiting for admission" subtitle={invoiceId ? "Filtered to one invoice" : "All invoiced courses in your branch scope"} className="mt-4">
        <form
          className="relative mb-3"
          onSubmit={(e) => {
            e.preventDefault();
            setPage(1);
            setQ(text.trim());
          }}
        >
          <Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" />
          <Input className="pl-9" placeholder="Search invoice number or name — press Enter" value={text} onChange={(e) => setText(e.target.value)} aria-label="Search eligibility" />
        </form>
        <DataTable
          stack
          rows={rows.data?.data}
          loading={rows.isLoading}
          error={rows.error}
          onRetry={() => void rows.refetch()}
          rowKey={(r) => r.invoice_line_id}
          empty={<Empty title="Every invoiced course is admitted">New invoices appear here until their first ₹1,000 is verified.</Empty>}
          columns={[
            {
              header: "Person / course",
              cell: (r) => (
                <span>
                  <b>{r.person.full_name}</b>
                  <small className="block text-muted-foreground">
                    {r.course.course_title} · {r.branch.branch_name}
                  </small>
                </span>
              ),
            },
            {
              header: "Invoice",
              cell: (r) => (
                <Link to="/invoices/$invoiceId" params={{ invoiceId: String(r.invoice.invoice_id) }} className="text-primary">
                  {r.invoice.invoice_number}
                  <small className="block text-muted-foreground">{r.line_code}</small>
                </Link>
              ),
            },
            { header: "Charge", cell: (r) => money(r.billed_amount), className: "text-right" },
            { header: "Verified on course", cell: (r) => `${money(r.verified_total)} / ${money(r.token)}` },
            { header: "Pending", cell: (r) => money(r.pending_verification) },
            {
              header: "Delivery plan",
              cell: (r) =>
                r.delivery_plan ? (
                  <span>
                    {r.delivery_plan.plan_code} · {r.delivery_plan.delivery_mode}
                    <small className="block text-muted-foreground">
                      {r.delivery_plan.seat_type}
                      {r.delivery_plan.planned_start_date ? ` · starts ${date(r.delivery_plan.planned_start_date)}` : ""}
                    </small>
                  </span>
                ) : (
                  "—"
                ),
            },
            {
              header: "Eligibility",
              cell: (r) =>
                r.eligible ? (
                  <Status kind="good">Eligible</Status>
                ) : (
                  <span className="text-xs">
                    <Status kind="warn">Waiting</Status>
                    <small className="block text-muted-foreground">Needs {r.waiting_for.join(", ")}</small>
                  </span>
                ),
            },
            {
              header: "",
              cell: (r) =>
                r.eligible && (can.sell(r.branch.branch_id) || can.at(r.branch.branch_id, "ACCOUNTS")) ? (
                  <Button size="sm" disabled={create.isPending} onClick={() => create.mutate(r)}>
                    <GraduationCap />
                    Create admission
                  </Button>
                ) : r.eligible ? (
                  <CheckCircle2 className="size-4 text-success" />
                ) : null,
            },
          ]}
        />
        <Pagination meta={rows.data?.meta} onPage={setPage} />
      </Section>
    </>
  );
}
