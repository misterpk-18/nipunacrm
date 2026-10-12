/** CRM AI sales playbook (v2.0): My work today, lead workbench, outcomes, objections, contact rules, reply drafts,
 * knowledge, course paths, AI controls, course suggestions, recovery lists and measures. */
import { get, patch, post, type Query } from "./client";
import type { BranchRef, CourseRef, DateOnly, DateTime, UserRef } from "./types";
import type { LeadActivity } from "./leads";

export const CONTACT_OUTCOMES = [
  "Connected",
  "No answer",
  "Callback requested",
  "Demo booked",
  "Interested",
  "Later",
  "Not interested",
  "Wrong number",
  "Stop contact",
] as const;
export const OUTCOME_CHANNELS = ["Call", "WhatsApp", "Email", "SMS", "Meeting"] as const;
export const OBJECTION_CATEGORIES = [
  "Fee is high",
  "Another institute is cheaper",
  "Need to ask parents",
  "Cannot attend timings",
  "Job guarantee",
  "Weak in basics",
  "Will decide later",
  "Bad experience / refund concern",
  "Other",
] as const;
export const REPLY_SITUATIONS = [
  "New enquiry",
  "Missed call",
  "Syllabus request",
  "Agreed callback",
  "Demo reminder",
  "Post-demo discussion",
  "Fee follow-up",
  "Future joining",
] as const;
export const KNOWLEDGE_KINDS = [
  "Syllabus",
  "Brochure",
  "Course comparison",
  "Branch location",
  "Fee and instalment rule",
  "Batch availability",
  "Placement support",
  "FAQ answer",
  "Policy",
  "Reply template",
] as const;
export const RECOVERY_LISTS = [
  "no_first_attempt",
  "callback_missed",
  "demo_no_next_action",
  "fee_shared_silent",
  "waiting_batch",
  "never_reached",
  "lost_recoverable",
  "referred",
  "existing_student",
] as const;
export type RecoveryListKey = (typeof RECOVERY_LISTS)[number];
export type Disposition = "Used" | "Edited" | "Ignored" | "Snoozed";

export type Need = {
  learner_goal: string | null;
  prior_experience: string | null;
  preferred_timing: string | null;
  joining_window: string | null;
  open_question: string | null;
};

export type Objection = {
  objection_id: number;
  lead_id: number;
  learner_words: string;
  category: string | null;
  category_suggested: boolean;
  action_taken: string | null;
  status: "Open" | "Resolved" | "Closed unresolved";
  resolution: string | null;
  resolved_by: UserRef | null;
  resolved_at: DateTime | null;
  created_by: UserRef | null;
  created_at: DateTime;
};

export type Knowledge = {
  knowledge_id: number;
  kind: string;
  title: string;
  course: CourseRef | null;
  branch: BranchRef | null;
  situation: string | null;
  language: string;
  body: string;
  link_url: string | null;
  status: "Draft" | "Approved" | "Retired";
  version: number;
  owner: UserRef | null;
  approved_by: UserRef | null;
  approved_at: DateTime | null;
  review_due_on: DateOnly | null;
  is_stale: boolean | null;
  updated_at: DateTime;
};

export type NextActionCard = {
  action_code: string;
  suggestion: string;
  reason: string;
  evidence: Record<string, unknown>[];
  primary_action: string | null;
  fingerprint: string;
  owner: string | null;
  disposition: { status: Disposition; at: DateTime | null; remind_at: DateTime | null; note: string | null } | null;
  hidden: boolean;
};

export type AiAction = {
  ai_action_id: number;
  action_type: string;
  action_code: string;
  lead_id: number | null;
  person_id: number | null;
  branch_id: number;
  course: CourseRef | null;
  suggestion: string;
  reason: string | null;
  evidence: Record<string, unknown>[];
  draft_text: string | null;
  payload: Record<string, unknown> | null;
  status: string;
  final_text: string | null;
  model: string | null;
  prompt_version: string | null;
  created_at: DateTime;
  expires_at: DateTime | null;
  requires_human_review: true;
};

