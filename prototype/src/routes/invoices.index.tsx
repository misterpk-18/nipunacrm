import { createFileRoute } from "@tanstack/react-router";
import { Invoices } from "@/components/crm/screens";
export const Route = createFileRoute("/invoices/")({
  head: () => ({ meta: [{ title: "Invoice Register — Nipuna CRM Prototype" }, { name: "description", content: "Synthetic invoice register with verified, pending and outstanding amounts." }, { property: "og:title", content: "Invoice Register — Nipuna CRM" }, { property: "og:description", content: "Synthetic invoice register with verified, pending and outstanding amounts." }, { property: "og:type", content: "website" }, { name: "twitter:card", content: "summary_large_image" }] }),
  component: Invoices,
});
