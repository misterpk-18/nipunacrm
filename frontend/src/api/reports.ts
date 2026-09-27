/** Reports (#12): management, funnel, performance, SLA; CSV export; scheduled reports. */
import { useQuery } from "@tanstack/react-query";
import { download, get, patch, post, type Query } from "./client";
import type { DateOnly, DateTime, Money, BranchRef } from "./types";
import type { Funnel } from "./dashboard";

export const REPORT_NAMES = [
  "management",
  "funnel",
  "performance",
  "sla",
] as const;
export type ReportName = (typeof REPORT_NAMES)[number];
export const REPORT_FREQUENCIES = ["Daily", "Weekly", "Monthly"] as const;
export const REPORT_FORMATS = ["Excel", "CSV", "PDF"] as const;

export type ReportFilters = {
  period?: string;
  from?: string;
  to?: string;
  branch_id?: number;
  course_id?: number;
  source_id?: number;
  staff_id?: number;
  by?: "course" | "source" | "staff";
};

export type ReportEnvelope<T> = {
  report: string;
  period: string;
  from: DateOnly;
  to: DateOnly;
  cutoff_at: DateTime;
  completeness: string;
  completeness_notes: string | null;
  data: T;
};

export type CollectionsFigures = {
  verified_collections: Money;
  gross_verified: Money;
  reversals: Money;
  refunds: Money;
  net: Money;
  dues_recovery: Money;
  new_paid_admissions: number;
  pending_verification_excluded: Money;
};
export type ManagementReport = {
  branches: (CollectionsFigures & { branch: BranchRef })[];
  company: CollectionsFigures;
};

export type PerformanceRow = {
  key: number | null;
  label: string;
  enquiries: number;
  leads: number;
  paid_admissions: number;
  conversion_pct: number | null;
};

export type SlaReport = {
  follow_ups: {
    owner_user_id: number | null;
    owner: string;
    tasks: number;
    completed_on_time: number;
    completed_late: number;
    overdue_open: number;
    open: number;
    completion_pct: number | null;
  }[];
  responses: Record<string, number>;
};

export type ScheduledReport = {
  scheduled_report_id: number;
  report_name: string;
  frequency: string;
  schedule_day: number | null;
  send_time: string;
  period: string;
  branch_id: number | null;
  format: string;
  is_active: boolean;
  recipients: string[];
  last_sent_at: DateTime | null;
  last_delivery_status: string;
};

export type ScheduledReportBody = Partial<
  Omit<
    ScheduledReport,
    "scheduled_report_id" | "last_sent_at" | "last_delivery_status"
  >
>;

const q = (f: ReportFilters) => f as Query;

export const reportsApi = {
  management: (f: ReportFilters) =>
    get<ReportEnvelope<ManagementReport>>("/reports/management", q(f)),
  funnel: (f: ReportFilters) =>
    get<ReportEnvelope<Funnel>>("/reports/funnel", q(f)),
  performance: (f: ReportFilters) =>
    get<ReportEnvelope<PerformanceRow[]>>("/reports/performance", q(f)),
  sla: (f: ReportFilters) =>
    get<ReportEnvelope<SlaReport>>("/reports/sla", q(f)),
  exportCsv: (name: ReportName, f: ReportFilters) =>
    download(
      `/reports/${name}/export`,
      { ...q(f), format: "csv" },
      `${name}-report.csv`,
    ),
  scheduled: () => get<ScheduledReport[]>("/scheduled-reports"),
  createScheduled: (body: ScheduledReportBody) =>
    post<ScheduledReport>("/scheduled-reports", body),
  updateScheduled: (id: number, body: ScheduledReportBody) =>
    patch<ScheduledReport>(`/scheduled-reports/${id}`, body),
};

export const reportKeys = {
  all: ["reports"] as const,
  report: (name: ReportName, f: ReportFilters) => ["reports", name, f] as const,
  scheduled: ["scheduled-reports"] as const,
};

export function useReport<T>(
  name: ReportName,
  filters: ReportFilters,
  enabled = true,
) {
  return useQuery({
    queryKey: reportKeys.report(name, filters),
    queryFn: () =>
      (reportsApi[name] as (f: ReportFilters) => Promise<ReportEnvelope<T>>)(
        filters,
      ),
    enabled,
  });
}
