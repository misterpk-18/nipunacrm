/** A deal = one course (lead) after Convert: its delivery plan (db 020) and invoicing (db 021). */
import { get, post, put } from "./client";
import type { BranchRef, CourseRef, DateOnly, DateTime, Money, PersonRef, UserRef } from "./types";

export const CAPACITY_REVIEWS = ["Checked", "Waiting"] as const;

export type DeliveryPlan = {
  delivery_plan_id: number;
  plan_code: string;
  lead_id: number;
  status: "Draft" | "Accepted";
  service_branch: BranchRef;
  delivery_mode: string;
  seat_type: string;
  planned_start_date: DateOnly | null;
  capacity_review: "Checked" | "Waiting";
  student_accepted: boolean;
  accepted_by: UserRef | null;
  accepted_at: DateTime | null;
  notes: string | null;
  updated_at: DateTime;
};

export type DeliveryPlanState = {
  lead_id: number;
  plan: DeliveryPlan | null;
  invoice: { invoice_id: number; invoice_number: string; status: string; billed_amount: Money } | null;
  can_edit: boolean;
};

export type DeliveryPlanBody = {
  service_branch_id?: number;
  delivery_mode?: string;
  seat_type?: string;
  planned_start_date?: DateOnly | null;
  capacity_review?: string;
  notes?: string | null;
  student_accepted?: boolean;
};

export type Issuer = {
  legal_name: string | null;
  branch_code: string | null;
  branch_name: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  accent: string | null;
};

export type CourseOption = {
  lead: { lead_id: number; lead_code: string; branch_code: string; course_code: string | null; stage: string };
  course: CourseRef | null;
  standard_fee: Money | null;
  amount: Money | null;
  fee_version: { version_id: number; version_no: number; status: string; final_payable: Money } | null;
  fee_discussion_id: number | null;
  delivery_plan: { plan_code: string; status: string } | null;
  invoice: { invoice_id: number; invoice_number: string; status: string; billed_amount: Money } | null;
  eligible: boolean;
  reasons: string[];
};

export type InvoiceOptions = {
  issuer: Issuer;
  bill_to: PersonRef;
  branch: BranchRef;
  lead_id: number;
  courses: CourseOption[];
  can_issue: boolean;
};

export type NewInvoice = {
  lead_ids: number[];
  installments?: { due_date: DateOnly; amount: Money }[];
  day0_date?: DateOnly | null;
  terms?: string | null;
};

export const dealsApi = {
  deliveryPlan: (leadId: number) => get<DeliveryPlanState>(`/leads/${leadId}/delivery-plan`),
  saveDeliveryPlan: (leadId: number, body: DeliveryPlanBody) => put<DeliveryPlanState>(`/leads/${leadId}/delivery-plan`, body),
  acceptDeliveryPlan: (leadId: number, body: DeliveryPlanBody) => post<DeliveryPlanState>(`/leads/${leadId}/delivery-plan/accept`, body),
  reopenDeliveryPlan: (leadId: number, reason: string) => post<DeliveryPlanState>(`/leads/${leadId}/delivery-plan/reopen`, { reason }),
  invoiceOptions: (leadId: number) => get<InvoiceOptions>("/invoices/options", { lead_id: leadId }),
  createInvoice: (body: NewInvoice) => post<{ invoice_id: number; invoice_number: string; billed_amount: Money }>("/invoices", body),
};

export const dealKeys = {
  deliveryPlan: (leadId: number) => ["deals", "delivery-plan", leadId] as const,
  invoiceOptions: (leadId: number) => ["deals", "invoice-options", leadId] as const,
};

/** Split a total into 1–3 instalments: Full today; 50/50 (day 0, day 12); 50/25/25 (day 0, 10, 15). Paise-exact. */
export function presetSchedule(total: Money, count: 1 | 2 | 3, start: DateOnly): { due_date: DateOnly; amount: Money }[] {
  const paise = Math.round(Number(total) * 100);
  const shares = { 1: [[0, 100]], 2: [[0, 50], [12, 50]], 3: [[0, 50], [10, 25], [15, 25]] }[count];
  const rows = shares.map(([days, pct]) => ({ days, paise: Math.floor((paise * pct) / 100) }));
  rows[rows.length - 1].paise = paise - rows.slice(0, -1).reduce((sum, r) => sum + r.paise, 0);
  const base = new Date(`${start}T00:00:00`);
  return rows.map(({ days, paise: p }) => {
    const d = new Date(base);
    d.setDate(d.getDate() + days);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    return { due_date: iso, amount: (p / 100).toFixed(2) };
  });
}
