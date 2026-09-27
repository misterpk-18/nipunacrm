import { createFileRoute } from "@tanstack/react-router";
import { COMM_QUEUES, MATCH_STATUSES, SLA_STATES } from "@/api/communications";
import { CommunicationsPage, type CommSearch } from "@/features/operations/communications-page";

const num = (v: unknown) => (v === undefined || v === "" || Number.isNaN(Number(v)) ? undefined : Number(v));
const oneOf = (v: unknown, options: readonly string[]) => (typeof v === "string" && options.includes(v) ? v : undefined);

export const Route = createFileRoute("/communications")({
  validateSearch: (s: Record<string, unknown>): CommSearch => {
    const out: CommSearch = {
      queue: oneOf(s["queue"], COMM_QUEUES),
      sla_state: oneOf(s["sla_state"], SLA_STATES),
      match_status: oneOf(s["match_status"], MATCH_STATUSES),
      page: num(s["page"]),
    };
    return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined)) as CommSearch;
  },
  component: CommunicationsRoute,
});

function CommunicationsRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return <CommunicationsPage search={search} onSearch={(next) => void navigate({ search: next })} />;
}
