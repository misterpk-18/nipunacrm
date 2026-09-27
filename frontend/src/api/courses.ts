import { get, list, patch, post, put, type Query } from "./client";
import type { CourseRef, Money } from "./types";

export const COURSE_STATUSES = ["Active", "Inactive", "Archived"];

export type Course = {
  course_id: number;
  course_code: string;
  course_title: string;
  category: string;
  standard_fee: Money;
  is_combo: boolean;
  status: string;
  branches: string[];
  components: (CourseRef & { is_bonus: boolean; sort_order: number })[];
};

export type CourseFilters = { page?: number; per_page?: number; type?: "standalone" | "combo"; status?: string; category?: string; branch_id?: number; q?: string };

export type Installment = {
  installment_no?: number;
  percent_of_fee: string;
  due_days_after_admission: number;
  due_days_min?: number | null;
  due_days_max?: number | null;
};

export type PaymentPlan = {
  payment_plan_id: number;
  plan_code: string;
  plan_name: string;
  description: string | null;
  is_active: boolean;
  installments: Installment[];
};

export const coursesApi = {
  list: (filters: CourseFilters) => list<Course>("/courses", filters as Query),
  get: (id: number) => get<Course>(`/courses/${id}`),
  create: (body: { course_code: string; course_title: string; category: string; standard_fee: string; is_combo?: boolean; status?: string; branch_ids?: number[] }) =>
    post<Course>("/courses", body),
  update: (id: number, body: { course_title?: string; category?: string; standard_fee?: string; status?: string }) => patch<Course>(`/courses/${id}`, body),
  setBranches: (id: number, branch_ids: number[]) => put<Course>(`/courses/${id}/branches`, { branch_ids }),
  setComponents: (id: number, components: { course_id: number; is_bonus?: boolean; sort_order?: number }[]) =>
    put<Course>(`/courses/${id}/components`, { components }),
  plans: (includeInactive = false) => get<PaymentPlan[]>("/payment-plans", { include_inactive: includeInactive || undefined }),
  createPlan: (body: { plan_code: string; plan_name: string; description?: string | null; installments: Installment[] }) =>
    post<PaymentPlan>("/payment-plans", body),
  updatePlan: (id: number, body: { plan_name?: string; description?: string | null; is_active?: boolean; installments?: Installment[] }) =>
    patch<PaymentPlan>(`/payment-plans/${id}`, body),
};

export const courseKeys = {
  all: ["courses"] as const,
  list: (filters: CourseFilters) => ["courses", "list", filters] as const,
  plans: (includeInactive: boolean) => ["payment-plans", includeInactive] as const,
};
