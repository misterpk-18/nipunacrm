import { createFileRoute } from "@tanstack/react-router";
import { FeeQuotePage } from "@/features/sales/fee-discussion";

export type FeeQuoteSearch = { leadId?: number; discussionId?: number };

export const Route = createFileRoute("/fee-quote")({
  validateSearch: (s: Record<string, unknown>): FeeQuoteSearch => ({
    ...(s["leadId"] !== undefined ? { leadId: Number(s["leadId"]) } : {}),
    ...(s["discussionId"] !== undefined ? { discussionId: Number(s["discussionId"]) } : {}),
  }),
  component: FeeQuoteRoute,
});

function FeeQuoteRoute() {
  const { leadId, discussionId } = Route.useSearch();
  return <FeeQuotePage key={`${leadId ?? ""}-${discussionId ?? ""}`} leadId={leadId} discussionId={discussionId} />;
}
