import { createFileRoute } from "@tanstack/react-router";
import { DashboardPage } from "@/features/management/dashboard";

export const Route = createFileRoute("/branch-manager")({
  component: () => <DashboardPage manager />,
});
