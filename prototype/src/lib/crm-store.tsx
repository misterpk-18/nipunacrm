import { createContext, useContext, useMemo, useRef, useState, type ReactNode } from "react";

/* ------------------------------------------------------------------
 * Shared synthetic prototype state. Every record is fictional.
 * All effects live only in browser memory; Reset restores fixtures.
 * ------------------------------------------------------------------ */

export const SAMPLE_NOTICE = "SAMPLE DATA — NO LIVE INTEGRATIONS";
export const SAMPLE_TODAY = "2026-09-26"; // Saturday · IST · fixed prototype date
export type BranchName = "Guntur" | "Vijayawada";
export const branchCode = (b: BranchName) => (b === "Guntur" ? "GNT" : "VIJ");

export const pipelineStages = [
  "New Enquiry",
  "Counselling",
  "Demo Scheduled",
  "Demo Attended",
  "Fee Discussion / Payment Awaited",
  "Payment Pending Verification",
  "Admitted",
  "Lost - closed",
] as const;
export const protectedStages = ["Payment Pending Verification", "Admitted", "Lost - closed"];
export const paymentMethods = ["Cash", "UPI/Bank Transfer", "Payment Link/Gateway/Card", "Cheque-Exception"] as const;
export const sources = ["Website", "Walk-in", "Referral", "Google Ads", "Organic Social Media", "College Data", "Meta Ads"];
export const channels = ["Phone call", "WhatsApp", "Web form", "In person", "Email", "Outbound call"];
export const entryMethods = ["Staff entered", "Website", "Walk-in desk", "Google Ads form", "Bulk outreach import", "Synthetic CSV import"];
export const intakeStatuses = ["New", "Incomplete", "Duplicate Review", "Invalid-Spam", "Outreach Prospect", "Test"];

export const courseCatalog = [
  { code: "NIT-CRS-018", name: "Data Science", fee: 30000 },
  { code: "NIT-CRS-047", name: "Java Full Stack", fee: 25000 },
  { code: "NIT-CRS-052", name: "Python Full Stack", fee: 24000 },
  { code: "NIT-CRS-007", name: "AWS with DevOps", fee: 22000 },
  { code: "NIT-CRS-019", name: "Power BI", fee: 22000 },
  { code: "NIT-CRS-028", name: "Digital Marketing", fee: 25000 },
  { code: "NIT-CRS-025", name: "Graphic Design", fee: 18000 },
  { code: "NIT-CRS-026", name: "Video Editing", fee: 22000 },
];
export const courseCode = (name: string) => courseCatalog.find((c) => c.name === name)?.code ?? "NIT-CRS-—";

export type Staff = { id: string; name: string; role: string; branch: BranchName };
export const staff: Staff[] = [
  { id: "GNT-SAL-A", name: "Counsellor A (GNT)", role: "Sales", branch: "Guntur" },
  { id: "GNT-FO-B", name: "Front Office B (GNT)", role: "Front Office", branch: "Guntur" },
  { id: "GNT-BM", name: "Branch Manager (GNT) · cover", role: "Branch Manager", branch: "Guntur" },
  { id: "VIJ-SAL-C", name: "Counsellor C (VIJ)", role: "Sales", branch: "Vijayawada" },
  { id: "VIJ-FO-D", name: "Front Office D (VIJ)", role: "Front Office", branch: "Vijayawada" },
  { id: "VIJ-BM", name: "Branch Manager (VIJ) · cover", role: "Branch Manager", branch: "Vijayawada" },
  { id: "GNT-TR-1", name: "Trainer G1", role: "Trainer", branch: "Guntur" },
  { id: "GNT-TR-2", name: "Trainer G2", role: "Trainer", branch: "Guntur" },
  { id: "VIJ-TR-1", name: "Trainer V1", role: "Trainer", branch: "Vijayawada" },
  { id: "VIJ-TR-2", name: "Trainer V2", role: "Trainer", branch: "Vijayawada" },
  { id: "GNT-ACC", name: "Accounts (GNT)", role: "Accounts", branch: "Guntur" },
  { id: "VIJ-ACC", name: "Accounts (VIJ)", role: "Accounts", branch: "Vijayawada" },
];
/** Lead owners: Sales -> Front Office -> approved manager cover. Trainers never own leads. */
export const ownerOptions = (branch: BranchName) =>
  staff.filter((s) => s.branch === branch && ["Sales", "Front Office", "Branch Manager"].includes(s.role));
export const trainers = (branch?: BranchName) => staff.filter((s) => s.role === "Trainer" && (!branch || s.branch === branch));

export type TimelineEvent = { at: string; title: string; detail: string };
export type Person = { id: string; name: string; phone: string; altPhone?: string | undefined; email: string; whatsapp: string; originalBranch: BranchName };
export type Lead = {
  id: string;
  personId: string;
  name: string;
  phone: string;
  altPhone?: string | undefined;
  email: string;
  whatsapp: string;
  course: string;
  branch: BranchName;
  source: string;
  campaign: string;
  channel: string;
  entryMethod: string;
  intakeStatus: string;
  owner: string;
  stage: string;
  followUp: string;
  originalDeadline?: string | undefined;
  age: string;
  priority: string;
  score: number;
  remarks: string;
  createdOn: string;
  timeline: TimelineEvent[];
};
export type InvoiceState = "Issued" | "Part Paid" | "Paid" | "Superseded";
export type Invoice = {
  id: string;
  personId: string;
  leadId: string;
  admissionId: string | null;
  course: string;
  branch: BranchName; // collecting branch
  issuedOn: string;
  billed: number;
  standardFee: number;
  terms: string;
  plan: "Full" | "50/50" | "50/25/25";
  day0: string;
  secondDay?: number;
};
export type Payment = {
  id: string; // receipt or reversal reference
  invoiceId: string;
  amount: number; // negative for reversal events
  method: string;
  collector: string;
  at: string;
  reference: string;
  kind: "Payment" | "Reversal / Correction";
  linkedTo?: string;
  reason?: string;
  approvedBy?: string;
  requestedBy?: string;
  proof: string;
};
export type CorrectionRequest = {
  id: string;
  paymentId: string;
  invoiceId: string;
  amount: number;
  reason: string;
  requestedBy: string;
  requestedAt: string;
  status: "Pending Approval" | "Approved" | "Rejected";
  decidedBy?: string;
  decidedAt?: string;
  decisionNote?: string | undefined;
  reversalId?: string | undefined;
};
export type VerificationEvent = { paymentId: string; result: "Verified" | "Failed"; by: string; at: string };
export type Admission = {
  id: string;
  personId: string;
  leadId: string;
  invoiceId: string;
  course: string;
  originalBranch: BranchName;
  serviceBranch: BranchName;
  collectingBranch: BranchName;
  curriculum: string | null;
  planAccepted: string; // accepted delivery plan
  firstQualifyingPayment: string;
  admittedOn: string;
  enrolment: string;
  batchId: string | null;
  allocatedOn?: string;
  firstAttendance?: string;
  deliveryMode: string;
};
export type Batch = {
  id: string;
  branch: BranchName;
  course: string;
  curriculum: string;
  trainer: string;
  mode: "Classroom" | "Online" | "Hybrid";
  start: string;
  end: string;
  timing: string;
  duration: string;
  days: string;
  location: string;
  minStudents: number;
  capacity: number;
  otherSeats: number; // synthetic seats held by unnamed sample learners
  status: string;
};
export type Demo = {
  id: string;
  leadId: string;
  branch: BranchName;
  course: string;
  at: string;
  duration: number;
  trainer: string;
  mode: string;
  status: "Scheduled" | "Rescheduled" | "Cancelled" | "Attended" | "No-show";
  reminders: { label: string; state: string }[];
  history: TimelineEvent[];
  exceptionApproval?: string | undefined;
  studentFeedback?: string;
  trainerFeedback?: string;
  outcome?: string;
  recommendedCourse?: string;
  nextAction?: string;
  commercialOwner?: string;
  nextFollowUp?: string;
};
export type Task = {
  id: string;
  type: string;
  title: string;
  branch: BranchName;
  owner: string;
  status: "Open" | "In Progress" | "Waiting/Blocked" | "Completed" | "Cancelled";
  original: string;
  revised?: string;
  record: string;
};

