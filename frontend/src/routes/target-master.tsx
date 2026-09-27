import { createFileRoute } from "@tanstack/react-router";
import { TargetMasterPage } from "@/features/management/targets";

export const Route = createFileRoute("/target-master")({
  component: TargetMasterPage,
});
