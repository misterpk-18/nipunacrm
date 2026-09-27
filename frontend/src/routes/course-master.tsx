import { createFileRoute } from "@tanstack/react-router";
import { CourseMaster, type CourseSearch } from "@/features/academics/course-master";
import { compact, num, str } from "@/features/academics/shared";

export const Route = createFileRoute("/course-master")({
  validateSearch: (s: Record<string, unknown>): CourseSearch =>
    compact({
      page: num(s["page"]),
      q: str(s["q"]),
      type: s["type"] === "standalone" || s["type"] === "combo" ? s["type"] : undefined,
      status: str(s["status"]),
      category: str(s["category"]),
    }),
  component: function CourseMasterPage() {
    const search = Route.useSearch();
    const navigate = Route.useNavigate();
    return <CourseMaster search={search} onSearch={(next) => void navigate({ search: next })} />;
  },
});
