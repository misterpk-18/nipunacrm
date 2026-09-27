/** Admin / Settings: users & access, settings, branches / shifts / holidays, lookups, concession limits,
 * notification rules, branch channels, integrations, incidents, sessions, deletion requests, audit log. */
import { useQuery } from "@tanstack/react-query";
import { del, get, list, patch, post, put, type Query } from "./client";
import type { RoleScope, SessionUser } from "./auth";
import type { BranchRef, DateOnly, DateTime, Money, RoleCode } from "./types";

// ---------------------------------------------------------------- users

export type AdminUser = SessionUser & { scopes: RoleScope[] };
export type ScopeDetail = RoleScope & {
  granted_by: number | null;
  revoked_at: DateTime | null;
  revoked_by: number | null;
  status: string;
};
export type ScopeInput = {
  role_code: RoleCode;
  branch_id: number | null;
  expires_at?: DateTime | null;
};
export type NewUser = {
  full_name: string;
  email: string;
  phone?: string | null;
  is_recovery_account?: boolean;
  scopes: ScopeInput[];
};
export type UserFilters = {
  page?: number;
  per_page?: number;
  role?: string;
  branch_id?: number;
  is_active?: boolean;
  q?: string;
};

// ---------------------------------------------------------------- masters

export type Setting = {
  key: string;
  value: string | number | boolean;
  description: string | null;
  updated_by: number | null;
  updated_at: DateTime;
};
export type Shift = {
  day_of_week: number;
  opens_at: string;
  closes_at: string;
};
export type Holiday = {
  holiday_id: number;
  branch_id: number | null;
  holiday_date: DateOnly;
  name: string;
};
export type LookupRow = {
  id: number;
  code: string;
  label: string;
  sort_order: number;
  is_active: boolean;
} & Record<string, unknown>;
export type ConcessionLimit = {
  role_code: RoleCode;
  role_name: string;
  max_percent: string | null;
  max_amount: Money | null;
  unlimited: boolean;
};

export const LOOKUP_TYPES: { type: string; label: string; extras: string[] }[] =
  [
    { type: "lead-sources", label: "Lead sources", extras: [] },
    { type: "contact-channels", label: "Contact channels", extras: [] },
    { type: "entry-methods", label: "Entry methods", extras: [] },
    {
      type: "payment-modes",
      label: "Payment modes",
      extras: ["requires_reference", "requires_approval"],
    },
    { type: "lost-reasons", label: "Lost reasons", extras: [] },
    { type: "task-types", label: "Task types", extras: [] },
    {
      type: "document-types",
      label: "Document types",
      extras: ["is_mandatory"],
    },
    { type: "support-case-types", label: "Support case types", extras: [] },
  ];

// ---------------------------------------------------------------- operations

export type NotificationRule = {
  rule_id: number;
  rule_code: string;
  event_type: string;
  description: string | null;
  recipient_role: string;
  category: string;
  warn_after_minutes: number | null;
  escalate_after_minutes: number | null;
  escalate_to_role: string | null;
  send_whatsapp: boolean;
  send_email: boolean;
  is_active: boolean;
};

export type BranchChannel = {
  branch_channel_id: number;
  branch: BranchRef;
  channel: string;
  contact_channel_id: number;
  address: string;
  mode: string;
  is_active: boolean;
};

export const INTEGRATION_STATES = [
  "Planned",
  "Manual",
  "Configured",
  "Live",
  "Disabled",
] as const;
export const INTEGRATION_MODES = ["Manual", "API"] as const;
export const VERIFICATION_STATES = [
  "Pending Verification",
  "Verified",
  "Failed",
] as const;
export const INCIDENT_SEVERITIES = [
  "Not Set",
  "Low",
  "Medium",
  "High",
  "Critical",
] as const;
export const INCIDENT_STATUSES = [
  "Open",
  "Investigating",
  "Resolved",
  "Closed",
] as const;
export const DELETION_STATUSES = [
  "Pending",
  "Approved",
  "Rejected",
  "Executed",
] as const;
export const DELETABLE_TYPES = [
  "document",
  "saved_view",
  "branch_channel",
] as const;

export type Integration = {
  service_code: string;
  service_name: string;
  state: string;
  verification: string;
  last_successful_test_at: DateTime | null;
  notes: string | null;
  updated_by: number | null;
  updated_at: DateTime;
};

export type Incident = {
  incident_id: number;
  incident_code: string;
  title: string;
  description: string | null;
  severity: string;
  status: string;
  owner_user_id: number | null;
  detected_at: DateTime;
  root_cause: string | null;
  backup_reference: string | null;
  resolved_at: DateTime | null;
  created_by: number | null;
  created_at: DateTime;
};

export type AdminSession = {
  session_id: string;
  created_at: DateTime;
  last_seen_at: DateTime;
  expires_at: DateTime;
  ip_address: string | null;
  user_agent: string | null;
  current: boolean;
  user: { user_id: number; full_name: string; email: string };
};

export type DeletionRequest = {
  request_id: number;
  entity_type: string;
  entity_id: string;
  reason: string;
  status: string;
  requested_by: number;
  requested_at: DateTime;
  decided_by: number | null;
  decided_at: DateTime | null;
  executed_at: DateTime | null;
};

export type AuditEntry = {
  audit_id: number;
  occurred_at: DateTime;
  actor_user_id: number | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  branch_id: number | null;
  old_values: unknown;
  new_values: unknown;
  reason: string | null;
  ip_address: string | null;
};

export type AuditFilters = {
  page?: number;
  entity_type?: string;
  entity_id?: string;
  actor_id?: number;
  action?: string;
  branch_id?: number;
};

