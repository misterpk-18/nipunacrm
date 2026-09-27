import { createFileRoute } from "@tanstack/react-router";
import { Lead360 } from "@/features/leads/lead-360";

export const Route = createFileRoute("/leads/$leadId")({
  component: function LeadPage() {
    const { leadId } = Route.useParams();
    return <Lead360 key={leadId} leadId={Number(leadId)} />;
  },
});
