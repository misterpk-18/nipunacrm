import { useQuery } from "@tanstack/react-query";
import { get, list, patch, post, type Query } from "./client";
import type { BranchRef, CourseRef, DateOnly, DateTime, Money, PersonRef, UserRef } from "./types";

export const ENROLMENT_STATUSES = ["Awaiting Batch Allocation", "Scheduled", "In Progress", "Paused", "Completed", "Cancelled"];
/** Enrolments a Branch Manager can pause (the LMS pauses its enrolments; the pull confirms). */
export const PAUSABLE_STATUSES = ["Awaiting Batch Allocation", "Scheduled", "In Progress"];
export const CURRICULUM_STATUSES = ["Mapping Pending", "Mapped"];
export const HANDOVER_STATUSES = ["Pending", "Completed"];
export const LMS_STATUSES = ["Not Created", "Invited", "Active", "Inactive", "Completed"];
export const SEAT_TYPES = ["Confirmed Seat", "Future Plan"];
export const DELIVERY_MODES = ["Classroom", "Online", "Hybrid"];
export const PAYMENT_COMPLETION = ["Unpaid", "Part Paid", "Paid"];

export type AdmissionRow = {
  admission_id: number;
  admission_code: string;
  course: CourseRef;
  enrolment_status: string;
  person: PersonRef & { email?: string | null };
  original_branch: BranchRef;
  service_branch: BranchRef;
  seat_type: string;
  delivery_mode: string;
  final_fee: Money;
  admission_date: DateOnly;
  curriculum_status: string;
  handover_status: string;
  lms_status: string;
  complimentary_of_admission_id: number | null;
  payment_completion: string;
  outstanding: Money;
};

export type Balance = {
  final_fee: Money;
  verified_paid: Money;
  pending_verification: Money;
  waived: Money;
  refunded: Money;
  outstanding: Money;
  payment_completion: string;
};

export type Allocation = {
  allocation_id: number;
  admission_id: number;
  admission_code: string;
  batch_id: number;
  batch_code: string;
  course_id: number;
  status: string;
  joining_date: DateOnly | null;
  allocated_by: number | null;
  allocated_at: DateTime;
  ended_at: DateTime | null;
  end_reason: string | null;
  /** LMS combo track (db 028); null for a single course. */
  track_code: string | null;
  lms_mirrored: boolean;
};

export type CurriculumVersion = {
  curriculum_version_id: number;
  course: CourseRef;
  version_label: string;
  status: string;
  notes: string | null;
  published_by: number | null;
  published_at: DateTime | null;
  /** A version the LMS runs, mirrored by the status pull (db 028). */
  lms_mirrored: boolean;
  created_at: DateTime;
};

export type MappedCurriculum = CurriculumVersion & { admission_id: number; mapped_by: number | null; mapped_at: DateTime };

export type FeeChange = {
  fee_change_id: number;
  admission_id: number;
  admission_code: string;
  old_fee: Money;
  new_fee: Money;
  reason: string;
  status: string;
  requested_by: number;
  requested_at: DateTime;
  approved_by: number | null;
  approved_at: DateTime | null;
  rejection_reason: string | null;
  accounts_corrected_by: number | null;
  applied_at: DateTime | null;
};

export type Admission = AdmissionRow & {
  lead_id: number | null;
  invoice: { invoice_id: number; invoice_number: string; status: string; billed_amount: Money } | null;
  fee_version_id: number | null;
  payment_plan: { payment_plan_id: number; plan_code: string; plan_name: string } | null;
  planned_start_date: DateOnly | null;
  counsellor: UserRef | null;
  record_owner_id: number | null;
  finance_owner_id: number | null;
  academic_owner_id: number | null;
  first_qualifying_payment_id: number | null;
  first_verified_payment_at: DateTime | null;
  balance: Balance;
  offer_id: number | null;
  access_until: DateOnly | null;
  lms_last_synced_at: DateTime | null;
  lms_last_activity_at: DateTime | null;
  cancellation: { reason?: string | null; cancelled_at?: DateTime | null; cancelled_by?: number | null } | null;
  academic_completed_at: DateTime | null;
  completion_authorised_by: number | null;
  /** The LMS Academic Coordinator who decided the completion ("LMS" when the LMS didn't say). */
  completion_authorised_by_email: string | null;
  support_until: DateOnly | null;
  created_at: DateTime;
};

export type AdmissionDetail = Admission & {
  allocations: Allocation[];
  curricula: MappedCurriculum[];
  fee_changes: FeeChange[];
};

export type QueueRow = {
  admission: AdmissionRow;
  seat_type: string;
  planned_start_date: DateOnly | null;
  allocate_by: DateTime | null;
  escalate_at: DateTime | null;
};

export type Readiness = {
  invoice_id: number;
  ready: boolean;
  checks: { check: string; ok: boolean; detail: string }[];
  missing: string[];
  admission_id: number | null;
};

