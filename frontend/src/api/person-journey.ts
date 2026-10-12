import { useQueries } from "@tanstack/react-query";
import { get } from "./client";
import type { DateTime } from "./types";

/** Subset of GET /leads/{id}/journey (the next-step contract) that the Person 360 strip draws. */
export type JourneyStep = {
  key: string;
  label: string;
  status: "done" | "current" | "blocked" | "todo" | "skipped";
  at: DateTime | null;
  detail: string | null;
};

export type JourneyNext = { action: string; label: string; blocked: boolean; reason: string | null; role: string | null };

export type LeadJourney = {
  lead_id: number;
  course_title: string | null;
  steps: JourneyStep[];
  next: JourneyNext | null;
  after_admission: { trail: { key: string; label: string; status: "done" | "current" | "todo"; at: DateTime | null; detail: string | null }[] } | null;
};

export const journeyKeys = { lead: (leadId: number) => ["leads", "journey", leadId] as const };

/** One journey per lead (a person has one lead per course). Keys sit under ["leads"] so a deal change refreshes them. */
export function useLeadJourneys(leadIds: number[]) {
  return useQueries({
    queries: leadIds.map((id) => ({
      queryKey: journeyKeys.lead(id),
      queryFn: () => get<LeadJourney>(`/leads/${id}/journey`),
      staleTime: 15_000,
    })),
  });
}
