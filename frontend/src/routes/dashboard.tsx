import { createFileRoute } from "@tanstack/react-router";
import { DashboardPage, type DashboardTab } from "@/features/management/dashboard";

export const Route = createFileRoute("/dashboard")({
  validateSearch: (s: Record<string, unknown>): { tab?: DashboardTab } => (s["tab"] === "performance" ? { tab: "performance" } : {}),
  component: DashboardRoute,
});

function DashboardRoute() {
  const { tab } = Route.useSearch();
  const navigate = Route.useNavigate();
  return <DashboardPage tab={tab ?? "overview"} onTab={(next) => void navigate({ search: next === "performance" ? { tab: next } : {}, replace: true })} />;
}
