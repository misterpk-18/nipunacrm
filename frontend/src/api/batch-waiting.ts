import { useQuery } from "@tanstack/react-query";
import { list, type Query } from "./client";
import type { BranchRef, CourseRef, DateOnly, DateTime, PersonRef } from "./types";

/** Which alert stage the wait has reached: first alert → Branch Manager escalation → Founder / Super Admin. */
export type DelayStage = "coordinator" | "manager" | "founder";

export type WaitingRow = {
  admission_id: number;
  admission_code: string;
  person: PersonRef;
  lead_id: number | null;
  course: CourseRef;
  service_branch: BranchRef;
  admission_date: DateOnly;
  /** Working days of the service branch since the admission date. */
  days_waiting: number;
  seat_type: string;
  planned_start_date: DateOnly | null;
  /** The counsellor's preferred LMS batch: a wish only, the Branch Manager allocates in the LMS. */
  preferred_batch: { code: string; label: string | null } | null;
  allocate_by: DateTime;
  delay: DelayStage | null;
  /** Deep link into the LMS's allocation screen; null until LMS_WEB_URL is set on the server. */
  lms_url: string | null;
};

export type WaitingFilters = { page?: number; per_page?: number; branch_id?: number; course_id?: number; seat_type?: string; q?: string };

export const waitingApi = {
  list: (filters: WaitingFilters) => list<WaitingRow>("/batch-waiting", filters as Query),
};

export const waitingKeys = {
  list: (filters: WaitingFilters) => ["admissions", "batch-waiting", filters] as const,
};

/** Keys sit under ["admissions"] so any admission change (or an LMS refresh) updates this screen too. */
export const useWaitingForBatch = (filters: WaitingFilters, enabled = true) =>
  useQuery({ queryKey: waitingKeys.list(filters), queryFn: () => waitingApi.list(filters), placeholderData: (prev) => prev, enabled });
