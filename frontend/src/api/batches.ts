import { useQuery } from "@tanstack/react-query";
import { get, list, patch, post, type Query } from "./client";
import type { BranchRef, CourseRef, DateOnly, UserRef } from "./types";
import type { Allocation, CurriculumVersion, QueueRow } from "./admissions";

export const BATCH_STATUSES = ["Planned", "Open", "In Progress", "Completed", "Cancelled"];

export type Batch = {
  batch_id: number;
  batch_code: string;
  batch_name: string;
  course: CourseRef;
  branch: BranchRef;
  curriculum_version: { curriculum_version_id: number; version_label: string } | null;
  delivery_mode: string;
  trainer: UserRef | null;
  schedule_days: string | null;
  start_time: string | null;
  end_time: string | null;
  start_date: DateOnly;
  end_date: DateOnly | null;
  capacity: number;
  min_students: number | null;
  allocated: number;
  seats_left: number;
  is_full: boolean;
  location: string | null;
  status: string;
  lms_course_id: string | null;
};

export type BatchDetail = Batch & { allocations: Allocation[]; awaiting_allocation: QueueRow[] };

export type BatchBody = {
  batch_name?: string;
  course_id?: number;
  branch_id?: number;
  curriculum_version_id?: number | null;
  delivery_mode?: string;
  trainer_user_id?: number | null;
  schedule_days?: string | null;
  start_time?: string;
  end_time?: string;
  start_date?: DateOnly;
  end_date?: DateOnly | null;
  capacity?: number;
  min_students?: number | null;
  location?: string | null;
  status?: string;
  lms_course_id?: string | null;
};

export type BatchFilters = { page?: number; per_page?: number; branch_id?: number; course_id?: number; trainer_id?: number; status?: string };

export type AllocationCheck = { ok: boolean; reason: string; recovery_owner: string | null };

export const batchesApi = {
  list: (filters: BatchFilters) => list<Batch>("/batches", filters as Query),
  get: (id: number) => get<BatchDetail>(`/batches/${id}`),
  create: (body: BatchBody) => post<Batch>("/batches", body),
  update: (id: number, body: BatchBody) => patch<Batch>(`/batches/${id}`, body),
  allocationCheck: (batchId: number, admissionId: number) =>
    get<AllocationCheck>(`/batches/${batchId}/allocation-check`, { admission_id: admissionId }),
  closeAllocation: (allocationId: number, body: { status: "Moved" | "Withdrawn" | "Completed"; reason?: string | null }) =>
    post<Allocation>(`/batch-allocations/${allocationId}/close`, body),
  setJoiningDate: (allocationId: number, joining_date: DateOnly) =>
    post<Allocation>(`/batch-allocations/${allocationId}/joining-date`, { joining_date }),
  curriculumVersions: (courseId?: number) => get<CurriculumVersion[]>("/curriculum-versions", { course_id: courseId }),
  createCurriculumVersion: (body: { course_id: number; version_label: string; notes?: string | null; publish?: boolean }) =>
    post<CurriculumVersion>("/curriculum-versions", body),
  publishCurriculumVersion: (id: number) => post<CurriculumVersion>(`/curriculum-versions/${id}/publish`, {}),
};

export const batchKeys = {
  all: ["batches"] as const,
  list: (filters: BatchFilters) => ["batches", "list", filters] as const,
  detail: (id: number) => ["batches", "detail", id] as const,
  check: (batchId: number, admissionId: number) => ["batches", "check", batchId, admissionId] as const,
  curricula: ["curriculum-versions"] as const,
  curriculaFor: (courseId?: number) => ["curriculum-versions", courseId ?? null] as const,
};

export const useBatch = (id: number) => useQuery({ queryKey: batchKeys.detail(id), queryFn: () => batchesApi.get(id) });
export const useCurriculumVersions = (courseId?: number, enabled = true) =>
  useQuery({ queryKey: batchKeys.curriculaFor(courseId), queryFn: () => batchesApi.curriculumVersions(courseId), enabled });
