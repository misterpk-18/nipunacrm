import { get, list, patch, post, put, type Query } from "./client";
import type { DateOnly, DateTime, PersonRef } from "./types";

export const EMPLOYMENT_TYPES = ["Full-time", "Part-time", "Internship", "Contract"];
export const WORK_MODES = ["On-site", "Hybrid", "Remote"];
export const JOB_STATUSES = ["Review Required", "Open", "On Hold", "Closed", "Filled"];
export const PLACEMENT_READINESS = ["Not Yet Assessed", "In Preparation", "Ready", "Not Seeking"];
export const CV_REVIEW_STATUSES = ["No CV", "Review Pending", "Approved", "Changes Requested"];
export const EVIDENCE_STATUSES = ["Student Reported", "Verification Pending", "Verified"];
export const APPLICATION_STAGES = [
  "Applied",
  "Shortlisted",
  "Interview Scheduled",
  "Interview Attended",
  "Selected",
  "Offer Received",
  "Offer Accepted",
  "Joined",
  "Rejected",
  "Withdrawn",
  "Offer Declined",
];
export const CLOSED_STAGES = ["Joined", "Rejected", "Withdrawn", "Offer Declined"];
export const APPLICATION_EVENT_TYPES = ["Interview Scheduled", "Interview No-show", "Note", "Evidence Added"];

export type Company = {
  company_id: number;
  company_name: string;
  industry: string | null;
  website: string | null;
  city: string | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  notes: string | null;
  is_active: boolean;
};

export type JobOpening = {
  job_opening_id: number;
  job_code: string;
  company_name: string;
  company_id: number;
  job_title: string;
  employment_type: string;
  location: string | null;
  work_mode: string;
  branch_id: number | null;
  required_skills: string | null;
  salary_ctc: string | null;
  openings_count: number | null;
  closing_date: DateOnly | null;
  source: string | null;
  last_verified_at: DateTime | null;
  status: string;
  placement_owner_id: number | null;
};

export type PlacementProfile = {
  profile_id: number;
  person: PersonRef;
  cv_version: number | null;
  consent_status: string;
  consent_recorded_by: number | null;
  consent_recorded_at: DateTime | null;
  readiness: string;
  cv_file_path: string | null;
  cv_review_status: string;
  skills: string | null;
  projects: string | null;
  qualification: string | null;
  career_gap_notes: string | null;
  expected_salary: string | null;
  preferred_location: string | null;
  preferred_mode: string | null;
  preferred_role: string | null;
  evidence_status: string;
  placement_owner_id: number | null;
};

export type ProfileInput = Partial<Omit<PlacementProfile, "profile_id" | "person" | "cv_version" | "consent_status" | "consent_recorded_by" | "consent_recorded_at">>;

export type ApplicationEvent = {
  event_id: number;
  event_type: string;
  from_stage: string | null;
  to_stage: string | null;
  notes: string | null;
  recorded_by: number | null;
  occurred_at: DateTime;
};

export type JobApplication = {
  application_id: number;
  profile_id: number;
  person: PersonRef;
  job_opening_id: number;
  job_code: string;
  job_title: string;
  stage: string;
  stage_changed_at: DateTime | null;
  interview_at: DateTime | null;
  offer_ctc: string | null;
  joined_date: DateOnly | null;
  evidence_status: string;
  notes: string | null;
  events: ApplicationEvent[];
};

export type AlumniRow = {
  person_id: number;
  person_code: string;
  full_name: string;
  alumni_since: DateOnly;
  completed_admissions: number;
  is_also_active: boolean;
  support_until: DateOnly | null;
  support_active: boolean;
};

export type StudentRow = {
  person_id: number;
  person_code: string;
  full_name: string;
  phone: string;
  registered_branch: { branch_id: number; branch_code: string; branch_name: string };
  active_courses: string[];
};

export type CompanyInput = Partial<Omit<Company, "company_id">> & { company_name?: string };
export type JobInput = Partial<Omit<JobOpening, "job_opening_id" | "job_code" | "company_name" | "last_verified_at">> & { verified?: boolean };

export const placementApi = {
  companies: (q?: string) => get<Company[]>("/companies", { q }),
  createCompany: (body: CompanyInput) => post<Company>("/companies", body),
  updateCompany: (id: number, body: CompanyInput) => patch<Company>(`/companies/${id}`, body),
  jobs: (filters: { page?: number; status?: string; company_id?: number; branch_id?: number; work_mode?: string; per_page?: number }) =>
    list<JobOpening>("/job-openings", filters as Query),
  createJob: (body: JobInput) => post<JobOpening>("/job-openings", body),
  updateJob: (id: number, body: JobInput) => patch<JobOpening>(`/job-openings/${id}`, body),
  profile: (personId: number) => get<PlacementProfile | null>(`/persons/${personId}/placement-profile`),
  saveProfile: (personId: number, body: ProfileInput) => put<PlacementProfile>(`/persons/${personId}/placement-profile`, body),
  consent: (profileId: number, consent_status: "Explicit Consent" | "Withdrawn") =>
    post<PlacementProfile>(`/placement-profiles/${profileId}/consent`, { consent_status }),
  applications: (filters: { profile_id?: number; job_opening_id?: number; stage?: string }) => get<JobApplication[]>("/job-applications", filters),
  apply: (body: { profile_id: number; job_opening_id: number; notes?: string | null }) => post<JobApplication>("/job-applications", body),
  changeStage: (
    id: number,
    body: { stage: string; interview_at?: DateTime | null; offer_ctc?: string | null; joined_date?: DateOnly | null; evidence_status?: string; notes?: string | null },
  ) => post<JobApplication>(`/job-applications/${id}/stage`, body),
  addEvent: (id: number, body: { event_type: string; interview_at?: DateTime | null; notes?: string | null }) =>
    post<JobApplication>(`/job-applications/${id}/events`, body),
  alumni: (filters: { page?: number; q?: string; support_active?: boolean }) => list<AlumniRow>("/alumni", filters as Query),
  students: (filters: { page?: number; q?: string; branch_id?: number }) => list<StudentRow>("/students", { ...filters, per_page: 10 } as Query),
};

export const placementKeys = {
  all: ["placement"] as const,
  companies: (q?: string) => ["placement", "companies", q ?? ""] as const,
  jobs: (filters: object) => ["placement", "jobs", filters] as const,
  profile: (personId: number) => ["placement", "profile", personId] as const,
  applications: (filters: object) => ["placement", "applications", filters] as const,
  alumni: (filters: object) => ["placement", "alumni", filters] as const,
  students: (filters: object) => ["placement", "students", filters] as const,
};