const tl = (at: string, title: string, detail: string): TimelineEvent => ({ at, title, detail });

const persons0: Person[] = [
  { id: "PER-GNT-00148", name: "Ananya Rao", phone: "+91 9XXXX 11001", email: "ananya.rao@example.test", whatsapp: "Same as mobile", originalBranch: "Guntur" },
  { id: "PER-GNT-00139", name: "Rohit Kumar", phone: "+91 9XXXX 11007", email: "rohit.kumar@example.test", whatsapp: "Same as mobile", originalBranch: "Guntur" },
  { id: "PER-GNT-00152", name: "Meghana Varma", phone: "+91 9XXXX 11003", email: "meghana.varma@example.test", whatsapp: "+91 9XXXX 21003", originalBranch: "Guntur" },
  { id: "PER-GNT-00157", name: "Harini Chowdary", phone: "+91 9XXXX 11005", email: "harini.c@example.test", whatsapp: "Same as mobile", originalBranch: "Guntur" },
  { id: "PER-VIJ-00131", name: "Vamsi Krishna", phone: "+91 9XXXX 11006", email: "vamsi.k@example.test", whatsapp: "Same as mobile", originalBranch: "Vijayawada" },
  { id: "PER-VIJ-00137", name: "Karthik Reddy", phone: "+91 9XXXX 11002", email: "karthik.reddy@example.test", whatsapp: "Same as mobile", originalBranch: "Vijayawada" },
  { id: "PER-VIJ-00142", name: "Sai Teja", phone: "+91 9XXXX 11004", email: "sai.teja@example.test", whatsapp: "Same as mobile", originalBranch: "Vijayawada" },
  { id: "PER-VIJ-00119", name: "Divya Lakshmi", phone: "+91 9XXXX 11008", email: "divya.l@example.test", whatsapp: "Same as mobile", originalBranch: "Vijayawada" },
];

const L = (p: Person, x: Omit<Lead, "personId" | "name" | "phone" | "email" | "whatsapp">): Lead => ({
  personId: p.id, name: p.name, phone: p.phone, email: p.email, whatsapp: p.whatsapp, ...x,
});
const P = (id: string) => persons0.find((p) => p.id === id)!;

const leads0: Lead[] = [
  L(P("PER-GNT-00148"), { id: "LD-24091", course: "Data Science", branch: "Guntur", source: "Organic Social Media", campaign: "—", channel: "WhatsApp", entryMethod: "Staff entered", intakeStatus: "New", owner: "Counsellor A (GNT)", stage: "Admitted", followUp: "Batch allocation follow-up · 27 Sep 10:00", age: "12d", priority: "Hot", score: 92, remarks: "Prefers weekend batch.", createdOn: "2026-09-14",
    timeline: [tl("24 Sep 11:30", "Admission created", "NIT-GNT-2026-000001 after plan acceptance + verified GNT-R-2627-00001"), tl("24 Sep 11:05", "Payment verified", "GNT-R-2627-00001 · ₹15,000 · Accounts (GNT)"), tl("22 Sep 16:00", "Demo attended", "Trainer G1 · positive feedback"), tl("14 Sep 10:10", "Enquiry captured", "Organic Social Media · WhatsApp")] }),
  L(P("PER-GNT-00148"), { id: "LD-24095", course: "Power BI", branch: "Guntur", source: "Referral", campaign: "Existing student referral", channel: "In person", entryMethod: "Staff entered", intakeStatus: "New", owner: "Counsellor A (GNT)", stage: "Demo Scheduled", followUp: "Today, 4:30 PM", originalDeadline: "Today, 4:00 PM", age: "2d", priority: "Warm", score: 74, remarks: "Second course enquiry for the same person.", createdOn: "2026-09-24",
    timeline: [tl("25 Sep 12:00", "Demo scheduled", "DM-GNT-0012 · 26 Sep 17:00"), tl("24 Sep 15:00", "Second enquiry", "Same Person · separate opportunity")] }),
  L(P("PER-GNT-00139"), { id: "LD-24052", course: "Java Full Stack", branch: "Guntur", source: "Walk-in", campaign: "—", channel: "In person", entryMethod: "Walk-in desk", intakeStatus: "New", owner: "Front Office B (GNT)", stage: "Admitted", followUp: "Collection follow-up · overdue", age: "20d", priority: "Warm", score: 80, remarks: "Relocating; service branch Vijayawada.", createdOn: "2026-09-06",
    timeline: [tl("21 Sep 18:10", "Linked reversal", "REV-GNT-2627-00001 reversed duplicate GNT-R-2627-00004"), tl("10 Sep 12:20", "Admission created", "NIT-GNT-2026-000002 · service branch Vijayawada")] }),
  L(P("PER-GNT-00152"), { id: "LD-24076", course: "Power BI", branch: "Guntur", source: "Walk-in", campaign: "—", channel: "In person", entryMethod: "Walk-in desk", intakeStatus: "Incomplete", owner: "Counsellor A (GNT)", stage: "Counselling", followUp: "Overdue 1d", age: "6d", priority: "Warm", score: 73, remarks: "Needs weekday evening timing.", createdOn: "2026-09-20", timeline: [tl("20 Sep 11:00", "Walk-in captured", "Qualification details incomplete")] }),
  L(P("PER-GNT-00157"), { id: "LD-24049", course: "Digital Marketing", branch: "Guntur", source: "Website", campaign: "—", channel: "Web form", entryMethod: "Website", intakeStatus: "New", owner: "Front Office B (GNT)", stage: "New Enquiry", followUp: "Unscheduled", age: "1d", priority: "Waiting for Batch / Future Joining", score: 41, remarks: "", createdOn: "2026-09-25", timeline: [tl("25 Sep 19:40", "Website enquiry", "Automated acknowledgement does not satisfy SLA")] }),
  L(P("PER-VIJ-00137"), { id: "LD-24088", course: "Java Full Stack", branch: "Vijayawada", source: "Google Ads", campaign: "GA-Search-JFS (sample)", channel: "Phone call", entryMethod: "Google Ads form", intakeStatus: "New", owner: "Counsellor C (VIJ)", stage: "Fee Discussion / Payment Awaited", followUp: "Today, 5:15 PM", age: "4d", priority: "Hot", score: 88, remarks: "Invoice issued; awaiting first payment.", createdOn: "2026-09-22",
    timeline: [tl("25 Sep 15:30", "Invoice issued · milestone", "INV-VIJ-2627-0003 · ₹25,000"), tl("24 Sep 11:00", "Demo attended", "Trainer V1 · 2 of 2 attended demos")] }),
  L(P("PER-VIJ-00142"), { id: "LD-24061", course: "AWS with DevOps", branch: "Vijayawada", source: "Referral", campaign: "Alumni referral (sample)", channel: "Phone call", entryMethod: "Staff entered", intakeStatus: "Duplicate Review", owner: "Front Office D (VIJ)", stage: "Demo Attended", followUp: "Tomorrow, 11 AM", age: "9d", priority: "Warm", score: 68, remarks: "Possible duplicate — review, never auto-merge.", createdOn: "2026-09-17", timeline: [tl("23 Sep 12:00", "Demo attended", "DM-VIJ-0007 · Trainer V2")] }),
  L(P("PER-VIJ-00131"), { id: "LD-24037", course: "Python Full Stack", branch: "Vijayawada", source: "College Data", campaign: "Outreach list Sep (sample)", channel: "Outbound call", entryMethod: "Bulk outreach import", intakeStatus: "Outreach Prospect", owner: "Counsellor C (VIJ)", stage: "Admitted", followUp: "Second instalment due today", age: "22d", priority: "Hot", score: 85, remarks: "Second instalment proof submitted; pending verification.", createdOn: "2026-09-04",
    timeline: [tl("26 Sep 09:40", "Payment proof received", "VIJ-R-2627-00004 · ₹6,000 · Pending Verification"), tl("12 Sep 12:15", "Admission created", "NIT-VIJ-2026-000001"), tl("12 Sep 11:50", "Payment verified", "VIJ-R-2627-00001 · ₹12,000")] }),
  L(P("PER-VIJ-00119"), { id: "LD-24010", course: "Graphic Design", branch: "Vijayawada", source: "Meta Ads", campaign: "Meta-Lead-GD (sample)", channel: "WhatsApp", entryMethod: "Staff entered", intakeStatus: "New", owner: "Front Office D (VIJ)", stage: "Admitted", followUp: "Refund case review", age: "30d", priority: "Cold", score: 30, remarks: "Refund case NIT-RF-26019 registered.", createdOn: "2026-08-27", timeline: [tl("15 Sep 10:00", "Refund case registered", "NIT-RF-26019 · evidence pending")] }),
];

