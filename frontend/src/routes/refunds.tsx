import { createFileRoute } from "@tanstack/react-router";
import { RefundsPage, type RefundSearch } from "@/features/finance/refunds-page";

const num = (v: unknown) => (v === undefined || v === "" || Number.isNaN(Number(v)) ? undefined : Number(v));
const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);

export const Route = createFileRoute("/refunds")({
  validateSearch: (s: Record<string, unknown>): RefundSearch => {
    const out: RefundSearch = {
      status: str(s["status"]),
      refund_decision: str(s["refund_decision"]),
      payout_status: str(s["payout_status"]),
      page: num(s["page"]),
      case: num(s["case"]),
      tab: s["tab"] === "support" ? "support" : undefined,
      sstatus: str(s["sstatus"]),
    };
    return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined)) as RefundSearch;
  },
  component: RefundsRoute,
});

function RefundsRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return <RefundsPage search={search} onSearch={(next) => void navigate({ search: next })} />;
}
