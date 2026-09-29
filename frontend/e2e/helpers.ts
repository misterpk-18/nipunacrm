import { expect, type Page } from "@playwright/test";

export const PASSWORD = "Nipuna-staging-1";

/** Staging accounts created by `flask seed-dev` (all use PASSWORD). */
export const USERS = {
  founder: "founder@nipuna.test",
  admin: "admin@nipuna.test",
  bmGnt: "bm.gnt@nipuna.test",
  bmVij: "bm.vij@nipuna.test",
  salesGnt: "sales.gnt@nipuna.test",
  salesVij: "sales.vij@nipuna.test",
  foGnt: "fo.gnt@nipuna.test",
  accountsGnt: "accounts.gnt@nipuna.test",
  accountsVij: "accounts.vij@nipuna.test",
  coordGnt: "coordinator.gnt@nipuna.test",
  trainerG1: "trainer.g1@nipuna.test",
  placementGnt: "placement.gnt@nipuna.test",
} as const;

export async function login(page: Page, email: string, password = PASSWORD) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

/** A unique 10-digit mobile for records created by a test run. */
export function uniquePhone() {
  return `9${String(Date.now()).slice(-9)}`;
}

// ---------------------------------------------------------------- V4 deal flow via the API (test setup only)

export const QUALIFICATION_CHECKS = [
  "Genuine intent confirmed",
  "Reachable contact confirmed",
  "Intended course(s) understood",
  "Branch and delivery mode discussed",
  "Exact next action agreed",
  "Possible identity match reviewed",
];

type Headers = Record<string, string>;
type Request = import("@playwright/test").APIRequestContext;

export async function apiToken(request: Request, email: string): Promise<Headers> {
  const res = await request.post("/api/v1/auth/login", { data: { email, password: PASSWORD } });
  expect(res.ok()).toBeTruthy();
  return { Authorization: `Bearer ${(await res.json()).data.token as string}` };
}

async function ok<T>(res: import("@playwright/test").APIResponse): Promise<T> {
  expect(res.ok(), await res.text()).toBeTruthy();
  return (await res.json()).data as T;
}

/** Qualify (all six checks) and convert a lead to a deal: it joins the person's pipeline card at Counselling. */
export async function qualifyAndConvert(request: Request, headers: Headers, leadId: number, courseIds?: number[]) {
  for (const check of QUALIFICATION_CHECKS)
    await ok(await request.put(`/api/v1/leads/${leadId}/qualification/checks`, { headers, data: { check, reviewed: true } }));
  await ok(await request.post(`/api/v1/leads/${leadId}/qualify`, { headers }));
  const lead = await ok<{ course: { course_id: number } | null }>(await request.get(`/api/v1/leads/${leadId}`, { headers }));
  return ok(await request.post(`/api/v1/leads/${leadId}/convert`, { headers, data: { course_ids: courseIds ?? [lead.course!.course_id] } }));
}

/** Approved standard-price fee version for a deal. */
export async function approvedFee(request: Request, headers: Headers, leadId: number, extra: Record<string, unknown> = {}) {
  const discussion = await ok<{ fee_discussion_id: number }>(await request.post(`/api/v1/leads/${leadId}/fee-discussions`, { headers, data: {} }));
  const version = await ok<{ version_id: number; final_payable: string }>(
    await request.post(`/api/v1/fee-discussions/${discussion.fee_discussion_id}/versions`, { headers, data: extra }),
  );
  await ok(await request.post(`/api/v1/fee-discussion-versions/${version.version_id}/approve`, { headers }));
  return { discussion, version };
}

export async function acceptDeliveryPlan(request: Request, headers: Headers, leadId: number, body: Record<string, unknown> = {}) {
  return ok(
    await request.post(`/api/v1/leads/${leadId}/delivery-plan/accept`, {
      headers,
      data: { delivery_mode: "Classroom", seat_type: "Confirmed Seat", capacity_review: "Checked", student_accepted: true, ...body },
    }),
  );
}

/** Invoice for one or more ready deals; one instalment for the whole total unless given. */
export async function createInvoice(request: Request, headers: Headers, leadIds: number[], installments?: { due_date: string; amount: string }[]) {
  return ok<{ invoice_id: number; invoice_number: string; billed_amount: string }>(
    await request.post("/api/v1/invoices", { headers, data: { lead_ids: leadIds, ...(installments ? { installments } : {}) } }),
  );
}

export async function recordPayment(request: Request, headers: Headers, invoiceId: number, amount: string, mode = "UPI / Bank Transfer") {
  const lookups = await ok<Record<string, { id: number; label: string }[]>>(await request.get("/api/v1/lookups", { headers }));
  const modeId = lookups["payment_modes"]!.find((m) => m.label === mode)!.id;
  const res = await ok<{ payment: { payment_id: number; transaction_number: string } }>(
    await request.post("/api/v1/payments", { headers, data: { invoice_id: invoiceId, amount, payment_mode_id: modeId, reference: mode === "Cash" ? null : `UTR${Date.now()}` } }),
  );
  return res.payment;
}

export async function verifyPayment(request: Request, headers: Headers, paymentId: number) {
  return ok<{ receipt_number: string; admissions_created: { admission_id: number; admission_code: string }[] }>(
    await request.post(`/api/v1/payments/${paymentId}/verify`, { headers, data: { evidence_reviewed: true, cash_checked: true } }),
  );
}

export const todayIST = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