const invoices0: Invoice[] = [
  { id: "INV-GNT-2627-0001", personId: "PER-GNT-00148", leadId: "LD-24091", admissionId: "NIT-GNT-2026-000001", course: "Data Science", branch: "Guntur", issuedOn: "2026-09-23", billed: 27000, standardFee: 30000, terms: "Standard ₹30,000 · approved concession ₹3,000 within floor (70% = ₹21,000) · no general campaign", plan: "50/25/25", day0: "2026-09-24" },
  { id: "INV-GNT-2627-0002", personId: "PER-GNT-00139", leadId: "LD-24052", admissionId: "NIT-GNT-2026-000002", course: "Java Full Stack", branch: "Guntur", issuedOn: "2026-09-09", billed: 25000, standardFee: 25000, terms: "Standard fee · no concession", plan: "50/50", day0: "2026-09-10", secondDay: 12 },
  { id: "INV-VIJ-2627-0001", personId: "PER-VIJ-00131", leadId: "LD-24037", admissionId: "NIT-VIJ-2026-000001", course: "Python Full Stack", branch: "Vijayawada", issuedOn: "2026-09-11", billed: 24000, standardFee: 24000, terms: "Standard fee · no concession", plan: "50/50", day0: "2026-09-12", secondDay: 14 },
  { id: "INV-VIJ-2627-0002", personId: "PER-VIJ-00119", leadId: "LD-24010", admissionId: "NIT-VIJ-2026-000002", course: "Graphic Design", branch: "Vijayawada", issuedOn: "2026-08-30", billed: 18000, standardFee: 18000, terms: "Standard fee", plan: "50/50", day0: "2026-09-01", secondDay: 12 },
  { id: "INV-VIJ-2627-0003", personId: "PER-VIJ-00137", leadId: "LD-24088", admissionId: null, course: "Java Full Stack", branch: "Vijayawada", issuedOn: "2026-09-25", billed: 25000, standardFee: 25000, terms: "Standard fee · awaiting first payment (no Admission yet)", plan: "50/50", day0: "2026-09-27", secondDay: 12 },
];

const pay = (x: Omit<Payment, "kind" | "proof"> & Partial<Pick<Payment, "kind" | "proof">>): Payment => ({ kind: "Payment", proof: "Sample proof placeholder", ...x });
const payments0: Payment[] = [
  pay({ id: "GNT-R-2627-00001", invoiceId: "INV-GNT-2627-0001", amount: 15000, method: "UPI/Bank Transfer", collector: "Counsellor A (GNT)", at: "2026-09-24T10:40", reference: "SAMPLE-UTR-8821" }),
  pay({ id: "GNT-R-2627-00002", invoiceId: "INV-GNT-2627-0001", amount: 5000, method: "Cash", collector: "Front Office B (GNT)", at: "2026-09-26T10:10", reference: "SAMPLE-CASH-0926" }),
  pay({ id: "GNT-R-2627-00003", invoiceId: "INV-GNT-2627-0002", amount: 12500, method: "Payment Link/Gateway/Card", collector: "Front Office B (GNT)", at: "2026-09-10T11:45", reference: "SAMPLE-PG-4410" }),
  pay({ id: "GNT-R-2627-00004", invoiceId: "INV-GNT-2627-0002", amount: 2000, method: "Cash", collector: "Front Office B (GNT)", at: "2026-09-21T17:30", reference: "SAMPLE-CASH-0921" }),
  pay({ id: "REV-GNT-2627-00001", invoiceId: "INV-GNT-2627-0002", amount: -2000, method: "Cash", collector: "Accounts (GNT)", at: "2026-09-21T18:10", reference: "Linked to GNT-R-2627-00004", kind: "Reversal / Correction", linkedTo: "GNT-R-2627-00004", reason: "Duplicate cash entry", approvedBy: "Super Admin (sample)", requestedBy: "Accounts (GNT)", proof: "Correction note placeholder" }),
  pay({ id: "VIJ-R-2627-00001", invoiceId: "INV-VIJ-2627-0001", amount: 12000, method: "Payment Link/Gateway/Card", collector: "Counsellor C (VIJ)", at: "2026-09-12T11:20", reference: "SAMPLE-PG-7719" }),
  pay({ id: "VIJ-R-2627-00004", invoiceId: "INV-VIJ-2627-0001", amount: 6000, method: "UPI/Bank Transfer", collector: "Counsellor C (VIJ)", at: "2026-09-26T09:40", reference: "SAMPLE-UTR-3302" }),
  pay({ id: "VIJ-R-2627-00002", invoiceId: "INV-VIJ-2627-0002", amount: 12000, method: "UPI/Bank Transfer", collector: "Front Office D (VIJ)", at: "2026-09-01T12:00", reference: "SAMPLE-UTR-1001" }),
  pay({ id: "VIJ-R-2627-00003", invoiceId: "INV-VIJ-2627-0002", amount: 6000, method: "Cash", collector: "Front Office D (VIJ)", at: "2026-09-15T12:00", reference: "SAMPLE-CASH-0915" }),
];
const verifications0: VerificationEvent[] = [
  { paymentId: "GNT-R-2627-00001", result: "Verified", by: "Accounts (GNT)", at: "2026-09-24T11:05" },
  { paymentId: "GNT-R-2627-00003", result: "Verified", by: "Accounts (GNT)", at: "2026-09-10T12:05" },
  { paymentId: "GNT-R-2627-00004", result: "Verified", by: "Accounts (GNT)", at: "2026-09-21T17:50" },
  { paymentId: "REV-GNT-2627-00001", result: "Verified", by: "Accounts (GNT)", at: "2026-09-21T18:15" },
  { paymentId: "VIJ-R-2627-00001", result: "Verified", by: "Accounts (VIJ)", at: "2026-09-12T11:50" },
  { paymentId: "VIJ-R-2627-00002", result: "Verified", by: "Accounts (VIJ)", at: "2026-09-01T12:20" },
  { paymentId: "VIJ-R-2627-00003", result: "Verified", by: "Accounts (VIJ)", at: "2026-09-15T12:25" },
];

