import { get, list, patch, post, type Query } from "./client";
import type { BranchRef, CourseRef, DateOnly, DateTime, UserRef } from "./types";

export type DemoLeadRef = { lead_id: number; lead_code: string; name: string; stage: string };

export type DemoRow = {
  demo_id: number;
  demo_code: string;
  lead: DemoLeadRef;
  course: CourseRef | null;
  branch: BranchRef;
  scheduled_at: DateTime;
  duration_minutes: number;
  demo_type: string;
  mode: string;
  trainer: UserRef | null;
  status: string;
  outcome: string | null;
  attended_demos?: string;
};

export type DemoReminder = {
  reminder_id: number;
  reminder_type: string;
  due_at: DateTime;
  state: string;
  sent_at: DateTime | null;
  failure_reason: string | null;
  note: string | null;
};

export type Demo = DemoRow & {
  meeting_link: string | null;
  rescheduled_from_demo_id: number | null;
  extra_demo_approved_by: number | null;
  student_feedback: string | null;
  trainer_feedback: string | null;
  rating: number | null;
  recommended_course: CourseRef | null;
  next_action: string | null;
  commercial_owner: UserRef | null;
  next_follow_up_at: DateTime | null;
  commercial_follow_up_due_at: DateTime | null;
  reschedule_reason: string | null;
  cancel_reason: string | null;
  reminders: DemoReminder[];
  created_at: DateTime;
};

export type DemoFilters = {
  page?: number;
  per_page?: number;
  from?: DateOnly;
  to?: DateOnly;
  branch_id?: number;
  trainer_id?: number;
  lead_id?: number;
  status?: string;
};

export type DemoOutcome = {
  status: "Attended" | "No Show";
  student_feedback?: string | null;
  trainer_feedback?: string | null;
  rating?: number | null;
  outcome?: string | null;
  recommended_course_id?: number | null;
  next_action?: string | null;
  commercial_owner_id?: number | null;
  next_follow_up_at: DateTime;
};

export const DEMO_STATUSES = ["Scheduled", "Confirmed", "Attended", "No Show", "Rescheduled", "Cancelled"];
export const OPEN_DEMO_STATUSES = ["Scheduled", "Confirmed"];
export const RESCHEDULE_REASONS = ["Student requested", "Trainer unavailable", "Batch timing change", "Other"];
export const CANCEL_REASONS = ["Student not available", "Duplicate booking", "Course changed", "Other"];
export const DEMO_OUTCOMES = [
  "Interested — fee discussion",
  "Needs another demo",
  "Considering other course",
  "Not interested",
  "No-show — reschedule attempt",
];

export const demosApi = {
  list: (filters: DemoFilters) => list<DemoRow>("/demos", filters as Query),
  get: (id: number) => get<Demo>(`/demos/${id}`),
  update: (id: number, body: { trainer_user_id?: number | null; mode?: string; meeting_link?: string | null; duration_minutes?: number }) =>
    patch<Demo>(`/demos/${id}`, body),
  confirm: (id: number) => post<Demo>(`/demos/${id}/confirm`),
  reschedule: (id: number, body: { scheduled_at: DateTime; reason: string }) => post<Demo>(`/demos/${id}/reschedule`, body),
  cancel: (id: number, reason: string) => post<Demo>(`/demos/${id}/cancel`, { reason }),
  outcome: (id: number, body: DemoOutcome) => post<Demo>(`/demos/${id}/outcome`, body),
  reminders: (id: number) => get<DemoReminder[]>(`/demos/${id}/reminders`),
  approveExtra: (id: number) => post<Demo>(`/demos/${id}/approve-extra`),
};

export const demoKeys = {
  all: ["demos"] as const,
  list: (filters: DemoFilters) => ["demos", "list", filters] as const,
  detail: (id: number) => ["demos", "detail", id] as const,
  reminders: (id: number) => ["demos", "reminders", id] as const,
};
