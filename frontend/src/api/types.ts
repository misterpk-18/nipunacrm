/** Shapes shared by many endpoints. Module-specific types live next to their calls in src/api/<module>.ts. */

/** Money is always a string with 2 decimals ("27000.00"); never do float arithmetic on it. */
export type Money = string;
/** ISO 8601 timestamp with offset. */
export type DateTime = string;
/** ISO date (YYYY-MM-DD), business dates in IST. */
export type DateOnly = string;

export type BranchRef = { branch_id: number; branch_code: string; branch_name: string };
export type UserRef = { user_id: number; full_name: string };
export type CourseRef = { course_id: number; course_code: string; course_title: string };
export type PersonRef = { person_id: number; person_code?: string; full_name: string; phone?: string };

export type RoleCode =
  | "FOUNDER_CEO"
  | "SUPER_ADMIN"
  | "BRANCH_MANAGER"
  | "SALES"
  | "FRONT_OFFICE"
  | "ACCOUNTS"
  | "ACADEMIC_COORDINATOR"
  | "TRAINER"
  | "PLACEMENT"
  | "HR"
  | "STUDENT";

export type Lookup = { id: number; code: string; label: string; sort_order: number; is_active: boolean };