const admissions0: Admission[] = [
  { id: "NIT-GNT-2026-000001", personId: "PER-GNT-00148", leadId: "LD-24091", invoiceId: "INV-GNT-2627-0001", course: "Data Science", originalBranch: "Guntur", serviceBranch: "Guntur", collectingBranch: "Guntur", curriculum: null, planAccepted: "Accepted 23 Sep · Classroom · weekend preference", firstQualifyingPayment: "GNT-R-2627-00001", admittedOn: "2026-09-24", enrolment: "Awaiting Batch Allocation", batchId: null, deliveryMode: "Classroom" },
  { id: "NIT-GNT-2026-000002", personId: "PER-GNT-00139", leadId: "LD-24052", invoiceId: "INV-GNT-2627-0002", course: "Java Full Stack", originalBranch: "Guntur", serviceBranch: "Vijayawada", collectingBranch: "Guntur", curriculum: "JFS v2026.2 (published)", planAccepted: "Accepted 09 Sep · Classroom at Vijayawada", firstQualifyingPayment: "GNT-R-2627-00003", admittedOn: "2026-09-10", enrolment: "Awaiting Batch Allocation", batchId: null, deliveryMode: "Classroom" },
  { id: "NIT-VIJ-2026-000001", personId: "PER-VIJ-00131", leadId: "LD-24037", invoiceId: "INV-VIJ-2627-0001", course: "Python Full Stack", originalBranch: "Vijayawada", serviceBranch: "Vijayawada", collectingBranch: "Vijayawada", curriculum: "PFS v2026.1 (published)", planAccepted: "Accepted 11 Sep · Online", firstQualifyingPayment: "VIJ-R-2627-00001", admittedOn: "2026-09-12", enrolment: "In Progress", batchId: "BT-VIJ-PFS-2609", allocatedOn: "2026-09-13", firstAttendance: "2026-09-15", deliveryMode: "Online" },
  { id: "NIT-VIJ-2026-000002", personId: "PER-VIJ-00119", leadId: "LD-24010", invoiceId: "INV-VIJ-2627-0002", course: "Graphic Design", originalBranch: "Vijayawada", serviceBranch: "Vijayawada", collectingBranch: "Vijayawada", curriculum: "GD v2026.1 (published)", planAccepted: "Accepted 31 Aug · Classroom", firstQualifyingPayment: "VIJ-R-2627-00002", admittedOn: "2026-09-01", enrolment: "Paused", batchId: null, deliveryMode: "Classroom" },
];

const batches0: Batch[] = [
  { id: "BT-GNT-DS-2610", branch: "Guntur", course: "Data Science", curriculum: "DS v2026.1 (published)", trainer: "Trainer G1", mode: "Classroom", start: "2026-10-03", end: "2027-01-23", timing: "09:00–11:00 IST", duration: "2h per class", days: "Sat, Sun", location: "Room GNT-2 (sample)", minStudents: 8, capacity: 20, otherSeats: 11, status: "Open for allocation" },
  { id: "BT-GNT-JFS-2610", branch: "Guntur", course: "Java Full Stack", curriculum: "JFS v2026.2 (published)", trainer: "Trainer G2", mode: "Hybrid", start: "2026-10-05", end: "2027-01-29", timing: "18:00–19:30 IST", duration: "1h 30m per class", days: "Mon, Wed, Fri", location: "Room GNT-1 + meet link placeholder (not connected)", minStudents: 8, capacity: 15, otherSeats: 15, status: "Full" },
  { id: "BT-VIJ-PFS-2609", branch: "Vijayawada", course: "Python Full Stack", curriculum: "PFS v2026.1 (published)", trainer: "Trainer V1", mode: "Online", start: "2026-09-15", end: "2027-01-08", timing: "07:00–08:30 IST", duration: "1h 30m per class", days: "Mon–Fri", location: "Meet link placeholder (not connected)", minStudents: 6, capacity: 25, otherSeats: 9, status: "In Progress" },
  { id: "BT-VIJ-JFS-2610", branch: "Vijayawada", course: "Java Full Stack", curriculum: "JFS v2026.2 (published)", trainer: "Trainer V2", mode: "Classroom", start: "2026-10-06", end: "2027-01-30", timing: "10:00–12:00 IST", duration: "2h per class", days: "Tue, Thu, Sat", location: "Room VIJ-3 (sample)", minStudents: 8, capacity: 18, otherSeats: 7, status: "Open for allocation" },
];

const rem = (states: [string, string][]) => states.map(([label, state]) => ({ label, state }));
const demos0: Demo[] = [
  { id: "DM-GNT-0009", leadId: "LD-24091", branch: "Guntur", course: "Data Science", at: "2026-09-22T16:00", duration: 45, trainer: "Trainer G1", mode: "Classroom", status: "Attended", reminders: rem([["Booking confirmation", "Sent (simulated)"], ["24h student reminder", "Sent (simulated)"], ["1h student + trainer reminder", "Sent (simulated)"]]), history: [tl("22 Sep 16:50", "Attended", "Outcome: Interested · fee discussion")], studentFeedback: "Clear explanation", trainerFeedback: "Strong basics", outcome: "Interested — proceed to fee discussion", recommendedCourse: "Data Science", nextAction: "Fee discussion", commercialOwner: "Counsellor A (GNT)", nextFollowUp: "2026-09-22T18:00" },
  { id: "DM-GNT-0012", leadId: "LD-24095", branch: "Guntur", course: "Power BI", at: "2026-09-26T17:00", duration: 45, trainer: "Trainer G2", mode: "Classroom", status: "Scheduled", reminders: rem([["Booking confirmation", "Sent (simulated)"], ["24h student reminder", "Skipped — booked < 24h before"], ["1h student + trainer reminder", "Pending"]]), history: [tl("25 Sep 12:00", "Scheduled", "Booked by Counsellor A (GNT)")] },
  { id: "DM-VIJ-0005", leadId: "LD-24088", branch: "Vijayawada", course: "Java Full Stack", at: "2026-09-21T11:00", duration: 45, trainer: "Trainer V1", mode: "Classroom", status: "Attended", reminders: rem([["Booking confirmation", "Sent (simulated)"], ["24h student reminder", "Sent (simulated)"], ["1h student + trainer reminder", "Sent (simulated)"]]), history: [tl("21 Sep 11:50", "Attended", "First demo")], outcome: "Needs practical session", commercialOwner: "Counsellor C (VIJ)" },
  { id: "DM-VIJ-0006", leadId: "LD-24088", branch: "Vijayawada", course: "Java Full Stack", at: "2026-09-24T11:00", duration: 60, trainer: "Trainer V1", mode: "Classroom · practical", status: "Attended", reminders: rem([["Booking confirmation", "Sent (simulated)"], ["24h student reminder", "Sent (simulated)"], ["1h student + trainer reminder", "Sent (simulated)"]]), history: [tl("24 Sep 12:05", "Attended", "Second demo · practical 60 min")], studentFeedback: "Wants evening batch", trainerFeedback: "Ready to join", outcome: "Ready — fee discussion", recommendedCourse: "Java Full Stack", nextAction: "Share approved fee + invoice", commercialOwner: "Counsellor C (VIJ)", nextFollowUp: "2026-09-24T14:00" },
  { id: "DM-VIJ-0007", leadId: "LD-24061", branch: "Vijayawada", course: "AWS with DevOps", at: "2026-09-23T12:00", duration: 45, trainer: "Trainer V2", mode: "Online · link placeholder", status: "Attended", reminders: rem([["Booking confirmation", "Sent (simulated)"], ["24h student reminder", "Sent (simulated)"], ["1h student + trainer reminder", "Sent (simulated)"]]), history: [tl("23 Sep 12:50", "Attended", "Awaiting feedback form")] },
];

