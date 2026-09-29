import { useQuery } from "@tanstack/react-query";
import { get, list, type Query } from "./client";
import type { AdmissionRow } from "./admissions";
import type { LeadRow, Person } from "./leads";
import type { PipelineCard } from "./pipeline";
import type { BranchRef, DateTime } from "./types";

type LeadRef = { lead_id: number; lead_code: string; branch_code: string; course_code: string | null; stage: string };

/** Persons list row: the person, their Active leads and open pipeline cards at the user's branches. */
export type PersonRow = Person & {
  leads_count: number;
  active_leads: LeadRef[];
  open_cards: { pipeline_entry_id: number; entry_code: string; stage: string; branch: BranchRef }[];
};

export type PersonOverview = {
  person: Person;
  pipeline_cards: (PipelineCard & { is_open: boolean; closed_at: DateTime | null })[];
  leads: LeadRow[];
  admissions: AdmissionRow[];
};

export type PersonFilters = { q?: string; branch_id?: number; page?: number; per_page?: number };

export const personsApi = {
  list: (filters: PersonFilters) => list<PersonRow>("/persons", filters as Query),
  overview: (id: number) => get<PersonOverview>(`/persons/${id}/overview`),
};

export const personKeys = {
  all: ["persons"] as const,
  list: (filters: PersonFilters) => ["persons", "list", filters] as const,
  overview: (id: number) => ["persons", "overview", id] as const,
};

export const usePersonOverview = (id: number) => useQuery({ queryKey: personKeys.overview(id), queryFn: () => personsApi.overview(id) });
