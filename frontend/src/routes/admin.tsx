import { createFileRoute } from "@tanstack/react-router";
import { AdminPage } from "@/features/management/admin";

const TABS = [
  "users",
  "settings",
  "branches",
  "lookups",
  "finance",
  "notifications",
  "integrations",
  "security",
  "audit",
] as const;
export type AdminTab = (typeof TABS)[number];

export const Route = createFileRoute("/admin")({
  validateSearch: (s: Record<string, unknown>): { tab?: AdminTab } =>
    typeof s["tab"] === "string" &&
    (TABS as readonly string[]).includes(s["tab"])
      ? { tab: s["tab"] as AdminTab }
      : {},
  component: AdminRoute,
});

function AdminRoute() {
  const { tab } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <AdminPage
      tab={tab ?? "users"}
      onTab={(next) =>
        void navigate({ search: { tab: next as AdminTab }, replace: true })
      }
    />
  );
}
