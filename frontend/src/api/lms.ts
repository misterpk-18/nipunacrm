/** LMS access (read-only): admissions with their LMS status, from GET /admissions; the status pull's state from
 * GET /lms/sync-status (db 028). */
import { useQueries, useQuery } from "@tanstack/react-query";
import { get, list, type Query } from "./client";
import type { DateTime } from "./types";
import { LMS_STATUSES, type AdmissionFilters, type AdmissionRow } from "./admissions";

export type LmsFilters = Pick<AdmissionFilters, "page" | "per_page" | "branch_id" | "q" | "lms_status" | "curriculum_status" | "enrolment_status">;

export type LmsSyncStatus = {
  /** On: batches, allocations, joining, curriculum, completion and certificates come from the LMS (read-only here). */
  academics_managed_in_lms: boolean;
  configured: boolean;
  held: number;
  pull: {
    since: string;
    last_attempt_at: DateTime | null;
    last_success_at: DateTime | null;
    last_http_status: number | null;
    last_error: string | null;
    last_counts: Record<string, number> | null;
  };
};

export const lmsApi = {
  list: (filters: LmsFilters) => list<AdmissionRow>("/admissions", filters as Query),
  syncStatus: () => get<LmsSyncStatus>("/lms/sync-status"),
};

export const useLmsSyncStatus = () =>
  useQuery({ queryKey: ["lms", "sync-status"], queryFn: lmsApi.syncStatus, staleTime: 60_000 });

/** Keys sit under ["admissions"] so any admission change refreshes this screen too. */
export const lmsKeys = {
  list: (filters: LmsFilters) => ["admissions", "lms", filters] as const,
};

export const useLmsAccess = (filters: LmsFilters) =>
  useQuery({ queryKey: lmsKeys.list(filters), queryFn: () => lmsApi.list(filters), placeholderData: (prev) => prev });

/** Admission count per LMS status (one per_page=1 request each) for the snapshot tiles. */
export function useLmsStatusCounts(branchId: number | undefined) {
  const results = useQueries({
    queries: LMS_STATUSES.map((status) => ({
      queryKey: lmsKeys.list({ lms_status: status, branch_id: branchId, per_page: 1 }),
      queryFn: () => lmsApi.list({ lms_status: status, branch_id: branchId, per_page: 1 }),
    })),
  });
  return Object.fromEntries(LMS_STATUSES.map((s, i) => [s, results[i]?.data?.meta.total])) as Record<string, number | undefined>;
}
