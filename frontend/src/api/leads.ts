import { useQuery } from "@tanstack/react-query";
import { get, list, post, patch, del, upload, type Query } from "./client";
import type { BranchRef, CourseRef, DateOnly, DateTime, UserRef } from "./types";

export type LeadRow = {
  lead_id: number;
  lead_code: string;
  name: string;
  phone: string;
  course: CourseRef | null;
  branch: BranchRef;
  original_source: string;
  contact_channel: string;
  entry_method: string;
  intake_status: string;
  owner: UserRef | null;
  stage: string;
  next_follow_up_at: DateTime | null;
  last_contacted_at: DateTime | null;
  age_days: number;
  ai_priority: string | null;
  ai_score: number | null;
};

export type Person = {
  person_id: number;
  person_code: string;
  full_name: string;
  phone: string;
  email: string | null;
  alternate_phone: string | null;
  whatsapp_number: string | null;
  city: string | null;
  highest_qualification: string | null;
  preferred_language: string;
  registered_branch: BranchRef;
  created_at: DateTime;
};

export type Lead = LeadRow & {
  person: Person;
  original_enquiry_id: number | null;
  campaign: string | null;
  remarks: string | null;
  stage_changed_at: DateTime;
  is_open: boolean;
  lost: { reason: string | null; competitor: string | null; notes: string | null; reactivation_date: DateOnly | null } | null;
  created_at: DateTime;
};

export type LeadActivity = {
  activity_id: number;
  activity_type: string;
  direction: string | null;
  channel: string | null;
  purpose: string | null;
  outcome: string | null;
  summary: string | null;
  call_duration_seconds: number | null;
  from_stage: string | null;
  to_stage: string | null;
  demo_id: number | null;
  communication_id: number | null;
  performed_by: UserRef | null;
  occurred_at: DateTime;
};

export type WorkspaceCounts = Record<
  "new" | "untouched" | "due_today" | "overdue" | "hot" | "demos" | "fee_discussion" | "payment_pending" | "cold" | "future_joining",
  number
>;

export type SavedView = {
  saved_view_id: number;
  module: string;
  name: string;
  filters: Record<string, string | number>;
  shared: boolean;
  user_id: number | null;
  sort_order: number;
};

export type LeadImportRow = {
  row_no: number;
  raw_data: Record<string, string>;
  full_name: string | null;
  phone: string | null;
  email: string | null;
  course_id: number | null;
  branch_id: number | null;
  lead_source_id: number | null;
  issues: string[];
  result: string;
  matched_lead_id: number | null;
  lead_id: number | null;
  enquiry_id: number | null;
};

export type LeadImport = {
  import_id: number;
  import_code: string;
  file_name: string;
  status: string;
  total_rows: number;
  ready_rows: number;
  duplicate_rows: number;
  invalid_rows: number;
  uploaded_at: DateTime;
  imported_at: DateTime | null;
  field_mapping: Record<string, string>;
  rows?: LeadImportRow[];
};

export type LeadFilters = {
  page?: number;
  per_page?: number;
  branch_id?: number;
  stage?: string;
  course_id?: number;
  source_id?: number;
  intake_status?: string;
  priority?: string;
  queue?: string;
  q?: string;
  assigned_to?: string; // "me" | "unassigned" | user id
};

export type NewLead = {
  branch_id: number;
  person_id?: number;
  person?: {
    full_name: string;
    phone: string;
    alternate_phone?: string | null;
    whatsapp_number?: string | null;
    email?: string | null;
    city?: string | null;
    highest_qualification?: string | null;
    preferred_language?: string;
  };
  course_id?: number | null;
  lead_source_id: number;
  contact_channel_id: number;
  entry_method_id: number;
  assigned_to?: number | null;
  next_follow_up_at?: DateTime | null;
  intake_status?: string;
  campaign?: string | null;
  remarks?: string | null;
  message?: string | null;
};