export type OfferableBatch = {
  batch_id: number;
  batch_code: string;
  lms_batch_code: string | null;
  delivery_mode: string;
  status: string;
  start_date: DateOnly;
  schedule_days: string | null;
  start_time: string | null;
  end_time: string | null;
  location: string | null;
  seats_left: number;
  is_offerable: boolean;
  not_offerable_reason: string | null;
  timing_confirmed: boolean;
  timing: string;
};

export type ClosingItem = { key: string; label: string; done: boolean; evidence: string | null; next_action: string };

export type Workbench = {
  lead_id: number;
  brief: {
    need: Need;
    preferred_language: string;
    preferred_contact_time: string | null;
    course_interests: { lead_id: number; lead_code: string; course: CourseRef | null; stage: string }[];
    branch: BranchRef;
    enquiry_message: string | null;
    enquiry_received_at: DateTime | null;
    last_discussion: { activity_type: string; outcome: string | null; summary: string | null; occurred_at: DateTime; by: string | null } | null;
    unresolved_objection: Objection | null;
    promised_next_action: { next_action: string | null; at: DateTime | null } | null;
    contact_state: string | null;
    missing: { field: string; label: string; question: string }[];
  };
  response_clock: {
    captured_at: DateTime;
    due_at: DateTime;
    attempted_at: DateTime | null;
    is_eligible: boolean;
    sla_state: string;
  };
  contact_policy: {
    stop_contact: { at: DateTime; by: number | null; reason: string } | null;
    never_reached: boolean;
    is_outreach: boolean;
    calls: { used: number; limit: number };
    whatsapp: { used: number; limit: number };
    outreach_attempts: { used: number; limit: number };
    blocked: Record<"Call" | "WhatsApp" | "Email", string | null>;
  };
  next_action: NextActionCard | null;
  assistance: { execution_profile: string; is_paused: boolean; pause_reason: string | null; drafts_allowed: boolean };
  objections: Objection[];
  content: Knowledge[];
  batches: OfferableBatch[];
  closing_checklist: { items: ClosingItem[]; complete: boolean } | null;
  can_contact: boolean;
  as_of: DateTime;
};

export type OutcomeBody = {
  channel: string;
  direction?: "Inbound" | "Outbound";
  outcome: string;
  note?: string | null;
  next_action?: string | null;
  next_action_at?: string | null;
  need?: Partial<Need> | null;
  objection?: { learner_words: string; category?: string | null } | null;
  ai_action_id?: number | null;
};

export type ReplyDraft = {
  draft: AiAction;
  text: string;
  missing: string[];
  language: string;
  language_fallback: boolean;
  can_send: boolean;
  blocked_reasons: string[];
  whatsapp_number: string;
};

export type WorkItem = {
  key: string;
  tier: 1 | 2 | 3 | 4;
  kind: string;
  title: string;
  reason: string;
  due_at: DateTime | null;
  overdue: boolean;
  lead: {
    lead_id: number;
    lead_code: string;
    name: string;
    phone: string;
    course: CourseRef | null;
    branch: BranchRef;
    stage: string;
    ai_priority: string | null;
    owner: string | null;
    contact_state: string | null;
  } | null;
  person_id?: number;
  task_id?: number;
  demo_id?: number;
  communication_id?: number;
  also: { kind: string; title: string }[];
};

export type MyWorkToday = { as_of: DateTime; tiers: { tier: number; label: string; count: number }[]; items: WorkItem[] };

export type HandoverRow = {
  lead: NonNullable<WorkItem["lead"]>;
  last_contact: Workbench["brief"]["last_discussion"];
  promise: Workbench["brief"]["promised_next_action"];
  unresolved: string | null;
  next_at: DateTime | null;
  first_attempt_pending: boolean;
};