const tasks0: Task[] = [
  { id: "TK-101", type: "Demo", title: "Power BI demo outcome · Ananya Rao", branch: "Guntur", owner: "Counsellor A (GNT)", status: "Open", original: "26 Sep 16:00", revised: "26 Sep 16:30", record: "LD-24095" },
  { id: "TK-102", type: "Payment Verification", title: "Verify GNT-R-2627-00002 cash ₹5,000", branch: "Guntur", owner: "Accounts (GNT)", status: "Open", original: "26 Sep 10:40", record: "GNT-R-2627-00002" },
  { id: "TK-103", type: "Academic", title: "Curriculum mapping recovery · NIT-GNT-2026-000001", branch: "Guntur", owner: "Academic Coordinator (GNT)", status: "In Progress", original: "25 Sep 11:30", record: "NIT-GNT-2026-000001" },
  { id: "TK-104", type: "Payment Verification", title: "Verify VIJ-R-2627-00004 UPI ₹6,000", branch: "Vijayawada", owner: "Accounts (VIJ)", status: "Open", original: "26 Sep 10:10", record: "VIJ-R-2627-00004" },
  { id: "TK-105", type: "Collection", title: "Overdue instalment · Rohit Kumar", branch: "Guntur", owner: "Front Office B (GNT)", status: "Open", original: "23 Sep 10:00", revised: "26 Sep 12:00", record: "NIT-GNT-2026-000002" },
  { id: "TK-106", type: "Call", title: "Fee follow-up · Karthik Reddy", branch: "Vijayawada", owner: "Counsellor C (VIJ)", status: "Open", original: "26 Sep 17:15", record: "LD-24088" },
  { id: "TK-107", type: "Refund Case", title: "Assess refund evidence · NIT-RF-26019", branch: "Vijayawada", owner: "Unassigned", status: "Waiting/Blocked", original: "24 Sep 11:00", record: "NIT-RF-26019" },
  { id: "TK-108", type: "Document", title: "Collect ID proof · Meghana Varma", branch: "Guntur", owner: "Front Office B (GNT)", status: "Completed", original: "24 Sep 12:00", record: "LD-24076" },
];

/** Fixed prototype clock: Sat 26 Sep 2026, 12:00 IST. */
export const SAMPLE_NOW = `${SAMPLE_TODAY}T12:00`;
const MONTHS: Record<string, string> = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06", Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12" };
/** Parse a task deadline (ISO or "DD Mon HH:MM") to ISO; null if a rule rather than a time. */
export function deadlineIso(d?: string): string | null {
  if (!d) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(d)) return d.length > 10 ? d.slice(0, 16) : `${d}T23:59`;
  const m = d.match(/(\d{1,2}) (\w{3})(?: (\d{1,2}:\d{2}))?/);
  if (!m || !MONTHS[m[2]!]) return null;
  return `2026-${MONTHS[m[2]!]}-${m[1]!.padStart(2, "0")}T${(m[3] ?? "23:59").padStart(5, "0")}`;
}
/** Derived condition — never a stored workflow status. */
export function taskCondition(t: Task): string {
  if (t.status === "Completed" || t.status === "Cancelled") return t.status;
  const due = deadlineIso(t.revised ?? t.original);
  if (!due) return "Rule-based deadline";
  if (due < SAMPLE_NOW) return "Overdue";
  if (due.slice(0, 10) === SAMPLE_TODAY) return "Due Today";
  return "Upcoming";
}

/* ---------------------------- derived helpers ---------------------------- */
export const inr = (n: number) => `${n < 0 ? "−" : ""}₹${Math.abs(n).toLocaleString("en-IN")}`;
export const fmtDate = (iso: string) => {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00`);
  return `${d.getDate().toString().padStart(2, "0")} ${d.toLocaleString("en-GB", { month: "short" })} ${d.getFullYear()}`;
};
export const fmtDateTime = (iso: string) => (iso.length > 10 ? `${fmtDate(iso)} · ${iso.slice(11, 16)} IST` : fmtDate(iso));
const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b.slice(0, 10)}T00:00:00Z`) - Date.parse(`${a.slice(0, 10)}T00:00:00Z`)) / 86400000);
export const ageBand = (d: number) => (d <= 0 ? "—" : d <= 3 ? "1–3" : d <= 7 ? "4–7" : d <= 15 ? "8–15" : d <= 30 ? "16–30" : d <= 60 ? "31–60" : d <= 90 ? "61–90" : "91+");

export type Installment = { n: number; due: string; amount: number; paid: number; recovered: number };

type State = {
  persons: Person[];
  leads: Lead[];
  invoices: Invoice[];
  payments: Payment[];
  verifications: VerificationEvent[];
  admissions: Admission[];
  batches: Batch[];
  demos: Demo[];
  tasks: Task[];
  corrections: CorrectionRequest[];
  audit: TimelineEvent[];
};
const initial = (): State => ({
  persons: persons0.map((x) => ({ ...x })),
  leads: leads0.map((x) => ({ ...x, timeline: [...x.timeline] })),
  invoices: invoices0.map((x) => ({ ...x })),
  payments: payments0.map((x) => ({ ...x })),
  verifications: verifications0.map((x) => ({ ...x })),
  admissions: admissions0.map((x) => ({ ...x })),
  batches: batches0.map((x) => ({ ...x })),
  demos: demos0.map((x) => ({ ...x, reminders: [...x.reminders], history: [...x.history] })),
  tasks: tasks0.map((x) => ({ ...x })),
  corrections: [],
  audit: [],
});

export function paymentStatus(s: Pick<State, "verifications">, paymentId: string): "Pending Verification" | "Verified" | "Failed" {
  const v = [...s.verifications].reverse().find((x) => x.paymentId === paymentId);
  return v ? v.result : "Pending Verification";
}
export function verifiedAt(s: Pick<State, "verifications">, paymentId: string) {
  return [...s.verifications].reverse().find((x) => x.paymentId === paymentId && x.result === "Verified")?.at;
}

