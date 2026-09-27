import { createFileRoute } from "@tanstack/react-router";
import { NewAdmission } from "@/features/academics/new-admission";
import { compact, num } from "@/features/academics/shared";

export const Route = createFileRoute("/admissions/new")({
  validateSearch: (s: Record<string, unknown>): { invoiceId?: number } => compact({ invoiceId: num(s["invoiceId"]) }),
  component: function NewAdmissionPage() {
    const { invoiceId } = Route.useSearch();
    return <NewAdmission key={invoiceId ?? 0} invoiceId={invoiceId} />;
  },
});
