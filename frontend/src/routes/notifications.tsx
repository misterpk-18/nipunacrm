import { createFileRoute } from "@tanstack/react-router";
import { NOTIFICATION_TABS } from "@/api/notifications";
import { NotificationsPage, type NotificationSearch } from "@/features/operations/notifications-page";

export const Route = createFileRoute("/notifications")({
  validateSearch: (s: Record<string, unknown>): NotificationSearch => {
    const out: NotificationSearch = {
      tab: typeof s["tab"] === "string" && (NOTIFICATION_TABS as readonly string[]).includes(s["tab"]) ? s["tab"] : undefined,
      page: s["page"] !== undefined && !Number.isNaN(Number(s["page"])) ? Number(s["page"]) : undefined,
    };
    return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined)) as NotificationSearch;
  },
  component: NotificationsRoute,
});

function NotificationsRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return <NotificationsPage search={search} onSearch={(next) => void navigate({ search: next })} />;
}
