import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/students")({
  head: () => ({
    meta: [
      { title: "Students — Nipuna CRM Prototype" },
      { name: "description", content: "Canonical synthetic student records." },
      { property: "og:title", content: "Students — Nipuna CRM" },
      { property: "og:description", content: "Canonical synthetic student records." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Outlet,
});
