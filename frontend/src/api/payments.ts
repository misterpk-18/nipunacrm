import { get, list, post, upload, type Query } from "./client";
import type { BranchRef, DateOnly, DateTime, Money, PersonRef, UserRef } from "./types";

export type Verification = "Pending Verification" | "Verified" | "Failed";

export type PaymentRow = {
  payment_id: number;
  receipt_number: string;
  entry_type: "Payment" | "Reversal";
  amount: Money;
  payment_date: DateOnly;
  mode: string | null;
  reference: string | null;
  person: PersonRef;
  invoice: { invoice_id: number; invoice_number: string } | null;
  admission_id: number | null;
  collecting_branch: BranchRef;
  verification_status: Verification;
  recorded_by: UserRef | null;
  created_at: DateTime;
};

export type Payment = PaymentRow & {
  lead_id: number | null;
  verified_by: UserRef | null;
  verified_at: DateTime | null;
  failure_reason: string | null;
  reverses_payment_id: number | null;
  reversal_reason: string | null;
  reversed_by_payment_id: number | null;
  exception_approved_by: number | null;
  correction_request_id: number | null;
  proof_file_path: string | null;
  notes: string | null;
};

export type Receipt = {
  document: string;
  receipt_number: string;
  entry_type: string;
  payment_date: DateOnly;
  amount: Money;
  mode: string | null;
  reference: string | null;
  received_from: PersonRef & { email?: string | null };
  invoice_number: string | null;
  branch: { name: string; address: string | null; phone: string | null };
  verification_status: Verification;
  verified_at: DateTime | null;
};

export type UnallocatedAdvance = {
  payment_id: number;
  receipt_number: string;
  person: PersonRef;
  lead_id: number | null;
  amount: Money;
  payment_date: DateOnly;
  collecting_branch_id: number;
  verification_status: Verification;
};

export type CorrectionRequest = {
  correction_request_id: number;
  request_code: string;
  payment_id: number;
  receipt_number: string;
  invoice_id: number | null;
  collecting_branch_id: number;
  amount: Money;
  reason: string;
  status: "Pending Approval" | "Approved" | "Rejected";
  requested_by: UserRef | null;
  requested_at: DateTime;
  decided_by: UserRef | null;
  decided_at: DateTime | null;
  decision_note: string | null;
  reversal: { payment_id: number; receipt_number: string } | null;
};

export type PaymentFilters = {
  page?: number;
  per_page?: number;
  branch_id?: number;
  status?: string;
  entry_type?: string;
  invoice_id?: number;
  person_id?: number;
  admission_id?: number;
  payment_mode_id?: number;
  from?: string;
  to?: string;
  q?: string;
};

export type PaymentTotals = { verified_net: Money; pending_verification: Money };

export type NewPayment = {
  invoice_id?: number | null;
  person_id?: number | null;
  lead_id?: number | null;
  collecting_branch_id?: number | null;
  amount: Money;
  payment_mode_id: number;
  payment_date?: DateOnly | null;
  reference?: string | null;
  exception_approved_by?: number | null;
  notes?: string | null;
  split_excess?: boolean;
};

export type RecordResult = { payment: Payment; advance: Payment | null };

export const paymentsApi = {
  list: (filters: PaymentFilters) =>
    list<PaymentRow>("/payments", filters as Query).then((p) => ({ ...p, totals: (p.meta as unknown as { totals?: PaymentTotals }).totals })),
  get: (id: number) => get<Payment>(`/payments/${id}`),
  /** JSON, or multipart when a proof file is attached (the API accepts both with the same fields). */
  record: (body: NewPayment, proof?: File | null) => {
    if (!proof) return post<RecordResult>("/payments", body);
    const form = new FormData();
    for (const [key, value] of Object.entries(body)) if (value !== undefined && value !== null && value !== "") form.append(key, String(value));
    form.append("proof", proof);
    return upload<RecordResult>("/payments", form);
  },
  verify: (id: number) => post<Payment>(`/payments/${id}/verify`),
  fail: (id: number, failure_reason: string) => post<Payment>(`/payments/${id}/fail`, { failure_reason }),
  allocate: (id: number, invoice_id: number) => post<Payment>(`/payments/${id}/allocate`, { invoice_id }),
  unallocated: (query: { page?: number; person_id?: number }) => list<UnallocatedAdvance>("/payments/unallocated", { per_page: 25, ...query }),
  receipt: (id: number) => get<Receipt>(`/payments/${id}/receipt`),
  requestCorrection: (id: number, reason: string) => post<CorrectionRequest>(`/payments/${id}/correction-requests`, { reason }),
  corrections: (query: { page?: number; status?: string; invoice_id?: number }) => list<CorrectionRequest>("/correction-requests", { per_page: 25, ...query }),
  getCorrection: (id: number) => get<CorrectionRequest>(`/correction-requests/${id}`),
  approveCorrection: (id: number, decision_note?: string) => post<CorrectionRequest>(`/correction-requests/${id}/approve`, { decision_note: decision_note || null }),
  rejectCorrection: (id: number, decision_note: string) => post<CorrectionRequest>(`/correction-requests/${id}/reject`, { decision_note }),
};

export const paymentKeys = {
  all: ["payments"] as const,
  list: (filters: PaymentFilters) => ["payments", "list", filters] as const,
  detail: (id: number) => ["payments", "detail", id] as const,
  receipt: (id: number) => ["payments", "receipt", id] as const,
  unallocated: (query: object) => ["payments", "unallocated", query] as const,
  corrections: (query: object) => ["correction-requests", query] as const,
  correctionsAll: ["correction-requests"] as const,
};
