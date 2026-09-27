/**
 * Fetch wrapper for the Flask API (/api/v1, proxied by Vite in dev).
 *
 * - Sends the session token as `Authorization: Bearer <token>`.
 * - Unwraps `{ data, meta }`; throws ApiError(code, message, details, status) for `{ error }`.
 * - FRESH_AUTH_REQUIRED: asks the registered handler (FreshAuthDialog) for the password, then retries once.
 * - UNAUTHENTICATED: clears the token and notifies the auth layer (→ login screen).
 */

export const API_BASE = "/api/v1";
const TOKEN_KEY = "nipuna-session";

export type PageMeta = { page: number; per_page: number; total: number; pages: number };
export type Page<T> = { data: T[]; meta: PageMeta };

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details: Record<string, string[]> | null = null,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------- token

let token: string | null = readToken();

function readToken(): string | null {
  try {
    return window.sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function getToken() {
  return token;
}

export function setToken(next: string | null) {
  token = next;
  try {
    if (next) window.sessionStorage.setItem(TOKEN_KEY, next);
    else window.sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable: token stays in memory only */
  }
}

// ---------------------------------------------------------------- hooks set by the auth layer

let onUnauthenticated: () => void = () => {};
let onFreshAuthRequired: () => Promise<boolean> = async () => false;
let onPasswordChangeRequired: () => void = () => {};

export function registerAuthHandlers(handlers: {
  unauthenticated: () => void;
  freshAuthRequired: () => Promise<boolean>;
  passwordChangeRequired: () => void;
}) {
  onUnauthenticated = handlers.unauthenticated;
  onFreshAuthRequired = handlers.freshAuthRequired;
  onPasswordChangeRequired = handlers.passwordChangeRequired;
}

// ---------------------------------------------------------------- requests

export type Query = Record<string, string | number | boolean | null | undefined>;

type RequestOptions = { query?: Query | undefined; body?: unknown; form?: FormData };

export function buildQuery(query?: Query) {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

async function send(method: string, path: string, options: RequestOptions, retried = false): Promise<unknown> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  let body: BodyInit | undefined;
  if (options.form) body = options.form;
  else if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.body);
  }

  const response = await fetch(`${API_BASE}${path}${buildQuery(options.query)}`, { method, headers, body });
  if (response.status === 204) return null;

  const type = response.headers.get("Content-Type") ?? "";
  const payload = type.includes("application/json") ? await response.json() : await response.text();
  if (response.ok) return payload;

  const error = (typeof payload === "object" && payload?.error) || {};
  const apiError = new ApiError(
    response.status,
    error.code ?? "HTTP_ERROR",
    error.message ?? `Request failed (${response.status})`,
    error.details ?? null,
  );

  if (apiError.code === "FRESH_AUTH_REQUIRED" && !retried) {
    if (await onFreshAuthRequired()) return send(method, path, options, true);
  } else if (apiError.code === "UNAUTHENTICATED" && path !== "/auth/login") {
    setToken(null);
    onUnauthenticated();
  } else if (apiError.code === "PASSWORD_CHANGE_REQUIRED") {
    onPasswordChangeRequired();
  }
  throw apiError;
}

/** GET a single resource: returns `data`. */
export async function get<T>(path: string, query?: Query): Promise<T> {
  const payload = (await send("GET", path, { query })) as { data: T };
  return payload.data;
}

/** GET a paginated list: returns `{ data, meta }`. */
export async function list<T>(path: string, query?: Query): Promise<Page<T>> {
  const payload = (await send("GET", path, { query })) as Page<T>;
  return { data: payload.data, meta: payload.meta ?? { page: 1, per_page: payload.data.length, total: payload.data.length, pages: 1 } };
}

export async function post<T>(path: string, body: unknown = {}): Promise<T> {
  const payload = (await send("POST", path, { body })) as { data: T } | null;
  return payload?.data as T;
}

export async function patch<T>(path: string, body: unknown): Promise<T> {
  const payload = (await send("PATCH", path, { body })) as { data: T } | null;
  return payload?.data as T;
}

export async function put<T>(path: string, body: unknown): Promise<T> {
  const payload = (await send("PUT", path, { body })) as { data: T } | null;
  return payload?.data as T;
}

export async function del<T>(path: string): Promise<T> {
  const payload = (await send("DELETE", path, {})) as { data: T } | null;
  return payload?.data as T;
}

/** Multipart upload (documents, payment proofs, CSV imports). */
export async function upload<T>(path: string, form: FormData): Promise<T> {
  const payload = (await send("POST", path, { form })) as { data: T } | null;
  return payload?.data as T;
}

/** Download a file the API returns (exports, print views) with the auth header attached. */
export async function download(path: string, query?: Query, filename = "export.csv") {
  const response = await fetch(`${API_BASE}${path}${buildQuery(query)}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!response.ok) throw new ApiError(response.status, "HTTP_ERROR", `Download failed (${response.status})`);
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

/** Human message for any thrown error (used by toasts and error panels). */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "Something went wrong";
}
