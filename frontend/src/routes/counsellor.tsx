import { createFileRoute } from "@tanstack/react-router";
import { CounsellorWorkspace, QUEUES, type QueueKey, type WorkspaceSearch } from "@/features/sales/counsellor-workspace";
import { compact, num, str } from "@/features/sales/shared";

export const Route = createFileRoute("/counsellor")({
  validateSearch: (s: Record<string, unknown>): WorkspaceSearch => {
    const queue = str(s["queue"]);
    return compact({
      queue: QUEUES.some((q) => q.key === queue) ? (queue as QueueKey) : undefined,
      q: str(s["q"]),
      page: num(s["page"]),
    });
  },
  component: CounsellorPage,
});

function CounsellorPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return <CounsellorWorkspace search={search} onSearch={(next) => void navigate({ search: compact(next) })} />;
}
