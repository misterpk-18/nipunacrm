import { createFileRoute } from "@tanstack/react-router";
import { BatchesList, type BatchSearch } from "@/features/academics/batches-list";
import { compact, num, str } from "@/features/academics/shared";

export const Route = createFileRoute("/batches/")({
  validateSearch: (s: Record<string, unknown>): BatchSearch =>
    compact({ page: num(s["page"]), status: str(s["status"]), course_id: num(s["course_id"]) }),
  component: function BatchesPage() {
    const search = Route.useSearch();
    const navigate = Route.useNavigate();
    return <BatchesList search={search} onSearch={(next) => void navigate({ search: next })} />;
  },
});
