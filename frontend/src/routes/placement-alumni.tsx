import { createFileRoute } from "@tanstack/react-router";
import { PlacementPage } from "@/features/operations/placement-page";

export const Route = createFileRoute("/placement-alumni")({
  component: PlacementPage,
});
