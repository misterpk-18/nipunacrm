import { createFileRoute } from "@tanstack/react-router";
import { MorePage } from "@/features/management/more";

export const Route = createFileRoute("/more")({
  component: MorePage,
});
