import { createFileRoute } from "@tanstack/react-router";
import { Leads } from "@/components/crm/screens";
export const Route = createFileRoute("/leads/")({
  head: () => ({
    meta: [
      { title: "Leads — Nipuna CRM Prototype" },
      { name: "description", content: "Search and manage synthetic sample leads." },
      { property: "og:title", content: "Leads — Nipuna CRM" },
      { property: "og:description", content: "Search and manage synthetic sample leads." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: () => <Leads />,
});
