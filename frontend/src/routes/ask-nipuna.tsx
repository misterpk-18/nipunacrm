import { createFileRoute } from "@tanstack/react-router";
import { AskNipunaPage } from "@/features/management/ai";

export const Route = createFileRoute("/ask-nipuna")({
  component: () => <AskNipunaPage />,
});
