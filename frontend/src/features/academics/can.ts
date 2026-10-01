/** Branch-aware role checks mirroring the academics / admissions service rules (the server still enforces). */
import { useAuth } from "@/auth/auth";
import { useLmsSyncStatus } from "@/api/lms";
import type { RoleCode } from "@/api/types";

export function useCan() {
  const { profile, isAdmin } = useAuth();
  const scopes = profile?.scopes ?? [];
  const userId = profile?.user.user_id;
  /** Holds any of the roles at this branch (or company-wide). */
  const at = (branchId: number | null | undefined, ...roles: RoleCode[]) =>
    scopes.some((s) => roles.includes(s.role_code) && (s.branch_id === null || branchId == null || s.branch_id === branchId));
  const manager = (branchId: number | null | undefined) => isAdmin || at(branchId, "BRANCH_MANAGER");
  /** Academic work happens in the LMS and is mirrored here (assumed until the status loads, so no button flashes). */
  const lmsOwned = useLmsSyncStatus().data?.academics_managed_in_lms ?? true;
  return {
    isAdmin,
    userId,
    at,
    manager,
    lmsOwned,
    /** Create admission / complimentary / fee-change request (counsellor or manager). */
    sell: (branchId: number | null | undefined) => manager(branchId) || at(branchId, "SALES", "FRONT_OFFICE"),
    /** Batches, allocation (Academic Coordinator or Branch Manager). */
    academic: (branchId: number | null | undefined) => !lmsOwned && (manager(branchId) || at(branchId, "ACADEMIC_COORDINATOR")),
    /** Curriculum mapping, completion, certificates, closing allocations. */
    coordinator: (branchId: number | null | undefined) => !lmsOwned && (isAdmin || at(branchId, "ACADEMIC_COORDINATOR")),
    /** Recording a joining date (coordinator or trainer), while the CRM owns academics. */
    joining: (branchId: number | null | undefined) => !lmsOwned && (isAdmin || at(branchId, "ACADEMIC_COORDINATOR", "TRAINER")),
  };
}
