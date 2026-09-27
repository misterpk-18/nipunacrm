import { get, list, post, type Query } from "./client";
import type { DateOnly, DateTime, Money, PersonRef } from "./types";
import type { ScheduleRow } from "./invoices";

export const AGE_BANDS = ["1–3", "4–7", "8–15", "16–30", "31–60", "61–90", "91+"] as const;
export const DUE_POSITIONS = ["Overdue", "Due Today", "Upcoming"] as const;

export type DueInstallment = ScheduleRow & {
  invoice_id: number;
  invoice_number: string;
  admission_id: number | null;
  person: PersonRef;
  collecting_branch_id: number;
};

export type DuePlan = {
  invoice: { invoice_id: number; invoice_number: string; status: string; billed_amount: Money };
  person: PersonRef;
  admission_id: number | null;
  collecting_branch_id: number;
  plan: string;
  balance: Money;
  next_due_date: DateOnly;
  max_days_overdue: number | null;
  contact_hold: boolean;
  installments: DueInstallment[];
};

export type Ageing = Record<string, { installments: number; balance: Money | number }>;

export type PaymentPromise = {
  promise_id: number;
  admission_id: number;
  admission_code: string;
  promised_amount: Money;
  promised_date: DateOnly;
  status: "Pending" | "Kept" | "Broken" | "Cancelled";
  notes: string | null;
  recorded_by: number | null;
  recorded_at: DateTime;
  resolved_at: DateTime | null;
};

export type PaymentPlan = {
  payment_plan_id: number;
  plan_code: string;
  plan_name: string;
  description: string | null;
  is_active: boolean;
  installments: { installment_no: number; percent_of_fee: string; due_days_after_admission: number; due_days_min: number; due_days_max: number }[];
};

export type DuesFilters = {
  page?: number;
  per_page?: number;
  position?: string;
  age_band?: string;
  plan_code?: string;
  branch_id?: number;
  person_id?: number;
  contact_hold?: boolean;
};

export const collectionsApi = {
  dues: (filters: DuesFilters) => list<DuePlan>("/collections/dues", filters as Query),
  ageing: (filters: Omit<DuesFilters, "position" | "page" | "per_page">) => get<Ageing>("/collections/ageing", filters as Query),
  promises: (admissionId: number) => get<PaymentPromise[]>(`/admissions/${admissionId}/promises`),
  addPromise: (admissionId: number, body: { promised_amount: Money; promised_date: DateOnly; notes?: string | null }) =>
    post<PaymentPromise>(`/admissions/${admissionId}/promises`, body),
  resolvePromise: (promiseId: number, status: "kept" | "broken" | "cancel") => post<PaymentPromise>(`/payment-promises/${promiseId}/${status}`),
  plans: () => get<PaymentPlan[]>("/payment-plans"),
};

export const collectionKeys = {
  all: ["collections"] as const,
  dues: (filters: DuesFilters) => ["collections", "dues", filters] as const,
  ageing: (filters: object) => ["collections", "ageing", filters] as const,
  promises: (admissionId: number) => ["collections", "promises", admissionId] as const,
  plans: ["payment-plans"] as const,
};
