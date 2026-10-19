import { get, list, patch, post, type Query } from "./client";
import type { Lead } from "./leads";
import type { BranchRef, CourseRef, DateTime, UserRef } from "./types";

/** Every enquiry, including website-form ones (db 047); an unconverted one has no lead yet. */
export type Enquiry = {
  enquiry_id: number;
  enquiry_code: string;
  lead_id: number | null;
  lead_code: string | null;
  person_id: number | null;
  branch: BranchRef;
  course: CourseRef | null;
  source: string;
  channel: string;
  entry_method: string;
  intake_status: string;
  is_genuine: boolean | null;
  owner: UserRef | null;
  raw_name: string | null;
  raw_phone: string | null;
  raw_email: string | null;
  message: string | null;
  attribution: Record<string, string> | null;
  whatsapp_consent: boolean | null;
  received_at: DateTime;
};

export type EnquiryMatches = {
  persons: { person_id: number; person_code: string; full_name: string; phone: string; email: string | null }[];
  open_leads: { lead_id: number; lead_code: string; branch_code: string; course_code: string | null; stage: string }[];
  enquiries: { enquiry_id: number; enquiry_code: string; raw_name: string | null; branch: BranchRef; source: string; intake_status: string; received_at: DateTime }[];
};

export type EnquiryFilters = { intake_status?: string; linked?: boolean; q?: string; branch_id?: number; page?: number; per_page?: number };

/** Staff may set these by hand; Duplicate Review is set by matching. */
export const TRIAGE_STATUSES = ["New", "Incomplete", "Outreach Prospect", "Invalid-Spam", "Test"] as const;

export const enquiriesApi = {
  list: (filters: EnquiryFilters) => list<Enquiry>("/enquiries", filters as Query),
  get: (id: number) => get<Enquiry & { matches: EnquiryMatches }>(`/enquiries/${id}`),
  update: (id: number, body: { intake_status?: string; is_genuine?: boolean }) => patch<Enquiry>(`/enquiries/${id}`, body),
  link: (id: number, lead_id: number) => post<Enquiry>(`/enquiries/${id}/link`, { lead_id }),
  convert: (id: number, body: { person_id?: number | null; course_id?: number | null; assigned_to?: number | null }) =>
    post<Lead>(`/enquiries/${id}/convert`, body),
};

export const enquiryKeys = {
  all: ["enquiries"] as const,
  list: (filters: EnquiryFilters) => ["enquiries", "list", filters] as const,
  detail: (id: number) => ["enquiries", "detail", id] as const,
};
