import { get, list, patch, post, type Query } from "./client";
import type { BranchRef, CourseRef, DateOnly, DateTime, Money, PersonRef, UserRef } from "./types";

/** One course (lead / deal) on a pipeline card, with its price, delivery plan and live invoice. */
export type CardCourse = {
  lead_id: number;
  lead_code: string;
  course: CourseRef | null;
  stage: string;
  value?: Money;
  price_basis?: "Approved fee" | "Standard fee" | "Admitted fee";
  delivery_plan?: { plan_code: string; status: string } | null;
  invoice?: { invoice_id: number; invoice_number: string; status: string; billed_amount: Money } | null;
};

/** Pipeline card: one person at one branch; their open courses share its stage. */
export type PipelineCard = {
  pipeline_entry_id: number;
  entry_code: string;
  stage: string;
  person: PersonRef;
  branch: BranchRef;
  owner: UserRef | null;
  next_follow_up_at: DateTime | null;
  ai_priority: string | null;
  ai_score: number | null;
  stage_changed_at: DateTime;
  expected_close_date: DateOnly | null;
  courses: CardCourse[];
  value?: Money;
  delivery_plan_status?: string;
};

export type PipelineEntry = PipelineCard & {
  is_open: boolean;
  closed_at: DateTime | null;
  leads: { lead_id: number; lead_code: string; branch_code: string; course_code: string | null; stage: string }[];
  lost: { reason: string | null; competitor: string | null; notes: string | null; reactivation_date: DateOnly | null } | null;
  created_at: DateTime;
};

export type StageChip = { stage: string; label: string; count: number };
export type BoardColumn = { key: string; label: string; stages: string[]; count: number; value: Money; cards: PipelineCard[] };
export type PipelineBoard = {
  chips: StageChip[];
  stage: string | null;
  columns: BoardColumn[];
  total: number;
  stats: { open_opportunities: number; open_value: Money; admitted: number };
};

export type NextAction = {
  action: "review_payment" | "record_demo_outcome" | "confirm_delivery_plan" | "prepare_invoice" | "follow_up_balance";
  title: string;
  detail: string;
  pipeline_entry_id: number;
  entry_code: string;
  stage: string;
  lead_id: number;
  lead_code: string;
  course: CourseRef | null;
  person: PersonRef;
  branch: BranchRef;
  owner: UserRef | null;
  invoice: { invoice_id: number; invoice_number: string } | null;
  next_follow_up_at: DateTime | null;
};

export type PipelineFilters = {
  branch_id?: number;
  course_id?: number;
  source_id?: number;
  priority?: string;
  q?: string;
  owner_id?: string; // "me" | "unassigned" | user id
  stage?: string;
  per_stage?: number;
};

/** Stages a user may move a card into by hand. The rest are system-set:
 *  Payment Pending Verification (a payment is recorded), Admitted (its last course is admitted), Lost (Mark lost, with a reason). */
export const MANUAL_STAGES = ["Counselling", "Demo Scheduled", "Demo Attended", "Fee Discussion / Payment Awaited"];
export const PROTECTED_STAGES = ["Payment Pending Verification", "Admitted", "Lost - closed"];

export type CardStageBody = {
  stage: string;
  note?: string | null;
  lost_reason_id?: number | null;
  lost_competitor?: string | null;
  lost_notes?: string | null;
  reactivation_date?: DateOnly | null;
};

export const pipelineApi = {
  board: (filters: PipelineFilters) => get<PipelineBoard>("/pipeline", { ...filters, view: "kanban" } as Query),
  table: (filters: PipelineFilters & { page?: number; per_page?: number }) =>
    list<PipelineCard>("/pipeline", { ...filters, view: "table" } as Query),
  get: (entryId: number) => get<PipelineEntry>(`/pipeline-entries/${entryId}`),
  moveStage: (entryId: number, body: CardStageBody) => post<PipelineEntry>(`/pipeline-entries/${entryId}/stage`, body),
  update: (entryId: number, body: { assigned_to?: number; next_follow_up_at?: DateTime; expected_close_date?: DateOnly | null }) =>
    patch<PipelineEntry>(`/pipeline-entries/${entryId}`, body),
  nextActions: (filters: { branch_id?: number; q?: string }) => get<NextAction[]>("/pipeline/next-actions", filters as Query),
};

export const pipelineKeys = {
  all: ["pipeline"] as const,
  board: (filters: PipelineFilters) => ["pipeline", "board", filters] as const,
  table: (filters: PipelineFilters & { page?: number }) => ["pipeline", "table", filters] as const,
  entry: (id: number) => ["pipeline", "entry", id] as const,
  nextActions: (filters: object) => ["pipeline", "next-actions", filters] as const,
};
