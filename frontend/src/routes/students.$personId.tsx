import { createFileRoute } from "@tanstack/react-router";
import { Student360 } from "@/features/academics/student-360";

export const Route = createFileRoute("/students/$personId")({
  component: function StudentPage() {
    const { personId } = Route.useParams();
    return <Student360 key={personId} personId={Number(personId)} />;
  },
});
