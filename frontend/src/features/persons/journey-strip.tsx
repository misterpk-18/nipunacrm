import { Link } from "@tanstack/react-router";
import { AlertTriangle, Check, Circle } from "lucide-react";
import { useLeadJourneys, type JourneyStep, type LeadJourney } from "@/api/person-journey";
import type { PersonOverview } from "@/api/persons";
import { Empty, Section } from "@/components/crm/ui";
import { date } from "@/lib/format";
import { cn } from "@/lib/utils";

/** The seven milestones shown per course, and the journey step each one reads (the full journey has eleven). */
const MILESTONES: { label: string; key: string }[] = [
  { label: "Lead", key: "capture" },
  { label: "Deal", key: "convert" },
  { label: "Plan", key: "plan" },
  { label: "Invoice", key: "invoice" },
  { label: "Paid", key: "verify" },
  { label: "Admitted", key: "admission" },
  { label: "Batch", key: "batch" },
];

/** Person 360 journey strip: one row per course, Lead → Deal → Plan → Invoice → Paid → Admitted → Batch. */
export function JourneyStrip({ leads }: { leads: PersonOverview["leads"] }) {
  const journeys = useLeadJourneys(leads.map((l) => l.lead_id));
  return (
    <Section title="Journey" subtitle="Where each course stands, from enquiry to batch. The highlighted step is next.">
      {leads.length === 0 ? (
        <Empty title="No courses yet" />
      ) : (
        <ul className="space-y-3">
          {leads.map((lead, i) => {
            const q = journeys[i];
            return (
              <li key={lead.lead_id} className="rounded-md border p-3">
                <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <Link to="/leads/$leadId" params={{ leadId: String(lead.lead_id) }} className="text-sm font-semibold text-primary">
                    {lead.course?.course_title ?? "No course yet"}
                  </Link>
                  <small className="text-muted-foreground">
                    {lead.lead_code} · {lead.branch.branch_name}
                  </small>
                </div>
                {q?.isLoading ? (
                  <p className="text-xs text-muted-foreground" aria-busy="true">Loading journey…</p>
                ) : q?.data ? (
                  <Strip journey={q.data} />
                ) : (
                  <p className="text-xs text-muted-foreground">Journey not available for this course.</p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

function Strip({ journey }: { journey: LeadJourney }) {
  const byKey = new Map(journey.steps.map((s) => [s.key, s]));
  const batchTrail = journey.after_admission?.trail.find((t) => t.key === "batch_allocated");
  return (
    <>
      <ol className="grid grid-cols-2 gap-1.5 sm:grid-cols-4 lg:grid-cols-7" aria-label="Journey steps">
        {MILESTONES.map((m) => {
          const step = byKey.get(m.key);
          return <Milestone key={m.key} label={m.label} step={step} detail={m.key === "batch" ? (batchTrail?.detail ?? step?.detail) : step?.detail} />;
        })}
      </ol>
      {journey.next && (
        <p className={cn("mt-2 text-xs", journey.next.blocked ? "text-destructive" : "text-muted-foreground")}>
          Next: <span className="font-medium text-foreground">{journey.next.label}</span>
          {journey.next.reason ? ` · ${journey.next.reason}` : journey.next.role ? ` · ${journey.next.role}` : ""}
        </p>
      )}
    </>
  );
}

function Milestone({ label, step, detail }: { label: string; step: JourneyStep | undefined; detail: string | null | undefined }) {
  const status = step?.status ?? "todo";
  const Icon = status === "done" ? Check : status === "blocked" ? AlertTriangle : Circle;
  return (
    <li
      aria-current={status === "current" || status === "blocked" ? "step" : undefined}
      className={cn(
        "min-w-0 rounded-md border px-2 py-1.5 text-xs",
        status === "done" && "border-primary/30 bg-primary/5",
        status === "current" && "border-primary bg-primary/10 ring-1 ring-primary",
        status === "blocked" && "border-destructive/60 bg-destructive/5 ring-1 ring-destructive/60",
        (status === "todo" || status === "skipped") && "border-dashed text-muted-foreground",
      )}
    >
      <div className="flex items-center gap-1 font-medium">
        <Icon className={cn("size-3.5 shrink-0", status === "done" && "text-primary", status === "blocked" && "text-destructive", status === "current" && "fill-primary text-primary")} aria-hidden />
        <span className="truncate">{label}</span>
        <span className="sr-only">{status === "done" ? "done" : status === "current" ? "next step" : status === "blocked" ? "blocked" : "not yet"}</span>
      </div>
      <div className="mt-0.5 truncate text-[11px] text-muted-foreground" title={detail ?? undefined}>
        {step?.at ? date(step.at) : status === "skipped" ? "Skipped" : "—"}
      </div>
    </li>
  );
}
