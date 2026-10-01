import { useQuery } from "@tanstack/react-query";
import { get, list, patch, post, upload, type Query } from "./client";
import type { BranchRef, CourseRef, DateOnly, DateTime, Money, PersonRef, UserRef } from "./types";
import type { Admission, AdmissionRow, Allocation, Balance, MappedCurriculum } from "./admissions";

export const SUPPORT_CASE_STATUSES = ["Open", "In Progress", "Waiting on Student", "Resolved", "Closed"];
export const CERTIFICATE_DECISIONS = ["Eligibility Pending", "Eligible", "Not Eligible"];

export type StudentRow = {
  person_id: number;
  person_code: string;
  full_name: string;
  phone: string;
  email: string | null;
  registered_branch: BranchRef;
  admissions: number;
  active_courses: string[];
  verified_paid: Money;
  outstanding: Money;
  lms_statuses: string[];
};

export type PersonDetail = {
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

export type Student = StudentRow & {
  person: PersonDetail;
  is_alumni: boolean;
  is_active: boolean;
  admission_summaries: { admission_id: number; admission_code: string; course: CourseRef; enrolment_status: string }[];
};

export type InvoiceRow = {
  invoice_id: number;
  invoice_number: string;
  status: string;
  billed_amount: Money;
  courses: { invoice_line_id: number; course: CourseRef; billed_amount: Money }[];
  collecting_branch: BranchRef;
  payment_plan: { plan_code: string; plan_name: string } | null;
  issued_on: DateOnly;
  admitted_lines: number;
  verified_paid: Money;
  pending_verification: Money;
  outstanding: Money;
  payment_completion: string;
  invoice_state: string;
};

export type PaymentRow = {
  payment_id: number;
  transaction_number: string;
  receipt_number: string | null;
  entry_type: string;
  amount: Money;
  payment_date: DateOnly;
  mode: string;
  reference: string | null;
  invoice: { invoice_id: number; invoice_number: string } | null;
  admission_id: number | null;
  verification_status: string;
  recorded_by: UserRef | null;
};

export type Certificate = {
  certificate_id: number;
  certificate_number: string | null;
  admission_id: number;
  course: CourseRef;
  status: string;
  eligibility_notes: string | null;
  issued_by: number | null;
  issued_at: DateTime | null;
  revoked_by: number | null;
  revoked_at: DateTime | null;
  revoke_reason: string | null;
  /** LMS register (db 028): a reissue keeps the number with a new version; the earlier one is Superseded. */
  version: number;
  certificate_type: string | null;
  holder_name: string | null;
  enrolment_code: string | null;
  issued_by_email: string | null;
  revoked_by_email: string | null;
  reissue_reason: string | null;
  supersedes_version: number | null;
  lms_mirrored: boolean;
};

export type StudentDocument = {
  document_id: number;
  person_id: number;
  admission_id: number | null;
  document_type: { document_type_id: number; code: string; label: string; is_mandatory: boolean };
  status: string;
  original_filename: string | null;
  mime_type: string | null;
  file_size_bytes: number | null;
  uploaded_by: number | null;
  uploaded_at: DateTime;
  reviewed_by: number | null;
  reviewed_at: DateTime | null;
  rejection_reason: string | null;
};

export type ChecklistRow = { document_type_id: number; document_type: string; status: string; document_id: number | null; uploaded_at: DateTime | null };

export type SupportCase = {
  support_case_id: number;
  case_code: string;
  person: PersonRef;
  admission_id: number | null;
  branch: BranchRef;
  case_type: string;
  subject: string;
  description: string | null;
  status: string;
  owner: UserRef | null;
  refund_case_id: number | null;
  resolution_notes: string | null;
  opened_by: number | null;
  opened_at: DateTime;
  resolved_at: DateTime | null;
};

export type RefundCaseRow = {
  refund_case_id: number;
  case_code: string;
  admission: { admission_id: number; admission_code: string; course: CourseRef; enrolment_status: string };
  status: string;
  requested_at: DateTime;
  refund_decision: string | null;
  payout_status: string | null;
};

export type TimelineEvent = { at: DateTime; kind: string; title: string; detail: string | null };

export type AuditEntry = {
  audit_id: number;
  occurred_at: DateTime;
  actor_user_id: number | null;
  action: string;
  entity_type: string;
  entity_id: string;
  old_values: Record<string, unknown> | null;
  new_values: Record<string, unknown> | null;
  reason: string | null;
};

export type PlacementTab = {
  profile: { profile_id: number; readiness: string; consent_status: string; cv_review_status: string; evidence_status: string; preferred_role: string | null; preferred_location: string | null; skills: string | null } | null;
  applications: { application_id: number; job_code: string; job_title: string; stage: string; stage_changed_at: DateTime; evidence_status: string }[];
};

export type StudentTabs = {
  admissions: Admission[];
  finance: { invoices: InvoiceRow[]; payments: PaymentRow[]; balances: (Balance & { admission_id: number; admission_code: string })[] };
  academic: {
    admissions: { admission_id: number; admission_code: string; course: CourseRef; enrolment_status: string }[];
    allocations: Allocation[];
    curricula: MappedCurriculum[];
    certificates: Certificate[];
  };
  documents: { documents: StudentDocument[]; checklist: ChecklistRow[] };
  timeline: TimelineEvent[];
  cases: { support_cases: SupportCase[]; refund_cases: RefundCaseRow[] };
  placement: PlacementTab;
  audit: AuditEntry[];
};

export type StudentTab = keyof StudentTabs;

export type StudentFilters = { page?: number; per_page?: number; branch_id?: number; enrolment_status?: string; lms_status?: string; q?: string };

/** Lead rows for a person (subset of GET /leads). */
export type PersonLead = { lead_id: number; lead_code: string; name: string; phone: string; course: CourseRef | null; branch: BranchRef; stage: string; owner: UserRef | null };

export const studentsApi = {
  list: (filters: StudentFilters) => list<StudentRow>("/students", filters as Query),
  get: (personId: number) => get<Student>(`/students/${personId}`),
  tab: <K extends StudentTab>(personId: number, tab: K) => get<StudentTabs[K]>(`/students/${personId}/${tab}`),
  person: (personId: number) => get<PersonDetail>(`/persons/${personId}`),
  leadsByPhone: (phone: string) => list<PersonLead>("/leads", { q: phone.replace(/\D/g, "").slice(-10), per_page: 50, lead_status: "All" }),
  uploadDocument: (personId: number, body: { document_type_id: number; admission_id?: number | null; file: File }) => {
    const form = new FormData();
    form.append("document_type_id", String(body.document_type_id));
    if (body.admission_id) form.append("admission_id", String(body.admission_id));
    form.append("file", body.file);
    return upload<StudentDocument>(`/persons/${personId}/documents`, form);
  },
  reviewDocument: (documentId: number, body: { status: "Verified" | "Rejected"; rejection_reason?: string | null }) =>
    post<StudentDocument>(`/documents/${documentId}/review`, body),
  createCertificate: (admissionId: number, body: { course_id?: number; status?: string; eligibility_notes?: string | null }) =>
    post<Certificate>(`/admissions/${admissionId}/certificates`, body),
  updateCertificate: (id: number, body: { status?: string; eligibility_notes?: string | null }) => patch<Certificate>(`/certificates/${id}`, body),
  issueCertificate: (id: number) => post<Certificate>(`/certificates/${id}/issue`, {}),
  revokeCertificate: (id: number, reason: string) => post<Certificate>(`/certificates/${id}/revoke`, { reason }),
  createCase: (body: { person_id: number; admission_id?: number | null; branch_id?: number | null; support_case_type_id: number; subject: string; description?: string | null; owner_user_id?: number | null }) =>
    post<SupportCase>("/support-cases", body),
  updateCase: (id: number, body: { status?: string; owner_user_id?: number | null; resolution_notes?: string | null }) =>
    patch<SupportCase>(`/support-cases/${id}`, body),
};

export const studentKeys = {
  all: ["students"] as const,
  list: (filters: StudentFilters) => ["students", "list", filters] as const,
  detail: (id: number) => ["students", "detail", id] as const,
  tab: (id: number, tab: StudentTab) => ["students", "tab", id, tab] as const,
  person: (id: number) => ["persons", id] as const,
};

export const useStudentTab = <K extends StudentTab>(personId: number, tab: K, enabled = true) =>
  useQuery({ queryKey: studentKeys.tab(personId, tab), queryFn: () => studentsApi.tab(personId, tab), enabled });

export type { AdmissionRow };
