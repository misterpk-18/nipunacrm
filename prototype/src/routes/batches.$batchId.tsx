import { createFileRoute } from "@tanstack/react-router";
import { BatchDetail } from "@/components/crm/screens";
export const Route = createFileRoute("/batches/$batchId")({
  head: () => ({ meta: [{ title: "Batch Detail — Nipuna CRM Prototype" }, { name: "description", content: "Sample batch schedule and allocation checks." }, { property: "og:title", content: "Batch Detail — Nipuna CRM" }, { property: "og:description", content: "Sample batch schedule and allocation checks." }, { property: "og:type", content: "website" }, { name: "twitter:card", content: "summary_large_image" }] }),
  component: BatchDetail,
});
