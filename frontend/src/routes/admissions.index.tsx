import { createFileRoute } from "@tanstack/react-router";
import { AdmissionsList, type AdmissionSearch } from "@/features/academics/admissions-list";
import { compact, num, str } from "@/features/academics/shared";

export const Route = createFileRoute("/admissions/")({
  validateSearch: (s: Record<string, unknown>): AdmissionSearch =>
    compact({
      page: num(s["page"]),
      q: str(s["q"]),
      enrolment_status: str(s["enrolment_status"]),
      curriculum_status: str(s["curriculum_status"]),
      payment_completion: str(s["payment_completion"]),
      seat_type: str(s["seat_type"]),
      course_id: num(s["course_id"]),
      admission: num(s["admission"]),
    }),
  component: AdmissionsPage,
});

function AdmissionsPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return <AdmissionsList search={search} onSearch={(next) => void navigate({ search: next })} />;
}
