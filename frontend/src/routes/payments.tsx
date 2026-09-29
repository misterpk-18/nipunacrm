import { createFileRoute } from "@tanstack/react-router";
import { PaymentsPage, type PaymentSearch } from "@/features/finance/payments-page";

const num = (v: unknown) => (v === undefined || v === "" || Number.isNaN(Number(v)) ? undefined : Number(v));
const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);
const TABS = ["ledger", "record", "unallocated", "corrections"] as const;

export const Route = createFileRoute("/payments")({
  validateSearch: (s: Record<string, unknown>): PaymentSearch => {
    const tab = str(s["tab"]);
    const out: PaymentSearch = {
      page: num(s["page"]),
      q: str(s["q"]),
      status: str(s["status"]),
      entry_type: str(s["entry_type"]),
      payment_mode_id: num(s["payment_mode_id"]),
      from: str(s["from"]),
      to: str(s["to"]),
      tab: TABS.includes(tab as (typeof TABS)[number]) ? (tab as PaymentSearch["tab"]) : undefined,
      cstatus: str(s["cstatus"]),
      invoice: num(s["invoice"]),
    };
    return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined)) as PaymentSearch;
  },
  component: PaymentsRoute,
});

function PaymentsRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return <PaymentsPage search={search} onSearch={(next) => void navigate({ search: next })} />;
}
