/** Fee discussions, frozen versions, the accepted delivery plan, special closing requests (SCR), and the
 *  read-only masters used by their pickers (offers, payment plans, concession limits). */
import { get, list, post, type Query } from "./client";
import type { BranchRef, CourseRef, DateOnly, DateTime, Money, PersonRef, UserRef } from "./types";

export type FeeLeadRef = { lead_id: number; lead_code: string; branch_code: string; course_code: string | null; stage: string };

export type ScrSummary = { scr_id: number; scr_code: string; status: string; requested_extra: Money; counter_extra: Money | null };

export type VersionInstallment = { installment_no: number; due_date: DateOnly; amount: Money };

export type FeeVersion = {
  version_id: number;
  fee_discussion_id: number;
  version_no: number;
  status: string;
  standard_fee: Money;
  offer: { offer_id: number; offer_code: string; offer_name: string } | null;
  offer_discount: Money;
  extra_concession: Money;
  final_payable: Money;
  minimum_floor: Money;
  below_floor: boolean;
  needs_special_closing: boolean;
  payment_plan: { payment_plan_id: number; plan_code: string; plan_name: string };
  /** The payment schedule saved with the version: a due date and amount per instalment. */
  installments: VersionInstallment[];
  valid_until: DateOnly;
  notes: string | null;
  special_closing_requests: ScrSummary[];
  created_by: number;
  created_at: DateTime;
};

export type Offer = {
  offer_id: number;
  offer_code: string;
  version: number;
  offer_name: string;
  description: string | null;
  status: string;
  benefit_type: string;
  discount_amount: Money | null;
  discount_percent: string | null;
  valid_from: DateOnly;
  valid_to: DateOnly;
};

export type FeeDiscussion = {
  fee_discussion_id: number;
  discussion_code: string;
  milestone: string;
  lead: FeeLeadRef;
  person: PersonRef & { email?: string | null };
  course: CourseRef & { standard_fee: Money };
  branch: BranchRef;
  counsellor: UserRef | null;
  fee_shared_at: DateTime | null;
  current_version: FeeVersion | null;
  versions: FeeVersion[];
  created_at: DateTime;
  applicable_offers?: Offer[];
  /** Offers this person has already used — each offer can be used only once per person. */
  used_offers?: UsedOffer[];
};

export type UsedOffer = { offer_code: string; admission_id: number; admission_code: string; used_as: string };

export type SpecialClosingRequest = ScrSummary & {
  version_id: number;
  version_no: number;
  fee_discussion: { fee_discussion_id: number; discussion_code: string; milestone: string };
  lead: FeeLeadRef;
  person: PersonRef;
  branch: BranchRef;
  standard_fee: Money;
  final_payable: Money;
  minimum_floor: Money;
  below_floor: boolean;
  request_reason: string;
  requested_by: UserRef | null;
  requested_at: DateTime;
  decision_due_at: DateTime | null;
  decided_by: UserRef | null;
  decided_at: DateTime | null;
  decision_reason: string | null;
  independent_approved_by: number | null;
  independent_approved_at: DateTime | null;
};

export type PaymentPlan = {
  payment_plan_id: number;
  plan_code: string;
  plan_name: string;
  description: string | null;
  is_active: boolean;
  installments: { installment_no: number; percent_of_fee: string; due_days_after_admission: number; due_days_min: number; due_days_max: number }[];
};

export type ConcessionLimit = { role_code: string; role_name: string; max_percent: string | null; max_amount: Money | null; unlimited: boolean };

export type LeadInvoice = {
  invoice_id: number;
  invoice_number: string;
  status: string;
  billed_amount: Money;
  courses: { invoice_line_id: number; course: CourseRef }[];
  issued_on: DateOnly;
  payment_plan: { plan_code: string; plan_name: string } | null;
};

export type ScrFilters = { queue?: "can_approve" | "higher_approval" | "all"; status?: string; branch_id?: number; page?: number; per_page?: number };

export const DELIVERY_MODES = ["Classroom", "Online", "Hybrid"];
export const SEAT_TYPES = ["Confirmed Seat", "Future Plan"];
export const OPEN_VERSION_STATUSES = ["Discussion Saved", "Counteroffered", "Pending Approval"];
export const SCR_STATUSES = ["Pending", "Approved", "Counteroffered", "Rejected", "Withdrawn", "Expired"];
export const CLOSED_MILESTONES = ["Converted", "Expired", "Cancelled"];

export const feesApi = {
  listForLead: (leadId: number) => get<FeeDiscussion[]>(`/leads/${leadId}/fee-discussions`),
  start: (leadId: number, body: { course_id?: number | null; counsellor_id?: number | null }) =>
    post<FeeDiscussion>(`/leads/${leadId}/fee-discussions`, body),
  get: (id: number) => get<FeeDiscussion>(`/fee-discussions/${id}`),
  addVersion: (
    id: number,
    body: {
      offer_id?: number | null;
      extra_concession?: Money;
      payment_plan_id?: number;
      valid_until?: DateOnly | null;
      notes?: string | null;
    },
  ) => post<FeeVersion>(`/fee-discussions/${id}/versions`, body),
  share: (id: number) => post<FeeDiscussion>(`/fee-discussions/${id}/share`),
  approveVersion: (versionId: number) => post<FeeVersion>(`/fee-discussion-versions/${versionId}/approve`),
  requestSpecialClosing: (versionId: number, body: { requested_extra?: Money; request_reason: string }) =>
    post<SpecialClosingRequest>(`/fee-discussion-versions/${versionId}/special-closing-requests`, body),

  listScr: (filters: ScrFilters) => list<SpecialClosingRequest>("/special-closing-requests", filters as Query),
  getScr: (id: number) => get<SpecialClosingRequest>(`/special-closing-requests/${id}`),
  approveScr: (id: number, body: { independent_approved_by?: number | null; decision_reason?: string | null }) =>
    post<SpecialClosingRequest>(`/special-closing-requests/${id}/approve`, body),
  counterofferScr: (id: number, body: { counter_extra: Money; decision_reason?: string | null }) =>
    post<SpecialClosingRequest>(`/special-closing-requests/${id}/counteroffer`, body),
  rejectScr: (id: number, reason: string) => post<SpecialClosingRequest>(`/special-closing-requests/${id}/reject`, { reason }),

  /** Invoices already issued for a lead (read-only; the Invoice Register owns the rest). */
  invoicesForLead: (leadId: number) => list<LeadInvoice>("/invoices", { lead_id: leadId, per_page: 50 }).then((p) => p.data),

  // read-only masters for pickers
  offers: (status = "Active") => get<Offer[]>("/offers", { status }),
  paymentPlans: () => get<PaymentPlan[]>("/payment-plans"),
  concessionLimits: () => get<ConcessionLimit[]>("/concession-limits"),
};

export const feeKeys = {
  all: ["fee-discussions"] as const,
  forLead: (leadId: number) => ["fee-discussions", "lead", leadId] as const,
  detail: (id: number) => ["fee-discussions", "detail", id] as const,
  scr: ["special-closing-requests"] as const,
  scrList: (filters: ScrFilters) => ["special-closing-requests", "list", filters] as const,
  invoicesForLead: (leadId: number) => ["invoices", "lead", leadId] as const,
  paymentPlans: ["payment-plans"] as const,
  concessionLimits: ["concession-limits"] as const,
};
