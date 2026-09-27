import { get, list, patch, post, type Query } from "./client";
import type { DateTime, UserRef } from "./types";

export const TASK_LINK_FIELDS = [
  "lead_id",
  "demo_id",
  "fee_discussion_id",
  "scr_id",
  "admission_id",
  "payment_id",
  "refund_case_id",
  "document_id",
  "communication_id",
  "support_case_id",
  "enquiry_id",
  "invoice_id",
  "correction_request_id",
] as const;
export type TaskLinkField = (typeof TASK_LINK_FIELDS)[number];

export const TASK_STATUSES = ["Open", "In Progress", "Waiting/Blocked", "Completed", "Cancelled"] as const;

export type Task = {
  task_id: number;
  task_type: string;
  title: string;
  description: string | null;
  branch_id: number;
  owner_user_id: number | null;
  owner: UserRef | null;
  team_role: string | null;
  status: string;
  source: "Manual" | "System";
  original_due_at: DateTime;
  revised_due_at: DateTime | null;
  revision_reason: string | null;
  due_at: DateTime;
  blocked_reason: string | null;
  cancel_reason: string | null;
  linked: Partial<Record<TaskLinkField, number>>;
  completed_by: number | null;
  completed_at: DateTime | null;
  created_at: DateTime;
  /** Present on list rows (task_board view). */
  is_overdue?: boolean;
  is_due_today?: boolean;
  is_unassigned?: boolean;
  linked_record?: string | null;
};

export type TaskFilters = {
  page?: number;
  per_page?: number;
  view?: "my" | "team";
  status?: string;
  overdue?: boolean;
  due_today?: boolean;
  unassigned?: boolean;
  open?: boolean;
  type?: string;
  branch_id?: number;
  owner_user_id?: number;
} & Partial<Record<TaskLinkField, number>>;

export type NewTask = {
  task_type_id: number;
  title: string;
  description?: string | null;
  branch_id: number;
  owner_user_id?: number | null;
  due_at: DateTime;
  link?: Partial<Record<TaskLinkField, number>> | null;
};

export type TaskAction = "start" | "block" | "complete" | "cancel";

export const tasksApi = {
  list: (filters: TaskFilters) => list<Task>("/tasks", filters as Query),
  get: (id: number) => get<Task>(`/tasks/${id}`),
  create: (body: NewTask) => post<Task>("/tasks", body),
  update: (id: number, body: { title?: string; description?: string | null; owner_user_id?: number | null }) => patch<Task>(`/tasks/${id}`, body),
  transition: (id: number, action: TaskAction, reason?: string) => post<Task>(`/tasks/${id}/${action}`, reason ? { reason } : {}),
  reviseDeadline: (id: number, due_at: DateTime, reason: string) => post<Task>(`/tasks/${id}/revise-deadline`, { due_at, reason }),
};

export const taskKeys = {
  all: ["tasks"] as const,
  list: (filters: TaskFilters) => ["tasks", "list", filters] as const,
  detail: (id: number) => ["tasks", "detail", id] as const,
};
