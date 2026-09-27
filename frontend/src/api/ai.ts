/** AI Copilot / Ask Nipuna. Every output is advisory and needs human review; without an LLM key the API answers rule-based. */
import { useQuery } from "@tanstack/react-query";
import { get, post, type Query } from "./client";
import type { DateOnly, DateTime } from "./types";

export const AI_FEEDBACK_RATINGS = [
  "Helpful",
  "Incorrect",
  "Not Useful",
  "Missing Context",
] as const;
export const AI_LANGUAGES = ["English", "Telugu"] as const;

export type AiSource = {
  type: string;
  name?: string;
  from?: string;
  to?: string;
  [key: string]: unknown;
};

export type AiInsight = {
  insight_id: number;
  insight_type: string;
  lead_id: number | null;
  person_id: number | null;
  branch_id: number | null;
  for_user_id: number | null;
  content: string;
  suggested_message: string | null;
  score: number | null;
  priority: string | null;
  language: string;
  evidence_as_of: DateTime | null;
  sources: AiSource[] | null;
  model: string | null;
  requires_human_review: boolean;
  created_at: DateTime;
};

export type AiAnswer = {
  query_id: number;
  question: string;
  language: string;
  branch_id: number | null;
  period_start: DateOnly;
  period_end: DateOnly;
  report_cutoff_at: DateTime;
  answer: string;
  recorded_facts: string;
  possible_explanation: string;
  missing_evidence: string;
  data_freshness: string;
  sources: AiSource[];
  supporting_table: Record<string, unknown> | null;
  model: string | null;
  requires_human_review: boolean;
  created_at: DateTime;
};

export type AskBody = {
  question: string;
  language?: string;
  period?: string;
  from?: string;
  to?: string;
  branch_id?: number;
};
export type FeedbackBody = {
  insight_id?: number;
  query_id?: number;
  rating: string;
  comment?: string | null;
};

export const aiApi = {
  managementBrief: (query: { period?: string; branch_id?: number }) =>
    get<AiInsight>("/ai/management-brief", query as Query),
  ask: (body: AskBody) => post<AiAnswer>("/ai/ask", body),
  nextBestAction: (limit = 10) =>
    post<AiInsight[]>("/ai/next-best-action", { limit }),
  leadBrief: (leadId: number, language?: string) =>
    post<{ brief: AiInsight; priority_explanation: AiInsight }>(
      `/leads/${leadId}/ai/brief`,
      { language },
    ),
  feedback: (body: FeedbackBody) =>
    post<{ feedback_id: number }>("/ai/feedback", body),
};

export const aiKeys = {
  all: ["ai"] as const,
  brief: (query: { period?: string; branch_id?: number }) =>
    ["ai", "brief", query] as const,
};

export const useManagementBrief = (
  query: { period?: string; branch_id?: number },
  enabled = true,
) =>
  useQuery({
    queryKey: aiKeys.brief(query),
    queryFn: () => aiApi.managementBrief(query),
    enabled,
    staleTime: 5 * 60_000,
  });