export type CoursePath = {
  course_path_id: number;
  from_course: CourseRef;
  to_course: CourseRef;
  learner_benefit: string;
  helps_when: string | null;
  skip_when: string | null;
  prerequisites: string | null;
  suggested_question: string | null;
  status: "Draft" | "Approved" | "Retired";
  approved_by: UserRef | null;
  approved_at: DateTime | null;
};

export type AiControl = {
  branch: BranchRef;
  execution_profile: string;
  is_paused: boolean;
  pause_reason: string | null;
  paused_by: UserRef | null;
  paused_at: DateTime | null;
};

export type CourseSuggestion = {
  action_code: string;
  course: CourseRef;
  from_course: CourseRef;
  learner_benefit: string;
  helps_when: string | null;
  skip_when: string | null;
  goal: string | null;
  missing_checks: string[];
  overlap: CourseRef[];
  availability: string;
  suggested_question: string;
  open_lead: { lead_id: number; lead_code: string; stage: string } | null;
  disposition: { status: string; at: DateTime | null; remind_at: DateTime | null; note: string | null } | null;
};

export type CourseSuggestions = {
  person_id: number;
  is_student: boolean;
  stop_contact: boolean;
  suggestions: CourseSuggestion[];
  hidden: CourseSuggestion[];
  skipped: { course: CourseRef; reason: string }[];
  note: string | null;
};

export type RecoveryCount = { list: RecoveryListKey; label: string; suggested_action: string; count: number | null };
export type RecoveryList = {
  list: RecoveryListKey;
  label: string;
  rows: {
    lead?: NonNullable<WorkItem["lead"]>;
    person?: { person_id: number; person_code: string; full_name: string; phone: string };
    course?: CourseRef;
    evidence: string;
    suggested_action: string;
    recovery_task_open?: boolean;
  }[];
  excluded: { reason: string; count: number }[];
};

export type PlaybookMeasures = {
  period: { from: DateOnly; to: DateOnly };
  first_attempt: { eligible: number; met: number; met_late: number; breached_no_attempt: number; pending: number; pct_within_sla: number | null };
  callbacks: { due: number; completed_on_time: number; missed_open: number; pct_completed: number | null };
  demos: { due: number; attended: number; no_show: number; outcome_missing: number; cancelled: number; rescheduled: number; pct_attended: number | null };
  qualified_to_paid: { qualified: number; paid: number; pct: number | null; observation_days: number; immature: boolean };
  recovery: { recovery_actions: number; recovered_paid: number };
  cross_course: { reviewed: number; used: number; ignored: number; snoozed: number; interested_leads: number; paid: number };
  sources: { source: string; branch: string; genuine_leads: number; deals: number; verified_paid: number }[];
  assistance: { by_status: { action_type: string; status: string; count: number }[]; model_fallbacks: number };
  notes: string[];
};

