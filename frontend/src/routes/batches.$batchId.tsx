import { createFileRoute } from "@tanstack/react-router";
import { BatchDetailView } from "@/features/academics/batch-detail";

export const Route = createFileRoute("/batches/$batchId")({
  component: function BatchPage() {
    const { batchId } = Route.useParams();
    return <BatchDetailView key={batchId} batchId={Number(batchId)} />;
  },
});
