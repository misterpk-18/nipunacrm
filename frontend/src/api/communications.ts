import { list, post } from "./client";
import type { DateTime } from "./types";

export const COMM_QUEUES = ["Awaiting Reply", "Failed Communications", "Manual Activity", "Match Review", "Missed Calls", "Other"] as const;
export const SLA_STATES = ["Within SLA", "At Risk", "Breached", "Met", "Met Late"] as const;
export const MATCH_STATUSES = ["Matched", "Match Review", "Unmatched"] as const;
export const DELIVERY_STATUSES = ["Received", "Sent", "Delivered", "Read", "Failed", "Missed"] as const;

export type Communication = {
  communication_id: number;
  branch_id: number;
  channel: string;
  contact_channel_id: number;
  direction: "Inbound" | "Outbound";
  from_address: string | null;
  to_address: string | null;
  subject: string | null;
  body: string | null;
  call_duration_seconds: number | null;
  delivery_status: string;
  failure_reason: string | null;
  retry_of_id: number | null;
  is_manual: boolean;
  match_status: string;
  person_id: number | null;
  lead_id: number | null;
  matched_by: number | null;
  needs_response: boolean;
  response_due_at: DateTime | null;
  responded_at: DateTime | null;
  handled_by: number | null;
  occurred_at: DateTime;
  /** Present on inbox rows. */
  queue?: string;
  sla_state?: string | null;
};

export type CommFilters = { page?: number; per_page?: number; queue?: string; sla_state?: string; match_status?: string; branch_id?: number };

export type NewCommunication = {
  branch_id: number;
  contact_channel_id: number;
  direction: "Inbound" | "Outbound";
  delivery_status: string;
  from_address?: string | null;
  to_address?: string | null;
  subject?: string | null;
  body?: string | null;
  call_duration_seconds?: number | null;
  failure_reason?: string | null;
  person_id?: number | null;
  lead_id?: number | null;
  needs_response?: boolean;
  response_due_at?: DateTime | null;
  occurred_at?: DateTime | null;
};

export const communicationsApi = {
  list: (filters: CommFilters) => list<Communication>("/communications", filters),
  record: (body: NewCommunication) => post<Communication>("/communications", body),
  reply: (id: number, body: { body: string; subject?: string | null; delivery_status?: string }) => post<Communication>(`/communications/${id}/reply`, body),
  retry: (id: number, body: { delivery_status?: string; failure_reason?: string | null } = {}) => post<Communication>(`/communications/${id}/retry`, body),
  match: (id: number, person_id: number, lead_id?: number | null) => post<Communication>(`/communications/${id}/match`, { person_id, lead_id: lead_id ?? null }),
};

export const communicationKeys = {
  all: ["communications"] as const,
  list: (filters: CommFilters) => ["communications", "list", filters] as const,
};
