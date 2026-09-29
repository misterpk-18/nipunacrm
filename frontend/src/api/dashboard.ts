/** Dashboards (#1): company / branch-manager / staff views from GET /dashboard. */
import { useQuery } from "@tanstack/react-query";
import { get, type Query } from "./client";
import type { BranchRef, DateOnly, Money } from "./types";

export const PERIODS = [
  "Today",
  "Yesterday",
  "This Week",
  "Last Week",
  "This Month",
  "Last Month",
  "Custom",
] as const;
export type Period = (typeof PERIODS)[number];

export type DemoCounts = {
  scheduled: number;
  attended: number;
  no_show: number;
};

export type KpiTiles = {
  genuine_enquiries: number;
  sla_at_risk: number;
  overdue_follow_ups: number;
  paid_admissions: number;
  verified_collections: Money;
  pending_verification_excluded: Money;
  overdue_dues: Money;
  demos: DemoCounts;
  /** Open invoices whose next instalment is due more than 30 days after the last verified payment. */
  long_gap_plans: { count: number; outstanding: Money };
};

export type BranchTiles = KpiTiles & {
  branch: BranchRef;
  staff_coverage: { active_counsellors: number; unassigned_open_leads: number };
};

export type TargetAchievement = {
  version_code: string;
  scope: string;
  branch_id: number | null;
  period_start: DateOnly;
  period_end: DateOnly;
  verified_collections_target: Money | null;
  verified_collections: Money;
  collections_pct: string | null;
  paid_admissions_target: number | null;
  paid_admissions: number;
  admissions_pct: string | null;
};

export type ApprovalQueues = {
  can_approve: number;
  higher_approval: number;
  awaiting_execution: {
    fee_changes_to_apply: number;
    refund_payouts: number;
    corrections_pending: number;
  };
};

export type FunnelStage = {
  stage: string;
  leads: number;
  pct_of_total: number;
};
export type Funnel = { total_leads: number; stages: FunnelStage[] };

type PeriodInfo = { period: string; from: DateOnly; to: DateOnly };

export type Dashboard =
  | (PeriodInfo & {
      view: "company";
      company: KpiTiles;
      branches: BranchTiles[];
      targets: TargetAchievement[];
      approval_queues: ApprovalQueues;
    })
  | (PeriodInfo & {
      view: "branch_manager";
      tiles: KpiTiles;
      branches: BranchTiles[];
      funnel: Funnel;
      approval_queues: ApprovalQueues;
      targets: TargetAchievement[];
      top_staff: {
        user_id: number;
        full_name: string;
        paid_admissions: number;
      }[];
    })
  | (PeriodInfo & { view: "staff"; tiles: KpiTiles });

export type DashboardQuery = {
  period?: string;
  from?: string;
  to?: string;
  branch_id?: number;
};

export const dashboardApi = {
  get: (query: DashboardQuery) => get<Dashboard>("/dashboard", query as Query),
};

export const dashboardKeys = {
  all: ["dashboard"] as const,
  get: (query: DashboardQuery) => ["dashboard", query] as const,
};

export const useDashboard = (query: DashboardQuery) =>
  useQuery({
    queryKey: dashboardKeys.get(query),
    queryFn: () => dashboardApi.get(query),
  });
