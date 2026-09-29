import { useCallback } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { PersonsList, type PersonSearch } from "@/features/persons/persons-list";
import { compact, num, str } from "@/features/sales/shared";

export const Route = createFileRoute("/persons/")({
  validateSearch: (s: Record<string, unknown>): PersonSearch => compact({ q: str(s["q"]), page: num(s["page"]) }),
  component: PersonsPage,
});

function PersonsPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const onSearch = useCallback((next: PersonSearch) => void navigate({ search: compact(next), replace: true }), [navigate]);
  return <PersonsList search={search} onSearch={onSearch} />;
}
