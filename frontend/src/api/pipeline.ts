import { get, list, post, type Query } from "./client";
import type { Lead, LeadRow } from "./leads";

export type PipelineStage = { stage: string; count: number; leads: LeadRow[] };
export type PipelineBoard = { total: number; stages: PipelineStage[] };

export type PipelineFilters = {
  branch_id?: number;
  course_id?: number;
  source_id?: number;
  priority?: string;
  q?: string;
  owner_id?: string; // "me" | "unassigned" | user id
  per_stage?: number;
};

/** Stages a user may move a lead into by hand. The rest are system-set:
 *  Payment Pending Verification (a payment is recorded), Admitted (an admission is created), Lost (Mark lost, with a reason). */
export const MANUAL_STAGES = ["New Enquiry", "Counselling", "Demo Scheduled", "Demo Attended", "Fee Discussion / Payment Awaited"];
export const PROTECTED_STAGES = ["Payment Pending Verification", "Admitted", "Lost - closed"];

export const pipelineApi = {
  board: (filters: PipelineFilters) => get<PipelineBoard>("/pipeline", { ...filters, view: "kanban" } as Query),
  table: (filters: PipelineFilters & { page?: number; per_page?: number }) =>
    list<LeadRow>("/pipeline", { ...filters, view: "table" } as Query),
  moveStage: (leadId: number, stage: string, note?: string) => post<Lead>(`/leads/${leadId}/stage`, { stage, note }),
};

export const pipelineKeys = {
  all: ["pipeline"] as const,
  board: (filters: PipelineFilters) => ["pipeline", "board", filters] as const,
  table: (filters: PipelineFilters & { page?: number }) => ["pipeline", "table", filters] as const,
};
