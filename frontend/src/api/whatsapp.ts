/** WhatsApp: the message list and summary, a person's conversation and consent, retry, and marketing templates sent from a lead. */
import { useQuery } from "@tanstack/react-query";
import { get, list, post, put, type Query } from "./client";
import type { DateTime } from "./types";

export const WHATSAPP_STATUSES = ["Queued", "Sent", "Delivered", "Read", "Failed", "Skipped"] as const;
export type WhatsappStatus = (typeof WHATSAPP_STATUSES)[number];
export const WHATSAPP_CATEGORIES = ["Utility", "Marketing", "Authentication"] as const;
export const CONSENT_STATUSES = ["Not Recorded", "Explicit Consent", "Withdrawn"] as const;
export type ConsentStatus = (typeof CONSENT_STATUSES)[number];

export type WhatsappMessage = {
  outbox_id: number;
  event_key: string;
  template_name: string;
  category: "Utility" | "Marketing" | "Authentication";
  /** null: an LMS message to someone the CRM has no record of (a staff invite) */
  person_id: number | null;
  person_name?: string | null;
  branch_id: number | null;
  branch_name?: string | null;
  /** LMS = sent for the LMS through POST /lms/whatsapp (db 045); the LMS resends its own messages */
  sent_by?: "CRM" | "LMS";
  to_phone: string | null;
  recipient_kind?: "Learner" | "Staff" | "Not in the CRM";
  recipient_user_id?: number | null;
  recipient_name?: string | null;
  body_text: string;
  source_type: string | null;
  source_id: number | null;
  status: WhatsappStatus;
  skip_reason: string | null;
  attempts: number;
  provider_message_id: string | null;
  last_error: string | null;
  created_at: DateTime;
  sent_at: DateTime | null;
  delivered_at: DateTime | null;
  read_at: DateTime | null;
};

export type WhatsappConsent = { status: ConsentStatus; at: DateTime | null; by: number | null; source: string | null };

export type OutboundItem = WhatsappMessage & { direction: "Outbound"; at: DateTime };
export type InboundItem = { direction: "Inbound"; at: DateTime; communication_id: number; body_text: string | null; status: "Received" };
export type ConversationItem = OutboundItem | InboundItem;

export type PersonWhatsapp = {
  person: { person_id: number; person_code: string; full_name: string; phone: string; email: string | null };
  whatsapp_number: string | null;
  consent: WhatsappConsent;
  /** The notifications switch (db 044). */
  notifications: boolean;
  messages: ConversationItem[];
};

export type WhatsappFilters = { page?: number; per_page?: number; status?: string; category?: string; branch_id?: number; person_id?: number; template?: string; q?: string };
export type WhatsappSummary = { counts: Partial<Record<WhatsappStatus, number>>; total: number; sending: boolean; test_numbers_only: boolean };

export type MarketingTemplate = {
  key: string;
  label: string;
  template_name: string;
  needs: ("course" | "interest")[];
  reply_keywords: string[];
  about: string;
};
export type MarketingSend = { template: string; course_id?: number; interest?: string };

export const whatsappApi = {
  list: (filters: WhatsappFilters) => list<WhatsappMessage>("/whatsapp/messages", filters as Query),
  summary: (branchId?: number) => get<WhatsappSummary>("/whatsapp/summary", { branch_id: branchId }),
  person: (personId: number) => get<PersonWhatsapp>(`/persons/${personId}/whatsapp`),
  retry: (id: number, confirmNotDelivered = false) => post<WhatsappMessage>(`/whatsapp/messages/${id}/retry`, confirmNotDelivered ? { confirm_not_delivered: true } : {}),
  setConsent: (personId: number, status: ConsentStatus, source?: string) =>
    put<WhatsappConsent>(`/persons/${personId}/whatsapp-consent`, { status, ...(source ? { source } : {}) }),
  setNotifications: (personId: number, enabled: boolean) =>
    put<{ notifications: boolean; consent: WhatsappConsent }>(`/persons/${personId}/whatsapp-notifications`, { enabled }),
  sendToPerson: (personId: number, body: MarketingSend) => post<WhatsappMessage>(`/persons/${personId}/whatsapp/send`, body),
  templates: () => get<MarketingTemplate[]>("/whatsapp/marketing-templates"),
  sendMarketing: (leadId: number, body: MarketingSend) => post<WhatsappMessage>(`/leads/${leadId}/whatsapp/marketing`, body),
};

export const whatsappKeys = {
  all: ["whatsapp"] as const,
  list: (filters: WhatsappFilters) => ["whatsapp", "list", filters] as const,
  summary: (branchId?: number) => ["whatsapp", "summary", branchId ?? null] as const,
  person: (personId: number) => ["whatsapp", "person", personId] as const,
  templates: ["whatsapp", "templates"] as const,
};

/** Keys to refresh after any change to messages or consent (consent also shows on the person and the lead). */
export const whatsappInvalidate = (personId?: number) => [
  personId ? whatsappKeys.person(personId) : whatsappKeys.all,
  whatsappKeys.all,
  ["persons"],
  ["leads"],
];

export const useWhatsappMessages = (filters: WhatsappFilters) =>
  useQuery({ queryKey: whatsappKeys.list(filters), queryFn: () => whatsappApi.list(filters), placeholderData: (prev) => prev });
export const useWhatsappSummary = (branchId?: number) =>
  useQuery({ queryKey: whatsappKeys.summary(branchId), queryFn: () => whatsappApi.summary(branchId), staleTime: 30_000 });
export const usePersonWhatsapp = (personId: number) => useQuery({ queryKey: whatsappKeys.person(personId), queryFn: () => whatsappApi.person(personId) });
export const useMarketingTemplates = (enabled = true) =>
  useQuery({ queryKey: whatsappKeys.templates, queryFn: whatsappApi.templates, staleTime: 10 * 60_000, enabled });

export type Tone = "good" | "warn" | "danger" | "neutral" | "info";

/** Delivery status → chip tone. */
export function statusTone(status: string): Tone {
  switch (status) {
    case "Delivered":
    case "Read":
      return "good";
    case "Sent":
      return "info";
    case "Failed":
      return "danger";
    case "Queued":
    case "Skipped":
      return "warn";
    default:
      return "neutral";
  }
}

export function consentTone(status: string): Tone {
  return status === "Explicit Consent" ? "good" : status === "Withdrawn" ? "danger" : "neutral";
}

/** Why a message did not go out: the error for Failed, the skip reason for Skipped. */
export function problemOf(m: Pick<WhatsappMessage, "status" | "last_error" | "skip_reason">): string | null {
  if (m.status === "Failed") return m.last_error;
  if (m.status === "Skipped") return m.skip_reason;
  return null;
}

export const canRetry = (m: Pick<WhatsappMessage, "status" | "sent_by">) => m.sent_by !== "LMS" && (m.status === "Failed" || m.status === "Skipped");

/** The server asks for confirmation when the provider's answer was lost. */
export const needsDeliveryCheck = (message: string) => message.startsWith("The provider's answer was lost");
