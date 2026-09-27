import { createFileRoute } from "@tanstack/react-router";
import { DashboardPage } from "@/features/management/dashboard";

export const Route = createFileRoute("/dashboard")({
  component: () => <DashboardPage />,
});
