/** Branch-aware role checks mirroring the academics / admissions service rules (the server still enforces). */
import { useAuth } from "@/auth/auth";
import type { RoleCode } from "@/api/types";

export function useCan() {
  const { profile, isAdmin } = useAuth();
  const scopes = profile?.scopes ?? [];
  const userId = profile?.user.user_id;
  /** Holds any of the roles at this branch (or company-wide). */
  const at = (branchId: number | null | undefined, ...roles: RoleCode[]) =>
    scopes.some((s) => roles.includes(s.role_code) && (s.branch_id === null || branchId == null || s.branch_id === branchId));
  const manager = (branchId: number | null | undefined) => isAdmin || at(branchId, "BRANCH_MANAGER");
  return {
    isAdmin,
    userId,
    at,
    manager,
    /** Create admission / complimentary / fee-change request (counsellor or manager). */
    sell: (branchId: number | null | undefined) => manager(branchId) || at(branchId, "SALES", "FRONT_OFFICE"),
    /** Batches, allocation (Academic Coordinator or Branch Manager). */
    academic: (branchId: number | null | undefined) => manager(branchId) || at(branchId, "ACADEMIC_COORDINATOR"),
    /** Curriculum mapping, completion, certificates, closing allocations. */
    coordinator: (branchId: number | null | undefined) => isAdmin || at(branchId, "ACADEMIC_COORDINATOR"),
  };
}
