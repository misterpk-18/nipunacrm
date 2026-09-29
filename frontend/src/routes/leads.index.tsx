import { createFileRoute } from "@tanstack/react-router";
import { LeadsList, type LeadSearch } from "@/features/leads/leads-list";

const num = (v: unknown) => (v === undefined || v === "" || Number.isNaN(Number(v)) ? undefined : Number(v));
const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);

export const Route = createFileRoute("/leads/")({
  validateSearch: (s: Record<string, unknown>): LeadSearch => {
    const out: LeadSearch = {
      page: num(s["page"]),
      q: str(s["q"]),
      lead_status: str(s["lead_status"]),
      stage: str(s["stage"]),
      course_id: num(s["course_id"]),
      source_id: num(s["source_id"]),
      intake_status: str(s["intake_status"]),
      priority: str(s["priority"]),
      queue: str(s["queue"]),
      assigned_to: str(s["assigned_to"]) ?? (typeof s["assigned_to"] === "number" ? String(s["assigned_to"]) : undefined),
    };
    return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined)) as LeadSearch;
  },
  component: LeadsPage,
});

function LeadsPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return <LeadsList search={search} onSearch={(next) => void navigate({ search: next })} />;
}
