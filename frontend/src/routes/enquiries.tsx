import { useCallback } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { EnquiriesList, type EnquirySearch } from "@/features/leads/enquiries-list";
import { compact, num, str } from "@/features/sales/shared";

export const Route = createFileRoute("/enquiries")({
  validateSearch: (s: Record<string, unknown>): EnquirySearch => compact({ tab: str(s["tab"]), q: str(s["q"]), page: num(s["page"]) }),
  component: EnquiriesPage,
});

function EnquiriesPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const onSearch = useCallback((next: EnquirySearch) => void navigate({ search: compact(next), replace: true }), [navigate]);
  return <EnquiriesList search={search} onSearch={onSearch} />;
}
