import { createFileRoute } from "@tanstack/react-router";
import { StudentsList, type StudentSearch } from "@/features/academics/students-list";
import { compact, num, str } from "@/features/academics/shared";

export const Route = createFileRoute("/students/")({
  validateSearch: (s: Record<string, unknown>): StudentSearch =>
    compact({ page: num(s["page"]), q: str(s["q"]), enrolment_status: str(s["enrolment_status"]), lms_status: str(s["lms_status"]) }),
  component: function StudentsPage() {
    const search = Route.useSearch();
    const navigate = Route.useNavigate();
    return <StudentsList search={search} onSearch={(next) => void navigate({ search: next })} />;
  },
});
