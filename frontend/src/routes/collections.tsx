import { createFileRoute } from "@tanstack/react-router";
import { COLLECTION_TABS, CollectionsPage, type CollectionSearch } from "@/features/finance/collections-page";

const num = (v: unknown) => (v === undefined || v === "" || Number.isNaN(Number(v)) ? undefined : Number(v));
const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);

export const Route = createFileRoute("/collections")({
  validateSearch: (s: Record<string, unknown>): CollectionSearch => {
    const tab = str(s["tab"]);
    const hold = s["contact_hold"];
    const out: CollectionSearch = {
      tab: COLLECTION_TABS.includes(tab as CollectionSearch["tab"] & string) ? (tab as CollectionSearch["tab"]) : undefined,
      plan_code: str(s["plan_code"]),
      age_band: str(s["age_band"]),
      contact_hold: hold === true || hold === "true" ? true : hold === false || hold === "false" ? false : undefined,
      page: num(s["page"]),
    };
    return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined)) as CollectionSearch;
  },
  component: CollectionsRoute,
});

function CollectionsRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return <CollectionsPage search={search} onSearch={(next) => void navigate({ search: next })} />;
}
