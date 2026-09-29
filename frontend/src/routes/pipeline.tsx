import { createFileRoute } from "@tanstack/react-router";
import { PipelineBoard, type PipelineSearch } from "@/features/sales/pipeline-board";
import { compact, num, str } from "@/features/sales/shared";

export const Route = createFileRoute("/pipeline")({
  validateSearch: (s: Record<string, unknown>): PipelineSearch =>
    compact({
      view: s["view"] === "table" ? ("table" as const) : undefined,
      q: str(s["q"]),
      owner_id: str(s["owner_id"]),
      priority: str(s["priority"]),
      course_id: num(s["course_id"]),
      stage: str(s["stage"]),
      page: num(s["page"]),
    }),
  component: PipelinePage,
});

function PipelinePage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return <PipelineBoard search={search} onSearch={(next) => void navigate({ search: compact(next) })} />;
}
