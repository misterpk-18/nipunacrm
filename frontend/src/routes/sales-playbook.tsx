import { createFileRoute } from "@tanstack/react-router";
import { PLAYBOOK_TABS, SalesPlaybookPage, type PlaybookTab } from "@/features/management/sales-playbook";

export const Route = createFileRoute("/sales-playbook")({
  validateSearch: (s: Record<string, unknown>): { tab?: PlaybookTab } =>
    typeof s["tab"] === "string" && (PLAYBOOK_TABS as readonly string[]).includes(s["tab"]) ? { tab: s["tab"] as PlaybookTab } : {},
  component: SalesPlaybookRoute,
});

function SalesPlaybookRoute() {
  const { tab } = Route.useSearch();
  const navigate = Route.useNavigate();
  return <SalesPlaybookPage tab={tab ?? "knowledge"} onTab={(next) => void navigate({ search: { tab: next }, replace: true })} />;
}
