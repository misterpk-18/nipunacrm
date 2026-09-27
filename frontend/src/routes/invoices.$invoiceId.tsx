import { createFileRoute } from "@tanstack/react-router";
import { InvoiceDetail } from "@/features/finance/invoice-detail";

export const Route = createFileRoute("/invoices/$invoiceId")({
  component: function InvoicePage() {
    const { invoiceId } = Route.useParams();
    return <InvoiceDetail key={invoiceId} invoiceId={Number(invoiceId)} />;
  },
});