export function invoiceSummary(s: State, inv: Invoice) {
  const events = s.payments.filter((p) => p.invoiceId === inv.id);
  const verifiedEvents = events.filter((p) => paymentStatus(s, p.id) === "Verified");
  const verified = verifiedEvents.reduce((a, p) => a + p.amount, 0);
  const pending = events.filter((p) => paymentStatus(s, p.id) === "Pending Verification" && p.amount > 0).reduce((a, p) => a + p.amount, 0);
  const outstanding = Math.max(0, inv.billed - verified);
  const shares = inv.plan === "Full" ? [1] : inv.plan === "50/50" ? [0.5, 0.5] : [0.5, 0.25, 0.25];
  const offsets = inv.plan === "Full" ? [0] : inv.plan === "50/50" ? [0, inv.secondDay ?? 12] : [0, 10, 15];
  const inst: Installment[] = shares.map((sh, i) => ({ n: i + 1, due: addDays(inv.day0, offsets[i] ?? 0), amount: Math.round(inv.billed * sh), paid: 0, recovered: 0 }));
  // allocate verified money chronologically (by verification date) to instalments
  const ordered = verifiedEvents.map((p) => ({ p, at: verifiedAt(s, p.id) ?? p.at })).sort((a, b) => a.at.localeCompare(b.at));
  let carry = 0;
  for (const { p, at } of ordered) {
    let amt = p.amount + carry;
    carry = 0;
    if (amt < 0) {
      // reversal: take back from the latest paid instalments
      for (let i = inst.length - 1; i >= 0 && amt < 0; i--) {
        const it = inst[i]!;
        const take = Math.min(it.paid, -amt);
        it.paid -= take;
        amt += take;
      }
      continue;
    }
    for (const i of inst) {
      if (amt <= 0) break;
      const room = i.amount - i.paid;
      const put = Math.min(room, amt);
      if (put > 0) {
        i.paid += put;
        if (at.slice(0, 10) > i.due) i.recovered += put;
        amt -= put;
      }
    }
  }
  const nextDue = inst.find((i) => i.paid < i.amount);
  const completion = verified <= 0 ? "Unpaid" : outstanding === 0 ? "Paid" : "Part Paid";
  const duePosition = !nextDue ? "—" : nextDue.due < SAMPLE_TODAY ? "Overdue" : nextDue.due === SAMPLE_TODAY ? "Due Today" : "Upcoming";
  const state: InvoiceState = completion === "Paid" ? "Paid" : completion === "Part Paid" ? "Part Paid" : "Issued";
  return { events, verified, pending, outstanding, installments: inst, nextDue, completion, duePosition, state };
}

export function allocationCheck(s: State, admissionId: string, batchId: string): { ok: boolean; reason: string; owner?: string } {
  const a = s.admissions.find((x) => x.id === admissionId);
  const b = s.batches.find((x) => x.id === batchId);
  if (!a || !b) return { ok: false, reason: "Record not found in sample data." };
  if (a.batchId) return { ok: false, reason: `Already allocated to ${a.batchId}. Transfers need a separate approved change.` };
  if (["Cancelled", "Paused", "Completed"].includes(a.enrolment)) return { ok: false, reason: `Enrolment is ${a.enrolment}; allocation blocked.` };
  if (b.branch !== a.serviceBranch) return { ok: false, reason: `Wrong branch: batch is ${b.branch}, student's service branch is ${a.serviceBranch}. Cross-branch allocation is never automatic.`, owner: `Branch Manager (${branchCode(a.serviceBranch)})` };
  if (b.course !== a.course) return { ok: false, reason: `Course mismatch: batch is ${b.course}, admission is ${a.course}.` };
  if (!a.curriculum) return { ok: false, reason: "Curriculum Mapping Pending — published curriculum version not mapped for this enrolment.", owner: `Academic Coordinator (${branchCode(a.serviceBranch)}) · academic recovery owner` };
  const occ = b.otherSeats + s.admissions.filter((x) => x.batchId === b.id).length;
  if (occ >= b.capacity) return { ok: false, reason: `Full capacity: ${occ}/${b.capacity}. Choose another batch or request capacity change.`, owner: `Academic Coordinator (${branchCode(b.branch)})` };
  return { ok: true, reason: "All checks passed: same service branch, same course, curriculum mapped, seat available." };
}
export const occupancy = (s: State, b: Batch) => b.otherSeats + s.admissions.filter((x) => x.batchId === b.id).length;

/* ------------------------------- context ------------------------------- */
type Actions = {
  reset: () => void;
  addLead: (x: Partial<Omit<Lead, "personId">> & { name: string; course: string; branch: BranchName; personId?: string | undefined }) => Lead;
  bulkAssign: (ids: string[], owner: string) => void;
  logFollowUp: (leadId: string, f: { purpose: string; response: string; notes: string; next: string }) => void;
  scheduleDemo: (d: { leadId: string; at: string; duration: number; trainer: string; mode: string; exceptionApproval?: string | undefined }) => Demo;
  rescheduleDemo: (id: string, at: string, reason: string) => void;
  cancelDemo: (id: string, reason: string) => void;
  recordDemoOutcome: (id: string, o: Partial<Demo> & { status: "Attended" | "No-show" }) => string;
  recordPayment: (p: Omit<Payment, "id" | "kind" | "proof">) => Payment;
  verifyPayment: (id: string, result: "Verified" | "Failed", by: string) => { ok: boolean; msg: string };
  requestCorrection: (paymentId: string, reason: string, requestedBy: string) => { ok: boolean; msg: string };
  decideCorrection: (requestId: string, decision: "Approved" | "Rejected", by: string, note?: string) => { ok: boolean; msg: string };
  allocate: (admissionId: string, batchId: string) => { ok: boolean; reason: string; owner?: string };
  recordFirstAttendance: (admissionId: string) => void;
};
type Ctx = State & Actions;
const StoreCtx = createContext<Ctx | null>(null);

const stamp = () => `${fmtDate(SAMPLE_TODAY)} · ${new Date().toTimeString().slice(0, 5)} (sim)`;