export const adminApi = {
  // users
  users: (f: UserFilters) => list<AdminUser>("/users", f as Query),
  user: (id: number) => get<AdminUser>(`/users/${id}`),
  createUser: (body: NewUser) =>
    post<{ user: AdminUser; temporary_password: string }>("/users", body),
  updateUser: (
    id: number,
    body: {
      full_name?: string;
      email?: string;
      phone?: string | null;
      is_active?: boolean;
    },
  ) => patch<AdminUser>(`/users/${id}`, body),
  resetPassword: (id: number) =>
    post<{ user: AdminUser; temporary_password: string }>(
      `/users/${id}/reset-password`,
    ),
  scopes: (id: number) => get<ScopeDetail[]>(`/users/${id}/scopes`),
  grantScope: (id: number, body: ScopeInput) =>
    post<ScopeDetail>(`/users/${id}/scopes`, body),
  revokeScope: (id: number, scopeId: number) =>
    del<ScopeDetail>(`/users/${id}/scopes/${scopeId}`),
  // settings & masters
  settings: () => get<Setting[]>("/settings"),
  updateSettings: (values: Record<string, unknown>) =>
    patch<Setting[]>("/settings", values),
  updateBranch: (
    id: number,
    body: {
      branch_name?: string;
      city?: string;
      address?: string | null;
      phone?: string | null;
      email?: string | null;
    },
  ) => patch<unknown>(`/branches/${id}`, body),
  shifts: (branchId: number) => get<Shift[]>(`/branches/${branchId}/shifts`),
  replaceShifts: (branchId: number, shifts: Shift[]) =>
    put<Shift[]>(`/branches/${branchId}/shifts`, { shifts }),
  holidays: (query: { year?: number; branch_id?: number }) =>
    get<Holiday[]>("/holidays", query),
  createHoliday: (body: {
    branch_id: number | null;
    holiday_date: DateOnly;
    name: string;
  }) => post<Holiday>("/holidays", body),
  deleteHoliday: (id: number) => del<null>(`/holidays/${id}`),
  lookup: (type: string) => get<LookupRow[]>(`/lookups/${type}`),
  createLookup: (type: string, body: Record<string, unknown>) =>
    post<LookupRow>(`/lookups/${type}`, body),
  updateLookup: (type: string, id: number, body: Record<string, unknown>) =>
    patch<LookupRow>(`/lookups/${type}/${id}`, body),
  concessionLimits: () => get<ConcessionLimit[]>("/concession-limits"),
  replaceConcessionLimits: (
    limits: {
      role_code: string;
      max_percent: string | null;
      max_amount: string | null;
    }[],
  ) => put<ConcessionLimit[]>("/concession-limits", { limits }),
  // operations
  notificationRules: () => get<NotificationRule[]>("/notification-rules"),
  updateNotificationRule: (id: number, body: Partial<NotificationRule>) =>
    patch<NotificationRule>(`/notification-rules/${id}`, body),
  channels: (branchId?: number) =>
    get<BranchChannel[]>("/branch-channels", { branch_id: branchId }),
  createChannel: (body: {
    branch_id: number;
    contact_channel_id: number;
    address: string;
    mode?: string;
    is_active?: boolean;
  }) => post<BranchChannel>("/branch-channels", body),
  updateChannel: (
    id: number,
    body: { address?: string; mode?: string; is_active?: boolean },
  ) => patch<BranchChannel>(`/branch-channels/${id}`, body),
  integrations: () => get<Integration[]>("/integrations"),
  updateIntegration: (
    code: string,
    body: {
      state?: string;
      verification?: string;
      last_successful_test_at?: DateTime | null;
      notes?: string | null;
    },
  ) => patch<Integration>(`/integrations/${code}`, body),
  incidents: (query: { page?: number; status?: string; severity?: string }) =>
    list<Incident>("/incidents", query),
  createIncident: (body: Partial<Incident>) =>
    post<Incident>("/incidents", body),
  updateIncident: (id: number, body: Partial<Incident>) =>
    patch<Incident>(`/incidents/${id}`, body),
  sessions: (userId?: number) =>
    get<AdminSession[]>("/admin/sessions", { user_id: userId }),
  revokeSession: (sessionId: string) =>
    del<null>(`/admin/sessions/${sessionId}`),
  deletions: (query: { page?: number; status?: string }) =>
    list<DeletionRequest>("/deletion-requests", query),
  requestDeletion: (body: {
    entity_type: string;
    entity_id: number;
    reason: string;
  }) => post<DeletionRequest>("/deletion-requests", body),
  approveDeletion: (id: number) =>
    post<DeletionRequest>(`/deletion-requests/${id}/approve`),
  rejectDeletion: (id: number) =>
    post<DeletionRequest>(`/deletion-requests/${id}/reject`),
  executeDeletion: (id: number) =>
    post<DeletionRequest>(`/deletion-requests/${id}/execute`),
  auditLog: (f: AuditFilters) => list<AuditEntry>("/audit-log", f as Query),
};

export const adminKeys = {
  users: ["users"] as const,
  userList: (f: UserFilters) => ["users", "list", f] as const,
  scopes: (id: number) => ["users", "scopes", id] as const,
  settings: ["settings"] as const,
  shifts: (branchId: number) => ["branches", "shifts", branchId] as const,
  holidays: ["holidays"] as const,
  lookup: (type: string) => ["lookups", type] as const,
  concession: ["concession-limits"] as const,
  rules: ["notification-rules"] as const,
  channels: ["branch-channels"] as const,
  integrations: ["integrations"] as const,
  incidents: ["incidents"] as const,
  sessions: ["admin-sessions"] as const,
  deletions: ["deletion-requests"] as const,
  audit: ["audit-log"] as const,
};

export const useSettings = () =>
  useQuery({ queryKey: adminKeys.settings, queryFn: adminApi.settings });
