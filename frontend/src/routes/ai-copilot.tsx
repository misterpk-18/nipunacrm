import { createFileRoute } from "@tanstack/react-router";
import { AiCopilotPage } from "@/features/management/ai";

export const Route = createFileRoute("/ai-copilot")({
  component: () => <AiCopilotPage />,
});