export function CrmDataProvider({ children }: { children: ReactNode }) {
  const [s, setRaw] = useState<State>(initial);
  // Every mutation consumes the latest committed-or-queued state, so batched calls in one click never overwrite each other.
  const ref = useRef<State>(s);
  const setS = (u: State | ((st: State) => State)) => { const next = typeof u === "function" ? u(ref.current) : u; ref.current = next; setRaw(next); };
  const reset = () => setS(initial());
  const apply = (fn: (st: State) => State) => setS(fn);

  const addLead: Actions["addLead"] = (x) => {
    let created!: Lead;
    apply((st) => {
      const code = branchCode(x.branch);
      let person = x.personId ? st.persons.find((p) => p.id === x.personId) : undefined;
      const persons = [...st.persons];
      if (!person) {
        const n = 200 + persons.filter((p) => p.originalBranch === x.branch).length;
        person = { id: `PER-${code}-00${n}`, name: x.name, phone: x.phone || "+91 9XXXX 0XXXX", altPhone: x.altPhone, email: x.email || "", whatsapp: x.whatsapp || "Same as mobile", originalBranch: x.branch };
        persons.push(person);
      }
      const id = `LD-${25000 + st.leads.length + 1}`;
      created = {
        id, personId: person.id, name: person.name, phone: person.phone, altPhone: x.altPhone ?? person.altPhone, email: person.email, whatsapp: person.whatsapp,
        course: x.course, branch: x.branch, source: x.source ?? "Walk-in", campaign: x.campaign || "—", channel: x.channel ?? "In person", entryMethod: x.entryMethod ?? "Staff entered",
        intakeStatus: x.intakeStatus ?? "New", owner: x.owner ?? ownerOptions(x.branch)[0]?.name ?? "Unassigned", stage: "New Enquiry", followUp: x.followUp || "Unscheduled", age: "0d",
        priority: x.priority ?? "Warm", score: 50, remarks: x.remarks ?? "", createdOn: SAMPLE_TODAY,
        timeline: [tl(stamp(), "Enquiry captured (sample)", `${x.entryMethod ?? "Staff entered"} · SLA clock starts; capture alone does not satisfy SLA`)],
      };
      return { ...st, persons, leads: [created, ...st.leads], audit: [tl(stamp(), "Lead created", id), ...st.audit] };
    });
    return created;
  };

  const bulkAssign: Actions["bulkAssign"] = (ids, owner) =>
    setS((st) => ({ ...st, leads: st.leads.map((l) => (ids.includes(l.id) ? { ...l, owner, timeline: [tl(stamp(), "Owner reassigned", `→ ${owner}`), ...l.timeline] } : l)) }));

  const logFollowUp: Actions["logFollowUp"] = (leadId, f) =>
    setS((st) => {
      const lead = st.leads.find((l) => l.id === leadId);
      if (!lead) return st;
      const next = f.next ? fmtDateTime(f.next) : "Unscheduled";
      const task: Task = { id: `TK-${200 + st.tasks.length}`, type: "Call", title: `${f.purpose} · ${lead.name}`, branch: lead.branch, owner: lead.owner, status: "Open", original: lead.originalDeadline ?? lead.followUp, revised: next, record: leadId };
      return {
        ...st,
        leads: st.leads.map((l) => (l.id === leadId ? { ...l, followUp: next, originalDeadline: l.originalDeadline ?? l.followUp, timeline: [tl(stamp(), `Follow-up logged · ${f.purpose}`, `${f.response}${f.notes ? ` · ${f.notes}` : ""} · next ${next}`), ...l.timeline] } : l)),
        tasks: [task, ...st.tasks],
      };
    });

  const scheduleDemo: Actions["scheduleDemo"] = (d) => {
    let created!: Demo;
    apply((st) => {
      const lead = st.leads.find((l) => l.id === d.leadId)!;
      const hoursAhead = daysBetween(SAMPLE_TODAY, d.at) * 24;
      created = {
        id: `DM-${branchCode(lead.branch)}-${String(20 + st.demos.length).padStart(4, "0")}`, leadId: d.leadId, branch: lead.branch, course: lead.course, at: d.at, duration: d.duration, trainer: d.trainer, mode: d.mode, status: "Scheduled",
        exceptionApproval: d.exceptionApproval,
        reminders: rem([["Booking confirmation", "Sent (simulated)"], ["24h student reminder", hoursAhead >= 24 ? "Pending" : "Skipped — already passed"], ["1h student + trainer reminder", "Pending"]]),
        history: [tl(stamp(), "Scheduled", `${fmtDateTime(d.at)} · ${d.duration} min${d.exceptionApproval ? ` · exception: ${d.exceptionApproval}` : ""}`)],
      };
      const stage = protectedStages.includes(lead.stage) ? lead.stage : "Demo Scheduled";
      return { ...st, demos: [created, ...st.demos], leads: st.leads.map((l) => (l.id === d.leadId ? { ...l, stage, timeline: [tl(stamp(), "Demo scheduled", `${created.id} · ${fmtDateTime(d.at)}`), ...l.timeline] } : l)) };
    });
    return created;
  };
  const rescheduleDemo: Actions["rescheduleDemo"] = (id, at, reason) =>
    setS((st) => ({
      ...st,
      demos: st.demos.map((d) => (d.id === id ? { ...d, at, status: "Rescheduled", reminders: [...d.reminders.map((r) => ({ ...r, state: r.state === "Pending" ? "Superseded by reschedule" : r.state })), ...rem([["New confirmation", "Sent (simulated)"], ["New 24h reminder", daysBetween(SAMPLE_TODAY, at) >= 1 ? "Pending" : "Skipped — already passed"], ["New 1h reminder", "Pending"]])], history: [tl(stamp(), "Rescheduled", `${fmtDateTime(d.at)} → ${fmtDateTime(at)} · reason: ${reason}`), ...d.history] } : d)),
    }));
  const cancelDemo: Actions["cancelDemo"] = (id, reason) =>
    setS((st) => ({ ...st, demos: st.demos.map((d) => (d.id === id ? { ...d, status: "Cancelled", reminders: d.reminders.map((r) => ({ ...r, state: r.state === "Pending" ? "Cleared by cancellation" : r.state })), history: [tl(stamp(), "Cancelled", `Reason: ${reason}`), ...d.history] } : d)) }));
  const recordDemoOutcome: Actions["recordDemoOutcome"] = (id, o) => {
    let msg = "";
    apply((st) => {
      const demo = st.demos.find((d) => d.id === id)!;
      const lead = st.leads.find((l) => l.id === demo.leadId)!;
      const protectedStage = protectedStages.includes(lead.stage);
      const stage = protectedStage ? lead.stage : o.status === "Attended" ? "Demo Attended" : lead.stage;
      msg = protectedStage ? `Outcome saved. Stage stays ${lead.stage} (demo cannot move it backward or reopen Lost).` : `Outcome saved. Stage: ${stage}. Commercial follow-up due within 2 staffed hours.`;
      const next = o.nextFollowUp ? fmtDateTime(o.nextFollowUp) : lead.followUp;
      const task: Task = { id: `TK-${200 + st.tasks.length}`, type: "Call", title: `Commercial follow-up after demo · ${lead.name}`, branch: lead.branch, owner: o.commercialOwner || lead.owner, status: "Open", original: "Within 2 staffed hours", revised: next, record: lead.id };
      return {
        ...st,
        demos: st.demos.map((d) => (d.id === id ? { ...d, ...o, reminders: d.reminders.map((r) => ({ ...r, state: r.state === "Pending" ? "Not needed — demo concluded" : r.state })), history: [tl(stamp(), o.status, o.outcome || "Outcome recorded"), ...d.history] } : d)),
        leads: st.leads.map((l) => (l.id === lead.id ? { ...l, stage, followUp: next, timeline: [tl(stamp(), `Demo ${o.status.toLowerCase()}`, `${o.outcome ?? ""} · next: ${o.nextAction ?? "—"}`), ...l.timeline] } : l)),
        tasks: [task, ...st.tasks],
      };
    });
    return msg;
  };

  const recordPayment: Actions["recordPayment"] = (p) => {
    let created!: Payment;
    apply((st) => {
      const inv = st.invoices.find((i) => i.id === p.invoiceId)!;
      const code = branchCode(inv.branch);
      const n = st.payments.filter((x) => x.id.startsWith(`${code}-R-`)).length + 1;
      created = { ...p, id: `${code}-R-2627-${String(n).padStart(5, "0")}`, kind: "Payment", proof: "Sample proof placeholder · review pending" };
      return { ...st, payments: [...st.payments, created], audit: [tl(stamp(), "Payment recorded · Pending Verification", created.id), ...st.audit] };
    });
    return created;
  };
  const nowIso = () => `${SAMPLE_TODAY}T${new Date().toTimeString().slice(0, 5)}`;
  const verifyPayment: Actions["verifyPayment"] = (id, result, by) => {
    const p = s.payments.find((x) => x.id === id);
    if (!p || p.kind !== "Payment" || p.amount <= 0) return { ok: false, msg: "Blocked: verification applies only to positive payment receipts. Corrections need the approval workflow." };
    if (paymentStatus(s, id) !== "Pending Verification") return { ok: false, msg: `Blocked: ${id} is already ${paymentStatus(s, id)}. Verification events are not re-applied.` };
    setS((st) => ({ ...st, verifications: [...st.verifications, { paymentId: id, result, by, at: nowIso() }], tasks: st.tasks.map((t) => (t.record === id && t.type === "Payment Verification" && t.status !== "Completed" ? { ...t, status: "Completed" } : t)), audit: [tl(stamp(), `Verification event · ${result}`, `${id} by ${by}`), ...st.audit] }));
    return { ok: true, msg: `${id} ${result} · appended as a verification event` };
  };
  const requestCorrection: Actions["requestCorrection"] = (paymentId, reason, requestedBy) => {
    const p = s.payments.find((x) => x.id === paymentId);
    if (!p || p.kind !== "Payment") return { ok: false, msg: "Blocked: only payment receipts can be corrected." };
    const st0 = paymentStatus(s, paymentId);
    if (st0 === "Pending Verification") return { ok: false, msg: `Blocked: ${paymentId} is Pending Verification. Accounts should mark it Failed on Payments & Receipts instead — no reversal is created for unverified money.` };
    if (st0 === "Failed") return { ok: false, msg: `Blocked: ${paymentId} is Failed and was never counted. No reversal is needed.` };
    if (s.payments.some((x) => x.linkedTo === paymentId)) return { ok: false, msg: `Blocked: ${paymentId} already has a linked reversal.` };
    if (s.corrections.some((c) => c.paymentId === paymentId && c.status === "Pending Approval")) return { ok: false, msg: `Blocked: a correction request for ${paymentId} is already awaiting approval.` };
    if (!reason.trim()) return { ok: false, msg: "A reason is required." };
    const inv = s.invoices.find((i) => i.id === p.invoiceId)!;
    const id = `CR-${branchCode(inv.branch)}-${String(s.corrections.length + 1).padStart(4, "0")}`;
    const req: CorrectionRequest = { id, paymentId, invoiceId: p.invoiceId, amount: p.amount, reason, requestedBy, requestedAt: nowIso(), status: "Pending Approval" };
    const task: Task = { id: `TK-${200 + s.tasks.length}`, type: "Payment Verification", title: `Approve correction ${id} for ${paymentId}`, branch: inv.branch, owner: "Founder / CEO or Super Admin", status: "Open", original: nowIso(), record: id };
    setS((st) => ({ ...st, corrections: [req, ...st.corrections], tasks: [task, ...st.tasks], audit: [tl(stamp(), "Correction requested · Pending Approval", `${id} → ${paymentId} by ${requestedBy} · ${reason}`), ...st.audit] }));
    return { ok: true, msg: `${id} submitted for independent approval. Ledger and balance unchanged.` };
  };
  const decideCorrection: Actions["decideCorrection"] = (requestId, decision, by, note) => {
    const req = s.corrections.find((c) => c.id === requestId);
    if (!req || req.status !== "Pending Approval") return { ok: false, msg: "Request is not awaiting approval." };
    if (!(by.startsWith("Founder / CEO") || by.startsWith("Super Admin"))) return { ok: false, msg: "Blocked: only Founder / CEO or Super Admin can decide corrections (UI simulation)." };
    if (by === req.requestedBy) return { ok: false, msg: "Blocked: self-approval is not allowed. A distinct approver must decide." };
    const at = nowIso();
    let reversal: Payment | null = null;
    if (decision === "Approved") {
      const orig = s.payments.find((p) => p.id === req.paymentId)!;
      if (paymentStatus(s, orig.id) !== "Verified" || s.payments.some((p) => p.linkedTo === orig.id)) return { ok: false, msg: "Blocked: original is no longer a verified, un-reversed receipt." };
      const code = orig.id.slice(0, 3);
      const n = s.payments.filter((x) => x.id.startsWith(`REV-${code}`)).length + 1;
      reversal = { ...orig, id: `REV-${code}-2627-${String(n).padStart(5, "0")}`, amount: -orig.amount, kind: "Reversal / Correction", linkedTo: orig.id, reason: req.reason, requestedBy: req.requestedBy, approvedBy: by, at, reference: `Linked to ${orig.id} · ${req.id}`, proof: "Correction note placeholder" };
    }
    const rev = reversal as Payment | null;
    setS((st) => ({
      ...st,
      corrections: st.corrections.map((c) => (c.id === requestId ? { ...c, status: decision, decidedBy: by, decidedAt: at, decisionNote: note, reversalId: rev?.id } : c)),
      payments: rev ? [...st.payments, rev] : st.payments,
      verifications: rev ? [...st.verifications, { paymentId: rev.id, result: "Verified", by, at }] : st.verifications,
      tasks: st.tasks.map((t) => (t.record === requestId ? { ...t, status: "Completed" } : t)),
      audit: [tl(stamp(), `Correction ${decision}`, `${requestId} by ${by} (requested by ${req.requestedBy})${rev ? ` · ${rev.id} linked to ${req.paymentId}` : ""}`), ...st.audit],
    }));
    return { ok: true, msg: rev ? `${requestId} approved. ${rev.id} linked to ${req.paymentId}; original retained.` : `${requestId} rejected. Ledger unchanged.` };
  };
  const allocate: Actions["allocate"] = (admissionId, batchId) => {
    const res = allocationCheck(s, admissionId, batchId);
    if (res.ok)
      setS((st) => ({ ...st, admissions: st.admissions.map((a) => (a.id === admissionId ? { ...a, batchId, allocatedOn: SAMPLE_TODAY, enrolment: "Scheduled" } : a)), audit: [tl(stamp(), "Batch allocated", `${admissionId} → ${batchId}`), ...st.audit] }));
    return res;
  };
  const recordFirstAttendance: Actions["recordFirstAttendance"] = (admissionId) =>
    setS((st) => ({ ...st, admissions: st.admissions.map((a) => (a.id === admissionId && a.batchId ? { ...a, firstAttendance: SAMPLE_TODAY, enrolment: "In Progress" } : a)) }));

  const value = useMemo<Ctx>(
    () => ({ ...s, reset, addLead, bulkAssign, logFollowUp, scheduleDemo, rescheduleDemo, cancelDemo, recordDemoOutcome, recordPayment, verifyPayment, requestCorrection, decideCorrection, allocate, recordFirstAttendance }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [s],
  );
  return <StoreCtx.Provider value={value}>{children}</StoreCtx.Provider>;
}

export function useCrmData() {
  const c = useContext(StoreCtx);
  if (!c) throw new Error("useCrmData must be used inside CrmDataProvider");
  return c;
}

/** Period ranges relative to the fixed sample date (IST, weeks Mon–Sun). */
export function periodRange(period: string, custom?: { from: string; to: string }): [string, string] {
  const t = SAMPLE_TODAY; // Sat 26 Sep 2026
  const weekStart = addDays(t, -5); // Mon 21 Sep
  switch (period) {
    case "Today": return [t, t];
    case "Yesterday": return [addDays(t, -1), addDays(t, -1)];
    case "This Week": return [weekStart, addDays(weekStart, 6)];
    case "Last Week": return [addDays(weekStart, -7), addDays(weekStart, -1)];
    case "This Month": return ["2026-09-01", "2026-09-30"];
    case "Last Month": return ["2026-08-01", "2026-08-31"];
    default: return [custom?.from || "2026-09-01", custom?.to || t];
  }
}
export const inRange = (iso: string | undefined, [a, b]: [string, string]) => !!iso && iso.slice(0, 10) >= a && iso.slice(0, 10) <= b;
