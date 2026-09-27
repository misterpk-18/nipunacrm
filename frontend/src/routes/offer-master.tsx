import { createFileRoute } from "@tanstack/react-router";
import { OfferMasterPage } from "@/features/management/offers";

export const Route = createFileRoute("/offer-master")({
  component: OfferMasterPage,
});
