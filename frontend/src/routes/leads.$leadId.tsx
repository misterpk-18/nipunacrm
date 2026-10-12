import { createFileRoute } from "@tanstack/react-router";
import { Lead360 } from "@/features/leads/lead-360";

/** `?action=<key>` (pipeline cards, notifications, My work) opens that next-step dialog once on load. */
export type LeadSearch = { action?: string };

export const Route = createFileRoute("/leads/$leadId")({
  validateSearch: (s: Record<string, unknown>): LeadSearch =>
    typeof s["action"] === "string" && s["action"] !== ""
      ? { action: s["action"] }
      : {},
  component: function LeadPage() {
    const { leadId } = Route.useParams();
    const { action } = Route.useSearch();
    const navigate = Route.useNavigate();
    return (
      <Lead360
        key={leadId}
        leadId={Number(leadId)}
        action={action}
        onActionHandled={() => void navigate({ search: {}, replace: true })}
      />
    );
  },
});
