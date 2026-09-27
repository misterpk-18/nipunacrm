import { Link, useNavigate } from "@tanstack/react-router";
import { get } from "@/api/client";
import type { Task, TaskLinkField } from "@/api/tasks";
import { toast } from "sonner";

export const LINK_LABELS: Record<TaskLinkField, string> = {
  lead_id: "Lead",
  demo_id: "Demo",
  fee_discussion_id: "Fee discussion",
  scr_id: "Special closing request",
  admission_id: "Admission",
  payment_id: "Payment",
  refund_case_id: "Refund case",
  document_id: "Document",
  communication_id: "Communication",
  support_case_id: "Support case",
  enquiry_id: "Enquiry",
  invoice_id: "Invoice",
  correction_request_id: "Payment correction",
};

/** A task's linked record: a link to its screen where one exists, otherwise the record code. */
export function LinkedRecord({ task }: { task: Pick<Task, "linked" | "linked_record"> }) {
  const navigate = useNavigate();
  const entry = Object.entries(task.linked)[0] as [TaskLinkField, number] | undefined;
  if (!entry) return <span className="text-muted-foreground">—</span>;
  const [field, id] = entry;
  const label = task.linked_record || `${LINK_LABELS[field]} #${id}`;
  const stop = (e: React.MouseEvent) => e.stopPropagation();
  const cls = "font-medium text-primary hover:underline";
  switch (field) {
    case "lead_id":
      return (
        <Link to="/leads/$leadId" params={{ leadId: String(id) }} className={cls} onClick={stop}>
          {label}
        </Link>
      );
    case "invoice_id":
      return (
        <Link to="/invoices/$invoiceId" params={{ invoiceId: String(id) }} className={cls} onClick={stop}>
          {label}
        </Link>
      );
    case "payment_id":
    case "correction_request_id":
      return (
        <Link to="/payments" className={cls} onClick={stop}>
          {label}
        </Link>
      );
    case "refund_case_id":
      return (
        <Link to="/refunds" className={cls} onClick={stop}>
          {label}
        </Link>
      );
    case "demo_id":
      return (
        <Link to="/demos" className={cls} onClick={stop}>
          {label}
        </Link>
      );
    case "scr_id":
      return (
        <Link to="/discount-approval" className={cls} onClick={stop}>
          {label}
        </Link>
      );
    case "communication_id":
      return (
        <Link to="/communications" className={cls} onClick={stop}>
          {label}
        </Link>
      );
    case "admission_id":
      // The task only carries the admission id; resolve the student on click.
      return (
        <button
          type="button"
          className={cls}
          onClick={async (e) => {
            e.stopPropagation();
            try {
              const admission = await get<{ person: { person_id: number } }>(`/admissions/${id}`);
              void navigate({ to: "/students/$personId", params: { personId: String(admission.person.person_id) } });
            } catch {
              toast.error("Couldn't open the admission");
            }
          }}
        >
          {label}
        </button>
      );
    default:
      return (
        <span>
          {label}
          <small className="block text-[11px] text-muted-foreground">{LINK_LABELS[field]}</small>
        </span>
      );
  }
}
