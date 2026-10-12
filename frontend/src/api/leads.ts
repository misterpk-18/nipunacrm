import { useQuery } from "@tanstack/react-query";
import { get, list, post, patch, put, del, upload, type Query } from "./client";
import type { BranchRef, CourseRef, DateOnly, DateTime, Money, UserRef } from "./types";

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
  lead_status: "Active" | "Inactive";
  pipeline_entry_id: number | null;
  owner: UserRef | null;
  stage: string;
  next_follow_up_at: DateTime | null;
  last_contacted_at: DateTime | null;
  age_days: number;
  ai_priority: string | null;
  ai_score: number | null;
  qualified_at: DateTime | null;
  converted_at: DateTime | null;
  next_action: string | null;
  contact_state: string | null;
  first_attempt_due_at: DateTime | null;
  first_staff_attempt_at: DateTime | null;
};

export type Person = {
  person_id: number;
  person_code: string;
  full_name: string;
  phone: string;
  email: string | null;
  alternate_phone: string | null;
  whatsapp_number: string | null;
  /** The WhatsApp notifications switch (db 044): off = nothing is sent to this person. */
  whatsapp_notifications?: boolean;
  /** Marketing consent for WhatsApp templates (db 034). */
  whatsapp_consent?: { status: "Not Recorded" | "Explicit Consent" | "Withdrawn"; at: DateTime | null; by: number | null; source: string | null };
  city: string | null;
  highest_qualification: string | null;
  preferred_language: string;
  preferred_contact_time?: string | null;
  stop_contact?: { at: DateTime; by: number | null; reason: string } | null;
  registered_branch: BranchRef;
  created_at: DateTime;
};