export const playbookApi = {
  today: (query: Query) => get<MyWorkToday>("/my-work/today", query),
  handover: (query: Query) => get<HandoverRow[]>("/my-work/handover", query),
  handoverNote: (leadId: number, body: { note: string; cover_user_id?: number | null }) =>
    post<{ activity: LeadActivity; task: unknown }>(`/leads/${leadId}/handover-note`, body),
  workbench: (leadId: number) => get<Workbench>(`/leads/${leadId}/workbench`),
  outcome: (leadId: number, body: OutcomeBody) => post<{ activity: LeadActivity }>(`/leads/${leadId}/outcome`, body),
  disposeNextAction: (leadId: number, body: { action_code: string; status: Disposition; final_text?: string; note?: string; remind_at?: string }) =>
    post<AiAction>(`/leads/${leadId}/next-action/disposition`, body),
  addObjection: (leadId: number, body: { learner_words: string; category?: string | null; action_taken?: string | null }) =>
    post<Objection>(`/leads/${leadId}/objections`, body),
  updateObjection: (id: number, body: Partial<Pick<Objection, "category" | "action_taken" | "status" | "resolution">>) =>
    patch<Objection>(`/objections/${id}`, body),
  objectionGuide: () => get<{ category: string; ask: string; next_action: string }[]>("/objections/guide"),
  stopContact: (personId: number, reason: string) => post(`/persons/${personId}/stop-contact`, { reason }),
  clearStopContact: (personId: number, reason: string) => post(`/persons/${personId}/stop-contact/clear`, { reason }),
  replyDraft: (leadId: number, situation: string, language?: string) =>
    post<ReplyDraft>(`/leads/${leadId}/reply-draft`, { situation, language }),
  recordMessage: (leadId: number, body: { channel: string; text: string; ai_action_id?: number | null }) =>
    post<{ activity: LeadActivity; draft: AiAction | null }>(`/leads/${leadId}/messages`, body),
  counsellingBrief: (leadId: number, language?: string) => post<AiAction>(`/leads/${leadId}/ai/counselling-brief`, { language }),
  knowledge: (query: Query) => get<Knowledge[]>("/sales-knowledge", query),
  createKnowledge: (body: Record<string, unknown>) => post<Knowledge>("/sales-knowledge", body),
  updateKnowledge: (id: number, body: Record<string, unknown>) => patch<Knowledge>(`/sales-knowledge/${id}`, body),
  approveKnowledge: (id: number) => post<Knowledge>(`/sales-knowledge/${id}/approve`),
  retireKnowledge: (id: number) => post<Knowledge>(`/sales-knowledge/${id}/retire`),
  paths: (query: Query) => get<CoursePath[]>("/course-paths", query),
  createPath: (body: Record<string, unknown>) => post<CoursePath>("/course-paths", body),
  approvePath: (id: number) => post<CoursePath>(`/course-paths/${id}/approve`),
  retirePath: (id: number) => post<CoursePath>(`/course-paths/${id}/retire`),
  controls: () => get<AiControl[]>("/ai/controls"),
  updateControl: (branchId: number, body: { execution_profile?: string; is_paused?: boolean; pause_reason?: string | null }) =>
    patch<AiControl>(`/ai/controls/${branchId}`, body),
  courseSuggestions: (personId: number) => get<CourseSuggestions>(`/persons/${personId}/course-suggestions`),
  disposeCourseSuggestion: (personId: number, body: { course_id: number; status: Disposition; note?: string; remind_at?: string; final_text?: string }) =>
    post<AiAction>(`/persons/${personId}/course-suggestions/disposition`, body),
  recoveryCounts: (query: Query) => get<RecoveryCount[]>("/recovery-lists", query),
  recoveryList: (name: RecoveryListKey, query: Query) => get<RecoveryList>(`/recovery-lists/${name}`, query),
  recoveryTasks: (body: { list: RecoveryListKey; lead_ids: number[]; due_at?: string }) =>
    post<{ created: { lead_id: number; task_id: number }[]; skipped: { lead_id: number; reason: string }[] }>("/recovery-lists/tasks", body),
  measures: (query: Query) => get<PlaybookMeasures>("/reports/sales-playbook", query),
};

export const playbookKeys = {
  all: ["playbook"] as const,
  today: (query: Query) => ["playbook", "today", query] as const,
  handover: (query: Query) => ["playbook", "handover", query] as const,
  workbench: (leadId: number) => ["playbook", "workbench", leadId] as const,
  knowledge: (query: Query) => ["playbook", "knowledge", query] as const,
  paths: (query: Query) => ["playbook", "paths", query] as const,
  controls: ["playbook", "controls"] as const,
  suggestions: (personId: number) => ["playbook", "suggestions", personId] as const,
  recovery: (name: string, query: Query) => ["playbook", "recovery", name, query] as const,
  recoveryCounts: (query: Query) => ["playbook", "recovery-counts", query] as const,
  measures: (query: Query) => ["playbook", "measures", query] as const,
};
