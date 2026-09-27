import { createFileRoute } from "@tanstack/react-router";
import { DemosPage, type DemoSearch } from "@/features/sales/demos-page";
import { compact, num, str } from "@/features/sales/shared";

const isDate = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);

export const Route = createFileRoute("/demos")({
  validateSearch: (s: Record<string, unknown>): DemoSearch =>
    compact({ from: isDate(s["from"]), to: isDate(s["to"]), status: str(s["status"]), trainer_id: num(s["trainer_id"]), page: num(s["page"]) }),
  component: DemosRoute,
});

function DemosRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return <DemosPage search={search} onSearch={(next) => void navigate({ search: compact(next) })} />;
}
