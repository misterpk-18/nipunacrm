import { get, list, patch, post, type Query } from "./client";
import type { BranchRef, CourseRef, DateOnly, DateTime, Money, PersonRef, UserRef } from "./types";

export const REFUND_STATUSES = ["Registered", "Under Assessment", "Decided", "Completed", "Withdrawn"] as const;
export const REFUND_DECISIONS = ["Pending", "Refund Approved", "Waiver Approved", "Rejected"] as const;
export const PAYOUT_STATUSES = ["Not Started", "Approved", "Processing", "Completed", "Failed"] as const;
export const EVIDENCE_STATUSES = ["Evidence Pending", "Evidence Complete"] as const;
export const SUPPORT_STATUSES = ["Open", "In Progress", "Waiting on Student", "Resolved", "Closed"] as const;

export type RefundCaseRow = {
  refund_case_id: number;
  case_code: string;
  admission: { admission_id: number; admission_code: string; course: CourseRef | null; enrolment_status: string };
  person: PersonRef;
  service_branch_id: number;
  status: (typeof REFUND_STATUSES)[number];
  requested_at: DateTime;
  evidence_status: string;
  refund_decision: (typeof REFUND_DECISIONS)[number];
  decision_due_at: DateTime | null;
  payout_status: (typeof PAYOUT_STATUSES)[number];
  payout_due_at: DateTime | null;
};

export type RefundCase = RefundCaseRow & {
  request_reason: string;
  request_timing: string | null;
  assessment_date: DateOnly | null;
  assessment_notes: string | null;
  approved_refund_amount: Money | null;
  approved_waiver_amount: Money | null;
  decision_reason: string | null;
  decided_by: number | null;
  decided_at: DateTime | null;
  payout_amount: Money | null;
  payout_mode_id: number | null;
  payout_reference: string | null;
  payout_executed_by: number | null;
  payout_completed_at: DateTime | null;
  payout_failure_reason: string | null;
  reconciled_by: number | null;
  reconciled_at: DateTime | null;
  receipt_payment_ids: number[];
  created_by: number | null;
};

export type SupportCase = {
  support_case_id: number;
  case_code: string;
  person: PersonRef;
  admission_id: number | null;
  branch: BranchRef | null;
  case_type: string;
  subject: string;
  description: string | null;
  status: (typeof SUPPORT_STATUSES)[number];
  owner: UserRef | null;
  refund_case_id: number | null;
  resolution_notes: string | null;
  opened_by: number | null;
  opened_at: DateTime;
  resolved_at: DateTime | null;
};

export type AdmissionOption = {
  admission_id: number;
  admission_code: string;
  course: CourseRef | null;
  person: PersonRef;
  service_branch: BranchRef;
  final_fee: Money;
  payment_completion: string;
  outstanding: Money;
};

export type RefundFilters = { page?: number; per_page?: number; branch_id?: number; status?: string; refund_decision?: string; payout_status?: string; admission_id?: number };

export const refundsApi = {
  list: (filters: RefundFilters) => list<RefundCaseRow>("/refund-cases", filters as Query),
  get: (id: number) => get<RefundCase>(`/refund-cases/${id}`),
  register: (body: { admission_id: number; request_reason: string; request_timing?: string | null; evidence_status?: string; payment_ids?: number[] }) =>
    post<RefundCase>("/refund-cases", body),
  update: (id: number, body: { assessment_date?: DateOnly | null; assessment_notes?: string | null; evidence_status?: string; request_timing?: string | null; payment_ids?: number[] }) =>
    patch<RefundCase>(`/refund-cases/${id}`, body),
  decide: (id: number, body: { decision: string; amount?: Money | null; reason?: string | null }) => post<RefundCase>(`/refund-cases/${id}/decide`, body),
  payout: (id: number, body: { status: "Processing" | "Completed" | "Failed"; payout_amount?: Money | null; payout_mode_id?: number | null; payout_reference?: string | null; failure_reason?: string | null }) =>
    post<RefundCase>(`/refund-cases/${id}/payout`, body),
  reconcile: (id: number) => post<RefundCase>(`/refund-cases/${id}/reconcile`),
  withdraw: (id: number, reason?: string) => post<RefundCase>(`/refund-cases/${id}/withdraw`, { reason: reason || null }),
  admissions: (query: { q?: string; branch_id?: number }) => list<AdmissionOption>("/admissions", { per_page: 20, ...query }),
  supportCases: (query: { page?: number; branch_id?: number; status?: string }) => list<SupportCase>("/support-cases", { per_page: 25, ...query }),
  updateSupportCase: (id: number, body: { status?: string; resolution_notes?: string | null; refund_case_id?: number | null }) =>
    patch<SupportCase>(`/support-cases/${id}`, body),
};

export const refundKeys = {
  all: ["refund-cases"] as const,
  list: (filters: RefundFilters) => ["refund-cases", "list", filters] as const,
  detail: (id: number) => ["refund-cases", "detail", id] as const,
  admissions: (query: object) => ["refund-cases", "admissions", query] as const,
  support: (query: object) => ["support-cases", query] as const,
  supportAll: ["support-cases"] as const,
};
