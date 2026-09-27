import { createFileRoute } from "@tanstack/react-router";
import { SpecialClosingQueue, type ScrSearch } from "@/features/sales/special-closing";
import { compact, num, str } from "@/features/sales/shared";

const QUEUES = ["can_approve", "higher_approval", "all"] as const;

export const Route = createFileRoute("/discount-approval")({
  validateSearch: (s: Record<string, unknown>): ScrSearch => {
    const queue = str(s["queue"]);
    return compact({
      queue: QUEUES.find((q) => q === queue),
      status: str(s["status"]),
      page: num(s["page"]),
      id: num(s["id"]),
    });
  },
  component: DiscountApprovalRoute,
});

function DiscountApprovalRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return <SpecialClosingQueue search={search} onSearch={(next) => void navigate({ search: compact(next) })} />;
}
