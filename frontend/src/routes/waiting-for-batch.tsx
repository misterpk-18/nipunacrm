import { createFileRoute } from "@tanstack/react-router";
import { compact, num, str } from "@/features/academics/shared";
import { WaitingForBatch, type WaitingSearch } from "@/features/academics/waiting-for-batch";

export const Route = createFileRoute("/waiting-for-batch")({
  validateSearch: (s: Record<string, unknown>): WaitingSearch =>
    compact({ page: num(s["page"]), q: str(s["q"]), course_id: num(s["course_id"]), seat_type: str(s["seat_type"]) }),
  component: function WaitingForBatchPage() {
    const search = Route.useSearch();
    const navigate = Route.useNavigate();
    return <WaitingForBatch search={search} onSearch={(next) => void navigate({ search: next })} />;
  },
});
