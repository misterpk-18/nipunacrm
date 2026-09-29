/** V4 Overview dashboard: GET /dashboard/overview (KPI cards, 7-day collections, pipeline bars, branch pulse). */
import { useQuery } from "@tanstack/react-query";
import { get, type Query } from "./client";
import type { BranchRef, DateOnly, Money } from "./types";

export type Overview = {
  period: string;
  from: DateOnly;
  to: DateOnly;
  as_of: DateOnly;
  kpis: {
    /** Open leads (not admitted / lost; spam and test excluded). */
    open_enquiries: number;
    /** Of those, still in New Enquiry. */
    new_enquiries: number;
    /** Paid admissions in the period (₹1,000 token verified). */
    admissions: number;
    /** Admissions awaiting batch allocation (current). */
    awaiting_batch: number;
    /** Verified payments in the period, net of reversals. */
    verified_collections: Money;
    verified_payments: number;
    /** Balance still owed on issued invoices (pending claims don't reduce it). */
    outstanding_balance: Money;
    pending_verification: { count: number; amount: Money };
  };
  /** Last 7 days (IST) ending today: verified payments net of reversals, by payment date. */
  collections_daily: { date: DateOnly; amount: Money }[];
  pipeline: {
    bars: { label: string; stages: string[]; count: number }[];
    open_opportunities: number;
    /** Standard fee of each open course on an open pipeline card. */
    open_value: Money;
  };
  attention: { follow_ups: number; payments: number; admissions: number };
  branches: { branch: BranchRef; admissions: number; net_verified: Money }[];
};

export type OverviewQuery = { period?: string; from?: string; to?: string; branch_id?: number };

export const overviewApi = {
  get: (query: OverviewQuery) => get<Overview>("/dashboard/overview", query as Query),
};

export const useOverview = (query: OverviewQuery) =>
  useQuery({ queryKey: ["dashboard", "overview", query], queryFn: () => overviewApi.get(query) });
