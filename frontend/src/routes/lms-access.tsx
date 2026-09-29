import { createFileRoute } from "@tanstack/react-router";
import { compact, num, str } from "@/features/academics/shared";
import { LmsAccessPage, type LmsSearch } from "@/features/workspace/lms-access";

export const Route = createFileRoute("/lms-access")({
  validateSearch: (s: Record<string, unknown>): LmsSearch =>
    compact({
      page: num(s["page"]),
      q: str(s["q"]),
      lms_status: str(s["lms_status"]),
      curriculum_status: str(s["curriculum_status"]),
      enrolment_status: str(s["enrolment_status"]),
    }),
  component: LmsAccessRoute,
});

function LmsAccessRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return <LmsAccessPage search={search} onSearch={(next) => void navigate({ search: compact(next) })} />;
}
