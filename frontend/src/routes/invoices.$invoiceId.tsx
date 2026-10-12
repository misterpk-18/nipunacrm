import { createFileRoute } from "@tanstack/react-router";
import { InvoiceDetail } from "@/features/finance/invoice-detail";

export const Route = createFileRoute("/invoices/$invoiceId")({
  // next=record-payment: arriving from "create invoice", the page offers "Continue: record payment"
  validateSearch: (s: Record<string, unknown>): { next?: string } => (typeof s["next"] === "string" && s["next"] !== "" ? { next: s["next"] } : {}),
  component: function InvoicePage() {
    const { invoiceId } = Route.useParams();
    const { next } = Route.useSearch();
    return <InvoiceDetail key={invoiceId} invoiceId={Number(invoiceId)} next={next} />;
  },
});
