/** Target Master: versions (Draft → Approved → Superseded), per-branch lines, achievement. */
import { useQuery } from "@tanstack/react-query";
import { get, post } from "./client";
import type { DateOnly, DateTime, Money } from "./types";
import type { TargetAchievement } from "./dashboard";

export type TargetLine = {
  branch_id: number | null;
  scope: "Company" | number;
  verified_collections_target: Money | null;
  paid_admissions_target: number | null;
};

export type TargetVersion = {
  target_version_id: number;
  version_code: string;
  period_start: DateOnly;
  period_end: DateOnly;
  status: "Draft" | "Approved" | "Superseded";
  notes: string | null;
  approved_by: number | null;
  approved_at: DateTime | null;
  superseded_by_id: number | null;
  created_by: number | null;
  lines: TargetLine[];
};

export type NewTarget = {
  period_start: DateOnly;
  period_end: DateOnly;
  notes?: string | null;
  lines: {
    branch_id: number | null;
    verified_collections_target: string | null;
    paid_admissions_target: number | null;
  }[];
};

export const targetsApi = {
  list: (status?: string) => get<TargetVersion[]>("/targets", { status }),
  get: (id: number) => get<TargetVersion>(`/targets/${id}`),
  create: (body: NewTarget) => post<TargetVersion>("/targets", body),
  approve: (id: number) => post<TargetVersion>(`/targets/${id}/approve`),
  achievement: (query: { date?: string; branch_id?: number }) =>
    get<TargetAchievement[]>("/targets/achievement", query),
};

export const targetKeys = {
  all: ["targets"] as const,
  list: (status?: string) => ["targets", "list", status ?? ""] as const,
  achievement: (query: { date?: string; branch_id?: number }) =>
    ["targets", "achievement", query] as const,
};

export const useTargets = (status?: string) =>
  useQuery({
    queryKey: targetKeys.list(status),
    queryFn: () => targetsApi.list(status),
  });
export const useAchievement = (query: { date?: string; branch_id?: number }) =>
  useQuery({
    queryKey: targetKeys.achievement(query),
    queryFn: () => targetsApi.achievement(query),
  });
