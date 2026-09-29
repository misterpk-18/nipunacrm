import { createFileRoute } from "@tanstack/react-router";
import { WorkflowGuidePage } from "@/features/workspace/workflow-guide";

export const Route = createFileRoute("/workflow-guide")({
  component: WorkflowGuidePage,
});