/** Invoice rows as returned by GET /invoices (only the fields this module reads). */
/** An invoiced course with no admission yet (New Admission review). */
export type EligibleCourse = {
  invoice_line_id: number;
  line_code: string;
  lead: { lead_id: number; lead_code: string; stage: string };
  course: CourseRef;
  billed_amount: Money;
  verified_paid: Money;
  pending_verification: Money;
  outstanding: Money;
  invoice: { invoice_id: number; invoice_number: string; status: string; billed_amount: Money };
  person: PersonRef;
  branch: BranchRef;
  delivery_plan: { plan_code: string; status: string; delivery_mode: string; seat_type: string; planned_start_date: DateOnly | null; service_branch: BranchRef } | null;
  token: Money;
  verified_total: Money;
  eligible: boolean;
  waiting_for: string[];
};

export type InvoicePick = {
  invoice_id: number;
  invoice_number: string;
  status: string;
  billed_amount: Money;
  person: PersonRef;
  lead_id: number;
  lead_code: string;
  course: CourseRef;
  collecting_branch: BranchRef;
  payment_plan: { plan_code: string; plan_name: string } | null;
  issued_on: DateOnly;
  admission_id: number | null;
  verified_paid: Money;
  pending_verification: Money;
  outstanding: Money;
  payment_completion: string;
};

export type OfferPick = {
  offer_id: number;
  offer_code: string;
  offer_name: string;
  status: string;
  complimentary_courses?: { course_id?: number; course?: CourseRef; min_final_fee?: Money }[];
};

export type AdmissionFilters = {
  page?: number;
  per_page?: number;
  branch_id?: number;
  person_id?: number;
  course_id?: number;
  enrolment_status?: string;
  curriculum_status?: string;
  handover_status?: string;
  lms_status?: string;
  seat_type?: string;
  payment_completion?: string;
  q?: string;
};

export type AdmissionUpdate = {
  handover_status?: string;
  lms_status?: string;
  delivery_mode?: string;
  planned_start_date?: DateOnly | null;
  record_owner_id?: number | null;
  finance_owner_id?: number | null;
  academic_owner_id?: number | null;
};

export const admissionsApi = {
  list: (filters: AdmissionFilters) => list<AdmissionRow>("/admissions", filters as Query),
  get: (id: number) => get<AdmissionDetail>(`/admissions/${id}`),
  create: (body: { invoice_line_id?: number; invoice_id?: number; service_branch_id?: number | null; admission_date?: DateOnly | null }) =>
    post<AdmissionDetail>("/admissions", body),
  eligibility: (query: { branch_id?: number; invoice_id?: number; q?: string; page?: number }) =>
    list<EligibleCourse>("/admissions/eligibility", { per_page: 50, ...query } as Query),
  update: (id: number, body: AdmissionUpdate) => patch<AdmissionDetail>(`/admissions/${id}`, body),
  cancel: (id: number, reason: string) => post<Admission>(`/admissions/${id}/cancel`, { reason }),
  pause: (id: number, reason: string) => post<AdmissionDetail>(`/admissions/${id}/pause`, { reason }),
  resume: (id: number) => post<AdmissionDetail>(`/admissions/${id}/resume`, {}),
  transfer: (id: number, body: { to_branch_id: number; reason: string; effective_date?: DateOnly | null }) =>
    post<Record<string, unknown>>(`/admissions/${id}/transfers`, body),
  complimentary: (id: number, body: { offer_id: number; course_id: number }) => post<Admission>(`/admissions/${id}/complimentary`, body),
  requestFeeChange: (id: number, body: { new_fee: string; reason: string }) => post<FeeChange>(`/admissions/${id}/fee-changes`, body),
  approveFeeChange: (id: number) => post<FeeChange>(`/admission-fee-changes/${id}/approve`, {}),
  rejectFeeChange: (id: number, reason: string) => post<FeeChange>(`/admission-fee-changes/${id}/reject`, { reason }),
  applyFeeChange: (id: number) => post<FeeChange>(`/admission-fee-changes/${id}/apply`, {}),
  mapCurriculum: (id: number, curriculum_version_id: number) =>
    post<AdmissionDetail>(`/admissions/${id}/curricula`, { curriculum_version_id }),
  complete: (id: number) => post<Admission>(`/admissions/${id}/complete`, {}),
  allocate: (id: number, batch_id: number) => post<Allocation>(`/admissions/${id}/allocations`, { batch_id }),
  queue: (query: { branch_id?: number; course_id?: number; page?: number; per_page?: number }) =>
    list<QueueRow>("/batch-allocation-queue", query),
  // Invoice-side reads needed by New Admission (the invoices module owns the rest).
  readiness: (invoiceId: number) => get<Readiness>(`/invoices/${invoiceId}/admission-readiness`),
  invoice: (invoiceId: number) => get<InvoicePick>(`/invoices/${invoiceId}`),
  issuedInvoices: (query: { branch_id?: number; q?: string }) =>
    list<InvoicePick>("/invoices", { ...query, status: "Issued", per_page: 100 }),
  activeOffers: () => get<OfferPick[]>("/offers", { status: "Active" }),
};

export const admissionKeys = {
  all: ["admissions"] as const,
  list: (filters: AdmissionFilters) => ["admissions", "list", filters] as const,
  detail: (id: number) => ["admissions", "detail", id] as const,
  queue: (query: Query) => ["admissions", "queue", query] as const,
  readiness: (invoiceId: number) => ["invoices", "readiness", invoiceId] as const,
};

export const useAdmission = (id: number | undefined) =>
  useQuery({ queryKey: admissionKeys.detail(id ?? 0), queryFn: () => admissionsApi.get(id!), enabled: !!id });
