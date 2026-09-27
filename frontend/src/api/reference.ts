/** Reference data used by dropdowns everywhere: lookups, branches, roles, courses, staff. Cached for the session. */
import { useQuery } from "@tanstack/react-query";
import { get, list } from "./client";
import type { BranchRef, Lookup, Money, RoleCode } from "./types";

export type Lookups = {
  lead_sources: Lookup[];
  contact_channels: Lookup[];
  entry_methods: Lookup[];
  payment_modes: (Lookup & { requires_reference: boolean; requires_approval: boolean })[];
  lost_reasons: Lookup[];
  task_types: Lookup[];
  document_types: (Lookup & { is_mandatory: boolean })[];
  support_case_types: Lookup[];
  enums: Record<string, string[]>;
};

export type Branch = BranchRef & {
  city: string | null;
  receipt_prefix: string;
  address: string | null;
  phone: string | null;
  email: string | null;
  is_active: boolean;
};

export type Role = { role_id: number; role_code: RoleCode; role_name: string };

export type CourseSummary = {
  course_id: number;
  course_code: string;
  course_title: string;
  category: string;
  standard_fee: Money;
  is_combo: boolean;
  status: string;
  branches: string[];
};

export type StaffMember = {
  user_id: number;
  full_name: string;
  roles: { role_code: RoleCode; role_name: string; branch_id: number | null; branch_code: string | null }[];
};

const forever = { staleTime: Infinity, gcTime: Infinity };

export const referenceApi = {
  lookups: () => get<Lookups>("/lookups"),
  branches: () => get<Branch[]>("/branches"),
  roles: () => get<Role[]>("/roles"),
  courses: () => list<CourseSummary>("/courses", { per_page: 100, status: "Active" }).then((p) => p.data),
  staff: (branchId?: number, roles?: RoleCode[]) =>
    get<StaffMember[]>("/staff", { branch_id: branchId, role: roles?.join(",") }),
};

export const useLookups = () => useQuery({ queryKey: ["lookups"], queryFn: referenceApi.lookups, ...forever });
export const useBranches = () => useQuery({ queryKey: ["branches"], queryFn: referenceApi.branches, ...forever });
export const useRoles = () => useQuery({ queryKey: ["roles"], queryFn: referenceApi.roles, ...forever });
export const useCourses = () => useQuery({ queryKey: ["courses", "active"], queryFn: referenceApi.courses, staleTime: 10 * 60_000 });

/** Staff picker data, e.g. useStaff(branchId, ["SALES", "FRONT_OFFICE", "BRANCH_MANAGER"]) for lead owners. */
export const useStaff = (branchId?: number, roles?: RoleCode[], enabled = true) =>
  useQuery({
    queryKey: ["staff", branchId ?? null, roles?.join(",") ?? ""],
    queryFn: () => referenceApi.staff(branchId, roles),
    staleTime: 5 * 60_000,
    enabled,
  });

export const LEAD_OWNER_ROLES: RoleCode[] = ["SALES", "FRONT_OFFICE", "BRANCH_MANAGER"];
