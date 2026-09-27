import { createFileRoute } from "@tanstack/react-router";
import { InvoiceDetail } from "@/components/crm/screens";
export const Route = createFileRoute("/invoices/$invoiceId")({
  head: () => ({ meta: [{ title: "Invoice Detail — Nipuna CRM Prototype" }, { name: "description", content: "Sample invoice, linked payments, receipts and print preview." }, { property: "og:title", content: "Invoice Detail — Nipuna CRM" }, { property: "og:description", content: "Sample invoice, linked payments, receipts and print preview." }, { property: "og:type", content: "website" }, { name: "twitter:card", content: "summary_large_image" }] }),
  component: InvoiceDetail,
});
