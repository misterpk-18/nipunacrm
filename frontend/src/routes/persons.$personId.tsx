import { createFileRoute } from "@tanstack/react-router";
import { Person360 } from "@/features/persons/person-360";

export const Route = createFileRoute("/persons/$personId")({
  component: function PersonPage() {
    const { personId } = Route.useParams();
    return <Person360 key={personId} personId={Number(personId)} />;
  },
});
