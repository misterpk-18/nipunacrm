import { createFileRoute } from "@tanstack/react-router";
import { ReportsPage } from "@/features/management/reports";

export const Route = createFileRoute("/reports")({
  component: ReportsPage,
});
