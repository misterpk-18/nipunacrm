import { createFileRoute } from "@tanstack/react-router";
import { compact, num, str } from "@/features/academics/shared";
import { QUEUES, type QueueKey } from "@/features/sales/counsellor-workspace";
import { MyWorkPage, type MyWorkSearch } from "@/features/workspace/my-work";

export const Route = createFileRoute("/my-work")({
  validateSearch: (s: Record<string, unknown>): MyWorkSearch => {
    const queue = str(s["queue"]);
    return compact({
      queue: QUEUES.some((q) => q.key === queue) ? (queue as QueueKey) : undefined,
      q: str(s["q"]),
      page: num(s["page"]),
    });
  },
  component: MyWorkRoute,
});

function MyWorkRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return <MyWorkPage search={search} onSearch={(next) => void navigate({ search: compact(next) })} />;
}
