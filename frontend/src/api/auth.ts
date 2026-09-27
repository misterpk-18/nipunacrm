import { del, get, post } from "./client";
import type { BranchRef, DateTime, RoleCode } from "./types";

export type SessionUser = {
  user_id: number;
  full_name: string;
  email: string;
  phone: string | null;
  person_id: number | null;
  is_active: boolean;
  is_recovery_account: boolean;
  must_change_password: boolean;
  is_locked: boolean;
  last_login_at: DateTime | null;
  created_at: DateTime;
};

export type RoleScope = {
  scope_id: number;
  role_code: RoleCode;
  role_name: string;
  branch_id: number | null;
  branch_code: string | null;
  granted_at: DateTime;
  expires_at: DateTime | null;
};

export type Profile = {
  user: SessionUser;
  scopes: RoleScope[];
  allowed_branches: BranchRef[];
  home_route: string;
};

export type LoginResult = Profile & { token: string; expires_at: DateTime };

export type SessionInfo = {
  session_id: string;
  created_at: DateTime;
  last_seen_at: DateTime;
  expires_at: DateTime;
  ip_address: string | null;
  user_agent: string | null;
  current: boolean;
};

export const authApi = {
  login: (email: string, password: string) => post<LoginResult>("/auth/login", { email, password }),
  logout: () => post<null>("/auth/logout"),
  me: () => get<Profile>("/auth/me"),
  reauthenticate: (password: string) => post<null>("/auth/reauthenticate", { password }),
  changePassword: (current_password: string, new_password: string) =>
    post<null>("/auth/change-password", { current_password, new_password }),
  sessions: () => get<SessionInfo[]>("/auth/sessions"),
  revokeSession: (id: string) => del<null>(`/auth/sessions/${id}`),
};
