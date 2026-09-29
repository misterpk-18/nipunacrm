import { useQuery } from "@tanstack/react-query";
import { get, list, post, put, type Query } from "./client";
import type { BranchRef, CourseRef, DateOnly, DateTime, Money, PersonRef } from "./types";
import type { CorrectionRequest, PaymentRow } from "./payments";
import type { Issuer } from "./deals";

export type InvoiceCompletion = "Unpaid" | "Part Paid" | "Paid";

/** One course on an invoice (db 021). */
export type InvoiceCourse = { invoice_line_id: number; line_code: string; lead_id: number; course: CourseRef; billed_amount: Money };

export type InvoiceRow = {
  invoice_id: number;
  invoice_number: string;
  status: "Issued" | "Superseded" | "Cancelled";
  billed_amount: Money;
  person: PersonRef;
  collecting_branch: BranchRef;
  courses: InvoiceCourse[];
  payment_plan: { plan_code: string; plan_name: string; installments: number } | null;
  issued_on: DateOnly;
  verified_paid: Money;
  pending_verification: Money;
  waived: Money;
  outstanding: Money;
  payment_completion: InvoiceCompletion;
  invoice_state: string;
  admitted_lines: number;
};

export type ScheduleRow = {
  installment_id?: number;
  installment_no: number;
  due_date: DateOnly;
  amount_due: Money;
  amount_covered?: Money;
  balance?: Money;
  due_position?: string;
  days_overdue?: number | null;
  age_band?: string | null;
  contact_hold?: boolean;
};

export type InvoiceLine = {
  invoice_line_id: number;
  line_no: number;
  line_code: string;
  lead: { lead_id: number; lead_code: string; stage: string };
  course: CourseRef;
  fee_discussion_id: number;
  fee_version_id: number;
  delivery_plan_id: number | null;
  standard_fee: Money;
  billed_amount: Money;
  original_billed_amount: Money | null;
  revised_at: DateTime | null;
  verified_paid: Money;
  pending_verification: Money;
  waived: Money;
  outstanding: Money;
  open_to_allocate: Money;
  payment_completion: InvoiceCompletion;
  admission_id: number | null;
};

export type InvoiceDetail = InvoiceRow & {
  standard_fee: Money;
  terms: string | null;
  day0_date: DateOnly | null;
  issuer: Issuer;
  superseded_by_invoice_id: number | null;
  cancel_reason: string | null;
  original_billed_amount: Money | null;
  revised_at: DateTime | null;
  issued_by: number | null;
  created_at: DateTime;
  lines: InvoiceLine[];
  schedule: ScheduleRow[];
  split: string;
  payments: PaymentRow[];
  receipts: PaymentRow[];
  admissions: { admission_id: number; admission_code: string; course: CourseRef; enrolment_status: string }[];
  promises: { promise_id: number; promised_amount: Money; promised_date: DateOnly; status: string }[];
  correction_requests: CorrectionRequest[];
};

export type ReadinessCheck = { check: string; ok: boolean; detail: string; token?: Money; verified_total?: Money };
export type AdmissionReadiness = {
  invoice_id: number;
  invoice_number: string;
  ready: boolean;
  lines: {
    invoice_line_id: number;
    line_code: string;
    course: CourseRef;
    lead: { lead_id: number; lead_code: string };
    ready: boolean;
    checks: ReadinessCheck[];
    missing: string[];
    admission: { admission_id: number; admission_code: string } | null;
  }[];
};

export type PrintableInvoice = {
  document: string;
  invoice_number: string;
  issued_on: DateOnly;
  status: string;
  payment_status: string;
  issuer: Issuer;
  bill_to: PersonRef & { email?: string | null };
  lines: { line_no: number; line_code: string; course: CourseRef; lead_code: string; standard_fee: Money; billed_amount: Money }[];
  terms: string | null;
  plan: { plan_name: string; split: string };
  totals: { standard_fee: Money; billed_amount: Money; discount: Money; verified_paid: Money; pending_verification: Money; waived: Money; balance_due: Money };
  installments: { installment_no: number; due_date: DateOnly; amount_due: Money; due_position: string | null; balance: Money | null }[];
  receipts: { receipt_number: string; transaction_number: string; payment_date: DateOnly; verified_at: DateTime | null; amount: Money; entry_type: string; mode: string | null }[];
};

export type InvoiceTotals = { billed: Money; verified_paid: Money; pending_verification: Money; outstanding: Money };

export type InvoiceFilters = {
  page?: number;
  per_page?: number;
  branch_id?: number;
  status?: string;
  completion?: string;
  person_id?: number;
  lead_id?: number;
  outstanding?: boolean;
  q?: string;
};

export const invoicesApi = {
  list: (filters: InvoiceFilters) =>
    list<InvoiceRow>("/invoices", filters as Query).then((p) => ({ ...p, totals: (p.meta as unknown as { totals?: InvoiceTotals }).totals })),
  get: (id: number) => get<InvoiceDetail>(`/invoices/${id}`),
  readiness: (id: number) => get<AdmissionReadiness>(`/invoices/${id}/admission-readiness`),
  print: (id: number) => get<PrintableInvoice>(`/invoices/${id}/print`),
  cancel: (id: number, reason: string) => post<InvoiceRow>(`/invoices/${id}/cancel`, { reason }),
  setDueDate: (id: number, installmentNo: number, due_date: DateOnly) =>
    put<{ installment_no: number; due_date: DateOnly; amount_due: Money }>(`/invoices/${id}/installments/${installmentNo}/due-date`, { due_date }),
};

export const invoiceKeys = {
  all: ["invoices"] as const,
  list: (filters: InvoiceFilters) => ["invoices", "list", filters] as const,
  detail: (id: number) => ["invoices", "detail", id] as const,
  readiness: (id: number) => ["invoices", "readiness", id] as const,
  print: (id: number) => ["invoices", "print", id] as const,
};

export const useInvoice = (id: number) => useQuery({ queryKey: invoiceKeys.detail(id), queryFn: () => invoicesApi.get(id) });
