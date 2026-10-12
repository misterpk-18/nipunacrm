import { createFileRoute } from "@tanstack/react-router";
import { compact, num, str } from "@/features/academics/shared";
import { WhatsappMessagesPage, type WhatsappSearch } from "@/features/operations/whatsapp-messages";

export const Route = createFileRoute("/whatsapp")({
  validateSearch: (s: Record<string, unknown>): WhatsappSearch =>
    compact({ page: num(s["page"]), q: str(s["q"]), status: str(s["status"]), category: str(s["category"]) }),
  component: WhatsappRoute,
});

function WhatsappRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return <WhatsappMessagesPage search={search} onSearch={(next) => void navigate({ search: compact(next) })} />;
}