export type Lead = LeadRow & {
  person: Person;
  original_enquiry_id: number | null;
  campaign: string | null;
  remarks: string | null;
  need: {
    learner_goal: string | null;
    prior_experience: string | null;
    preferred_timing: string | null;
    joining_window: string | null;
    open_question: string | null;
  };
  contact_state_at: DateTime | null;
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
  lead_status?: string; // "Active" (default) | "Inactive" | "All"
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

/** Qualification checklist (db 019): all six reviewed → Mark Qualified → Convert to deal. */
export const QUALIFICATION_CHECKS = [
  "Genuine intent confirmed",
  "Reachable contact confirmed",
  "Intended course(s) understood",
  "Branch and delivery mode discussed",
  "Exact next action agreed",
  "Possible identity match reviewed",
] as const;

export type QualificationCheck = {
  check: string;
  hint: string;
  reviewed: boolean;
  reviewed_by: UserRef | null;
  reviewed_at: DateTime | null;
  notes: string | null;
  /** Ticked by the system from saved data (reviewed_by.full_name is "System"). */
  auto?: boolean;
};

export type Qualification = {
  lead_id: number;
  checks: QualificationCheck[];
  complete: boolean;
  qualified_at: DateTime | null;
  qualified_by: number | null;
  converted_at: DateTime | null;
  pipeline_entry_id: number | null;
  can_convert: boolean;
};

export type ConvertBody = { course_ids: number[]; branch_id?: number; assigned_to?: number | null; expected_close_date?: DateOnly | null };
export type ConvertResult = {
  pipeline_entry: { pipeline_entry_id: number; entry_code: string; stage: string };
  courses: { lead: { lead_id: number; lead_code: string }; course: CourseRef | null; result: "converted" | "created" | "existing" }[];
};

/** The next-step bar (GET /leads/<id>/journey): where the deal is, the one next action, the money and the post-admission trail. */
export type JourneyStepStatus = "done" | "current" | "blocked" | "todo" | "skipped";
export type JourneyAction =
  | "qualify" | "convert" | "save_outcome" | "book_demo" | "record_demo_outcome" | "fee_discussion" | "request_approval"
  | "accept_plan" | "create_invoice" | "record_payment" | "verify_payment" | "wait_batch" | "none";
export type JourneyStep = { key: string; label: string; status: JourneyStepStatus; at: DateTime | null; detail: string | null };
export type JourneyNext = {
  action: JourneyAction;
  label: string;
  detail: string | null;
  role: string | null;
  can_act: boolean;
  blocked: boolean;
  reason: string | null;
  fix_action: JourneyAction | null;
  fix_label: string | null;
  /** Record ids the action needs (demo, fee discussion, SCR, invoice, payment, admission) */
  ref: { demo_id?: number; scheduled_at?: DateTime; fee_discussion_id?: number; version_id?: number; scr_id?: number | null; invoice_id?: number; payment_id?: number; transaction_number?: string; admission_id?: number };
  alternatives: { action: JourneyAction; label: string }[];
};
export type JourneyTrailStep = { key: "admitted" | "lms_login" | "batch_allocated"; label: string; status: "done" | "current" | "todo"; at: DateTime | null; detail: string | null };
export type Journey = {
  lead_id: number;
  person_id: number;
  course_id: number | null;
  course_title: string | null;
  pipeline_entry_id: number | null;
  steps: JourneyStep[];
  next: JourneyNext | null;
  money: { invoice_id: number; invoice_code: string; total: Money; verified: Money; balance: Money; pending: Money; token_needed: Money; more_to_admit: Money } | null;
  after_admission: { admission_id: number; admission_code: string; trail: JourneyTrailStep[] } | null;
};

export const FOLLOW_UP_PURPOSES = ["Counselling call", "Demo confirmation", "Post-demo follow-up", "Fee follow-up", "Collection follow-up", "Document follow-up"];
export const FOLLOW_UP_RESPONSES = ["Interested", "Call back later", "Not reachable", "Needs time", "Not interested"];
export const REACTIVATE_STAGES = ["New Enquiry", "Counselling", "Demo Scheduled", "Demo Attended", "Fee Discussion / Payment Awaited"];
/** Live duplicate check by phone: people the user may see, and whether the number also exists where they can't. */
export type PersonLookup = {
  phone: string;
  matches: { person_id: number; person_code: string; full_name: string; courses_count: number; courses: string[] }[];
  other_branch: boolean;
};

export const MANUAL_INTAKE = ["New", "Incomplete", "Outreach Prospect", "Invalid-Spam", "Test"];

export const leadsApi = {
  list: (filters: LeadFilters) => list<LeadRow>("/leads", filters as Query),
  workspace: (query: Query) => get<{ counts: WorkspaceCounts; leads: LeadRow[] }>("/leads/workspace", query),
  get: (id: number) => get<Lead>(`/leads/${id}`),
  create: (body: NewLead) => post<Lead>("/leads", body),
  update: (
    id: number,
    body: {
      course_id?: number | null;
      intake_status?: string;
      campaign?: string | null;
      remarks?: string | null;
      learner_goal?: string | null;
      prior_experience?: string | null;
      preferred_timing?: string | null;
      joining_window?: string | null;
      open_question?: string | null;
      next_action?: string | null;
    },
  ) =>
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
  lookupPerson: (phone: string) => get<PersonLookup>("/persons/lookup", { phone }),
  /** Now + N staffed minutes at the branch (closed hours, off days and holidays skipped). */
  staffedTime: (branchId: number, minutes = 120) => get<{ at: DateTime }>("/leads/staffed-time", { branch_id: branchId, minutes }),
  getPerson: (id: number) => get<Person>(`/persons/${id}`),
  uploadImport: (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return upload<LeadImport>("/lead-imports", form);
  },
  getImport: (id: number) => get<LeadImport>(`/lead-imports/${id}`),
  runImport: (id: number) => post<LeadImport>(`/lead-imports/${id}/import`),
  qualification: (id: number) => get<Qualification>(`/leads/${id}/qualification`),
  setCheck: (id: number, check: string, reviewed: boolean) => put<Qualification>(`/leads/${id}/qualification/checks`, { check, reviewed }),
  qualify: (id: number) => post<Qualification>(`/leads/${id}/qualify`),
  convert: (id: number, body: ConvertBody) => post<ConvertResult>(`/leads/${id}/convert`, body),
  journey: (id: number) => get<Journey>(`/leads/${id}/journey`),
};

export const leadKeys = {
  all: ["leads"] as const,
  list: (filters: LeadFilters) => ["leads", "list", filters] as const,
  detail: (id: number) => ["leads", "detail", id] as const,
  activities: (id: number) => ["leads", "activities", id] as const,
  qualification: (id: number) => ["leads", "qualification", id] as const,
  journey: (id: number) => ["leads", "journey", id] as const,
  workspace: (query: Query) => ["leads", "workspace", query] as const,
  savedViews: ["saved-views", "leads"] as const,
};

export const useLead = (id: number) => useQuery({ queryKey: leadKeys.detail(id), queryFn: () => leadsApi.get(id) });
