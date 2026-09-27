import { useQuery } from "@tanstack/react-query";
import { get, list, post, put, type Query } from "./client";
import type { BranchRef, CourseRef, DateOnly, DateTime, Money, PersonRef } from "./types";
import type { CorrectionRequest, PaymentRow } from "./payments";

export type InvoiceCompletion = "Unpaid" | "Part Paid" | "Paid";

export type InvoiceRow = {
  invoice_id: number;
  invoice_number: string;
  status: "Issued" | "Superseded" | "Cancelled";
  billed_amount: Money;
  person: PersonRef;
  lead_id: number | null;
  lead_code: string | null;
  course: CourseRef | null;
  collecting_branch: BranchRef;
  payment_plan: { plan_code: string; plan_name: string } | null;
  issued_on: DateOnly;
  admission_id: number | null;
  verified_paid: Money;
  pending_verification: Money;
  waived: Money;
  outstanding: Money;
  payment_completion: InvoiceCompletion;
  invoice_state: string;
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

export type InvoiceDetail = InvoiceRow & {
  fee_discussion_id: number | null;
  fee_version_id: number | null;
  standard_fee: Money | null;
  terms: string | null;
  day0_date: DateOnly | null;
  agreed_due_days: number[] | null;
  superseded_by_invoice_id: number | null;
  cancel_reason: string | null;
  original_billed_amount: Money | null;
  revised_at: DateTime | null;
  issued_by: number | null;
  created_at: DateTime;
  schedule: ScheduleRow[];
  payments: PaymentRow[];
  correction_requests: CorrectionRequest[];
};

export type AdmissionReadiness = {
  invoice_id: number;
  ready: boolean;
  checks: { check: string; ok: boolean; detail: string }[];
  missing: string[];
  admission_id: number | null;
};

export type PrintableInvoice = {
  document: string;
  invoice_number: string;
  issued_on: DateOnly;
  branch: { name: string; address: string | null; phone: string | null; email: string | null };
  bill_to: PersonRef & { email?: string | null };
  course: CourseRef | null;
  standard_fee: Money | null;
  billed_amount: Money;
  terms: string | null;
  plan: string | null;
  schedule: { installment_no: number; due_date: DateOnly; amount_due: Money }[];
  balance: { verified_paid: Money; outstanding: Money };
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
