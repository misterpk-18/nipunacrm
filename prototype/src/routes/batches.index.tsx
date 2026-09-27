import { createFileRoute } from "@tanstack/react-router";
import { Batches } from "@/components/crm/screens";
export const Route = createFileRoute("/batches/")({
  head: () => ({ meta: [{ title: "Batch Workspace — Nipuna CRM Prototype" }, { name: "description", content: "Branch-scoped sample batches, capacity and allocation." }, { property: "og:title", content: "Batch Workspace — Nipuna CRM" }, { property: "og:description", content: "Branch-scoped sample batches, capacity and allocation." }, { property: "og:type", content: "website" }, { name: "twitter:card", content: "summary_large_image" }] }),
  component: Batches,
});
