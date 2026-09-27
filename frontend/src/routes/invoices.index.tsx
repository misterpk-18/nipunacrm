import { createFileRoute } from "@tanstack/react-router";
import { InvoicesList, type InvoiceSearch } from "@/features/finance/invoices-list";

const num = (v: unknown) => (v === undefined || v === "" || Number.isNaN(Number(v)) ? undefined : Number(v));
const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);

export const Route = createFileRoute("/invoices/")({
  validateSearch: (s: Record<string, unknown>): InvoiceSearch => {
    const out: InvoiceSearch = { page: num(s["page"]), q: str(s["q"]), status: str(s["status"]), completion: str(s["completion"]) };
    return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined)) as InvoiceSearch;
  },
  component: InvoicesPage,
});

function InvoicesPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return <InvoicesList search={search} onSearch={(next) => void navigate({ search: next })} />;
}