export const FOLLOW_UP_PURPOSES = ["Counselling call", "Demo confirmation", "Post-demo follow-up", "Fee follow-up", "Collection follow-up", "Document follow-up"];
export const FOLLOW_UP_RESPONSES = ["Interested", "Call back later", "Not reachable", "Needs time", "Not interested"];
export const REACTIVATE_STAGES = ["New Enquiry", "Counselling", "Demo Scheduled", "Demo Attended", "Fee Discussion / Payment Awaited"];
export const MANUAL_INTAKE = ["New", "Incomplete", "Outreach Prospect", "Invalid-Spam", "Test"];

export const leadsApi = {
  list: (filters: LeadFilters) => list<LeadRow>("/leads", filters as Query),
  workspace: (query: Query) => get<{ counts: WorkspaceCounts; leads: LeadRow[] }>("/leads/workspace", query),
  get: (id: number) => get<Lead>(`/leads/${id}`),
  create: (body: NewLead) => post<Lead>("/leads", body),
  update: (id: number, body: { course_id?: number | null; intake_status?: string; campaign?: string | null; remarks?: string | null }) =>
    patch<Lead>(`/leads/${id}`, body),
  assign: (id: number, assigned_to: number) => post<Lead>(`/leads/${id}/assign`, { assigned_to }),
  bulkAssign: (lead_ids: number[], assigned_to: number) => post<LeadRow[]>("/leads/bulk-assign", { lead_ids, assigned_to }),
  changeStage: (id: number, stage: string, note?: string) => post<Lead>(`/leads/${id}/stage`, { stage, note }),
  scheduleFollowUp: (id: number, next_follow_up_at: DateTime, note?: string) =>
    post<Lead>(`/leads/${id}/follow-up`, { next_follow_up_at, note }),
  logFollowUp: (id: number, body: { purpose: string; response: string; notes?: string; next_follow_up_at: DateTime }) =>
    post<{ lead: Lead; activity: LeadActivity }>(`/leads/${id}/follow-up-log`, body),
  markLost: (id: number, body: { lost_reason_id: number; lost_competitor?: string | null; lost_notes?: string | null; reactivation_date?: DateOnly | null }) =>
    post<Lead>(`/leads/${id}/lost`, body),
  reactivate: (id: number, body: { stage: string; next_follow_up_at?: DateTime | null }) => post<Lead>(`/leads/${id}/reactivate`, body),
  activities: (id: number, page = 1) => list<LeadActivity>(`/leads/${id}/activities`, { page, per_page: 50 }),
  addActivity: (
    id: number,
    body: { activity_type: string; direction?: string | null; contact_channel_id?: number | null; outcome?: string | null; summary?: string | null; call_duration_seconds?: number | null },
  ) => post<LeadActivity>(`/leads/${id}/activities`, body),
  enquiries: (id: number) => get<Record<string, unknown>[]>(`/leads/${id}/enquiries`),
  savedViews: () => get<SavedView[]>("/saved-views", { module: "leads" }),
  createSavedView: (body: { name: string; filters: Record<string, unknown>; shared?: boolean }) =>
    post<SavedView>("/saved-views", { module: "leads", ...body }),
  deleteSavedView: (id: number) => del<null>(`/saved-views/${id}`),
  searchPersons: (query: { phone?: string; email?: string; name?: string }) => get<Person[]>("/persons/search", query),
  getPerson: (id: number) => get<Person>(`/persons/${id}`),
  uploadImport: (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return upload<LeadImport>("/lead-imports", form);
  },
  getImport: (id: number) => get<LeadImport>(`/lead-imports/${id}`),
  runImport: (id: number) => post<LeadImport>(`/lead-imports/${id}/import`),
};

export const leadKeys = {
  all: ["leads"] as const,
  list: (filters: LeadFilters) => ["leads", "list", filters] as const,
  detail: (id: number) => ["leads", "detail", id] as const,
  activities: (id: number) => ["leads", "activities", id] as const,
  workspace: (query: Query) => ["leads", "workspace", query] as const,
  savedViews: ["saved-views", "leads"] as const,
};

export const useLead = (id: number) => useQuery({ queryKey: leadKeys.detail(id), queryFn: () => leadsApi.get(id) });
