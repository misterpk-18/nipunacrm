import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { PASSWORD, USERS, login, uniquePhone } from "./helpers";

test.describe.configure({ timeout: 90_000 });

const SHOTS = "/private/tmp/claude-501/-Users-manojtungala-nipuna-crm/3aa0633b-0a9a-4dca-89e8-f5788c3e5648/scratchpad/shots";

// ---------------------------------------------------------------- API setup helpers (test data only)

type Api = { call: <T = any>(method: string, path: string, body?: unknown, expected?: number) => Promise<T> };

async function api(request: APIRequestContext, email: string): Promise<Api> {
  const res = await request.post("/api/v1/auth/login", { data: { email, password: PASSWORD } });
  expect(res.status(), `login ${email}`).toBe(200);
  const token = (await res.json()).data.token as string;
  return {
    call: async (method, path, body, expected) => {
      const r = await request.fetch(`/api/v1${path}`, { method, data: body, headers: { Authorization: `Bearer ${token}` } });
      const json = r.status() === 204 ? null : await r.json();
      if (expected ? r.status() !== expected : r.status() >= 400) throw new Error(`${method} ${path} → ${r.status()} ${JSON.stringify(json)}`);
      return json?.data;
    },
  };
}

let counter = 0;
function freshPhone() {
  counter += 1;
  return `${uniquePhone().slice(0, 8)}${String(counter).padStart(2, "0")}`;
}

/** Lead → fee discussion → version → approve → accept plan → invoice (Guntur, as Counsellor A). */
async function issuedInvoice(request: APIRequestContext, name: string, plan: "FULL" | "TWO_INSTALMENTS" = "FULL") {
  const sales = await api(request, USERS.salesGnt);
  const lookups = await sales.call("GET", "/lookups");
  const id = (list: { id: number; code: string }[], code: string) => list.find((x) => x.code === code)!.id;
  const plans = await sales.call<{ payment_plan_id: number; plan_code: string }[]>("GET", "/payment-plans");
  const lead = await sales.call("POST", "/leads", {
    branch_id: 1,
    person: { full_name: name, phone: freshPhone() },
    course_id: 3,
    lead_source_id: id(lookups.lead_sources, "WEBSITE"),
    contact_channel_id: id(lookups.contact_channels, "WEB_FORM"),
    entry_method_id: id(lookups.entry_methods, "WEBSITE"),
  });
  const discussion = await sales.call("POST", `/leads/${lead.lead_id}/fee-discussions`, {});
  const version = await sales.call("POST", `/fee-discussions/${discussion.fee_discussion_id}/versions`, {
    payment_plan_id: plans.find((p) => p.plan_code === plan)!.payment_plan_id,
  });
  await sales.call("POST", `/fee-discussion-versions/${version.version_id}/approve`);
  await sales.call("POST", `/fee-discussions/${discussion.fee_discussion_id}/accept-plan`, { version_id: version.version_id, delivery_mode: "Classroom", seat_type: "Confirmed Seat" });
  const invoice = await sales.call("POST", `/fee-discussion-versions/${version.version_id}/invoice`, {});
  return { sales, lead, invoice, upi: id(lookups.payment_modes, "UPI_BANK") };
}

async function verifiedPayment(request: APIRequestContext, flow: Awaited<ReturnType<typeof issuedInvoice>>, amount: string) {
  const { payment } = await flow.sales.call("POST", "/payments", { invoice_id: flow.invoice.invoice_id, amount, payment_mode_id: flow.upi, reference: `UTR${freshPhone()}` });
  const accounts = await api(request, USERS.accountsGnt);
  await accounts.call("POST", `/payments/${payment.payment_id}/verify`);
  return payment as { payment_id: number; receipt_number: string };
}

async function admitted(request: APIRequestContext, name: string, plan: "FULL" | "TWO_INSTALMENTS", amount?: string) {
  const flow = await issuedInvoice(request, name, plan);
  const half = (Math.round(Number(flow.invoice.billed_amount) * 50) / 100).toFixed(2); // test data only
  const payment = await verifiedPayment(request, flow, amount === "half" ? half : (amount ?? flow.invoice.billed_amount));
  const admission = await flow.sales.call("POST", "/admissions", { invoice_id: flow.invoice.invoice_id });
  return { ...flow, payment, admission };
}

async function shot(page: Page, name: string) {
  await page.screenshot({ path: `${SHOTS}/finance-${name}.png`, fullPage: true });
}

async function logout(page: Page) {
  await page.context().clearCookies();
  await page.evaluate(() => window.sessionStorage.clear());
}

// ---------------------------------------------------------------- invoices

test("invoice register shows real totals and opens an invoice with schedule, ledger and readiness", async ({ page }) => {
  await login(page, USERS.accountsGnt);
  await page.goto("/invoices");
  await expect(page.getByRole("heading", { name: "Invoice Register" })).toBeVisible();
  await expect(page.getByText("Pending verification (excluded)")).toBeVisible();
  await expect(page.getByRole("link", { name: /INV-GNT-/ }).first()).toBeVisible();
  await expect(page.getByText("INV-VIJ-", { exact: false })).toHaveCount(0); // accounts.gnt sees Guntur only
  await shot(page, "invoices");

  await page.getByLabel("Payment completion").selectOption("Part Paid");
  await expect(page).toHaveURL(/completion=Part/);
  await page.getByLabel("Search invoices").fill("INV-GNT-2627-0002");
  await page.getByLabel("Search invoices").press("Enter");
  await page.getByRole("link", { name: /INV-GNT-2627-0002/ }).click();
  await expect(page.getByRole("heading", { name: "INV-GNT-2627-0002" })).toBeVisible();
  await expect(page.getByText("Instalment schedule")).toBeVisible();
  await expect(page.getByRole("cell", { name: "GNT-R-2627-00002", exact: false }).first()).toBeVisible();
  await expect(page.getByText(/Already admitted as NIT-GNT-2026-000002/)).toBeVisible();
  await shot(page, "invoice-detail");

  await page.getByRole("button", { name: "Print invoice" }).click();
  const sheet = page.getByTestId("invoice-sheet");
  await expect(sheet.getByText("Tax invoice")).toBeVisible();
  await expect(sheet.getByText("Divya Sree")).toBeVisible();
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Receipt GNT-R-2627-00002" }).click();
  await expect(page.getByTestId("receipt-sheet").getByText("GNT-R-2627-00002")).toBeVisible();
  await expect(page.getByRole("dialog").getByText("Payment receipt")).toBeVisible();
});

test("counsellor records a payment with proof; Accounts verifies it; the invoice becomes ready for admission", async ({ page, request }) => {
  const name = `Fin Pay ${Date.now()}`;
  const { invoice } = await issuedInvoice(request, name);

  await login(page, USERS.salesGnt);
  await page.goto(`/invoices/${invoice.invoice_id}`);
  await expect(page.getByRole("heading", { name: invoice.invoice_number })).toBeVisible();
  await expect(page.getByText("Not ready for admission")).toBeVisible();
  await page.getByRole("button", { name: "Record payment" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Amount (₹)").fill("5000");
  await dialog.getByLabel("Payment mode").selectOption({ label: "UPI / Bank Transfer" });
  await dialog.getByRole("button", { name: "Record payment" }).click();
  await expect(dialog.getByText("UPI / Bank Transfer needs a reference")).toBeVisible(); // client-side rule mirrors the mode master
  await dialog.getByLabel(/^Reference/).fill(`UTR${Date.now()}`);
  await dialog.getByLabel("Proof (optional)").setInputFiles({ name: "proof.png", mimeType: "image/png", buffer: Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000000020001e221bc330000000049454e44ae426082", "hex") });
  await dialog.getByRole("button", { name: "Record payment" }).click();
  await expect(page.getByText(/recorded as Pending Verification/)).toBeVisible();
  const row = page.getByRole("row", { name: /Pending Verification/ });
  await expect(row).toBeVisible();
  const receipt = (await row.getByRole("cell").first().innerText()).split("\n")[0]!.trim();
  // Counsellors can't verify
  await expect(page.getByRole("button", { name: `Verify ${receipt}` })).toHaveCount(0);
  await row.getByRole("button", { name: `Receipt ${receipt}` }).click();
  await expect(page.getByRole("dialog").getByText(/Acknowledgement of proof only/).first()).toBeVisible();
  await page.keyboard.press("Escape");

  await logout(page);
  await login(page, USERS.accountsGnt);
  await page.goto(`/payments?status=Pending+Verification&q=${receipt}`);
  await expect(page.getByRole("cell", { name: receipt, exact: false }).first()).toBeVisible();
  await shot(page, "payments-pending");
  await page.getByRole("button", { name: `Verify ${receipt}` }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Verify payment" }).click();
  await expect(page.getByText(`${receipt} verified`)).toBeVisible();

  await page.goto(`/invoices/${invoice.invoice_id}`);
  await expect(page.getByRole("link", { name: "Create admission" })).toHaveAttribute("href", new RegExp(`/admissions/new\\?invoiceId=${invoice.invoice_id}`));
  await expect(page.getByRole("button", { name: `Verify ${receipt}` })).toHaveCount(0); // verify only pending receipts
});

test("Accounts fails a pending receipt with a reason", async ({ page, request }) => {
  const flow = await issuedInvoice(request, `Fin Fail ${Date.now()}`);
  const { payment } = await flow.sales.call("POST", "/payments", { invoice_id: flow.invoice.invoice_id, amount: "2000", payment_mode_id: flow.upi, reference: `UTR${freshPhone()}` });
  await login(page, USERS.accountsGnt);
  await page.goto(`/invoices/${flow.invoice.invoice_id}`);
  await page.getByRole("button", { name: `Fail ${payment.receipt_number}` }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Failure reason").fill("Not in bank statement");
  await dialog.getByRole("button", { name: "Mark failed" }).click();
  await expect(page.getByText(`${payment.receipt_number} marked Failed`)).toBeVisible();
  await expect(page.getByRole("row", { name: new RegExp(payment.receipt_number) }).getByText("Failed", { exact: true })).toBeVisible();
});

// ---------------------------------------------------------------- corrections

test("correction: Accounts requests, a distinct admin approves and a linked reversal appears; no self-approval", async ({ page, request }) => {
  const flow = await issuedInvoice(request, `Fin Corr ${Date.now()}`);
  const first = await verifiedPayment(request, flow, "6000");
  const second = await verifiedPayment(request, flow, "4000");
  // An admin raises the second request, so that admin cannot approve it
  const admin = await api(request, USERS.admin);
  await admin.call("POST", `/payments/${second.payment_id}/correction-requests`, { reason: "Duplicate entry (admin)" });

  await login(page, USERS.accountsGnt);
  await page.goto(`/invoices/${flow.invoice.invoice_id}`);
  await page.getByRole("button", { name: `Request correction for ${first.receipt_number}` }).click();
  await page.getByRole("dialog").getByLabel("Reason (required)").fill("Wrong amount keyed in");
  await page.getByRole("dialog").getByRole("button", { name: "Submit for approval" }).click();
  await expect(page.getByText(/submitted for approval/)).toBeVisible();
  await expect(page.getByRole("row", { name: /Wrong amount keyed in/ }).getByText("Awaiting Founder / CEO or Super Admin")).toBeVisible();

  await logout(page);
  await login(page, USERS.admin);
  await page.goto(`/invoices/${flow.invoice.invoice_id}`);
  await expect(page.getByRole("row", { name: /Duplicate entry \(admin\)/ }).getByText(/Self-approval not allowed/)).toBeVisible();

  await logout(page);
  await login(page, USERS.founder);
  await page.goto("/payments?tab=corrections&cstatus=Pending+Approval");
  const request1 = page.getByRole("row", { name: /Wrong amount keyed in/ });
  await request1.getByRole("button", { name: "Approve" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Approve & reverse" }).click();
  await expect(page.getByText(/approved · reversal/)).toBeVisible();

  await page.goto(`/invoices/${flow.invoice.invoice_id}`);
  await expect(page.getByRole("row", { name: /Reversal/ }).first()).toBeVisible();
  await expect(page.getByRole("row", { name: /Wrong amount keyed in/ }).getByText("Approved")).toBeVisible();
  await shot(page, "invoice-reversal");
});

// ---------------------------------------------------------------- collections

test("collections shows dues, ageing and records / resolves a payment promise", async ({ page, request }) => {
  const name = `Fin Promise ${Date.now()}`;
  await admitted(request, name, "TWO_INSTALMENTS", "half");

  await login(page, USERS.accountsGnt);
  await page.goto("/collections?tab=Overdue");
  await expect(page.getByRole("row", { name: /Divya Sree/ })).toBeVisible();
  await page.getByRole("tab", { name: "Ageing" }).click();
  await expect(page.getByRole("row", { name: /4–7/ }).getByText("₹12,000").first()).toBeVisible();
  await shot(page, "collections-ageing");

  await page.getByRole("tab", { name: "Upcoming" }).click();
  await page.getByLabel("Payment plan").selectOption({ label: "Two Instalments" });
  const row = page.getByRole("row", { name: new RegExp(name) });
  await expect(row).toBeVisible();
  await shot(page, "collections-upcoming");
  await row.getByRole("button", { name: `Promises for ${name}` }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("No promises yet")).toBeVisible();
  const tomorrow = new Date(Date.now() + 5.5 * 3600_000 + 86_400_000).toISOString().slice(0, 10);
  await dialog.getByLabel("Promised amount (₹)").fill("1000");
  await dialog.getByLabel("Promised date").fill(tomorrow);
  await dialog.getByRole("button", { name: "Add promise" }).click();
  await expect(page.getByText(/Promise of ₹1,000 .* recorded/)).toBeVisible();
  await dialog.getByRole("button", { name: "Kept" }).click();
  await expect(page.getByText("Promise marked Kept")).toBeVisible();
  await expect(dialog.getByRole("cell", { name: "Kept" })).toBeVisible();
});

// ---------------------------------------------------------------- refunds

test("refund: BM registers and assesses, admin decides, Accounts pays out, reconciles and completes", async ({ page, request }) => {
  const name = `Fin Refund ${Date.now()}`;
  const flow = await admitted(request, name, "FULL");

  await login(page, USERS.bmGnt);
  await page.goto("/refunds?status=Registered");
  await expect(page.getByRole("row", { name: /Naveen Chandra/ })).toBeVisible();
  await page.goto("/refunds");
  await page.getByRole("button", { name: "Register refund case" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Find admission").fill(name);
  const select = dialog.getByLabel("Admission", { exact: true });
  const option = select.locator("option", { hasText: name });
  await expect(option).toHaveCount(1);
  await select.selectOption((await option.getAttribute("value"))!);
  await dialog.getByRole("checkbox", { name: new RegExp(flow.payment.receipt_number) }).check();
  await dialog.getByLabel("Request reason").fill("Relocating for a job");
  await dialog.getByRole("button", { name: "Register case" }).click();
  await expect(page.getByText(/NIT-RF-\d+ registered/)).toBeVisible();
  await expect(page.getByText(`${flow.payment.receipt_number} · linked to case`)).toBeVisible();
  await page.getByLabel("Assessment notes").fill("Before batch start; full refund eligible");
  await page.getByRole("button", { name: "Save assessment" }).click();
  await expect(page.getByText("Assessment saved")).toBeVisible();
  await expect(page.getByText("Awaiting decision by Founder / CEO or Super Admin.")).toBeVisible();
  const url = page.url();
  await shot(page, "refund-registered");

  await logout(page);
  await login(page, USERS.admin);
  await page.goto(url.replace(/^https?:\/\/[^/]+/, ""));
  await page.getByLabel("Refund amount (₹)").fill("5000");
  await page.getByRole("button", { name: "Record decision" }).click();
  await expect(page.getByText(/: Refund Approved/)).toBeVisible();
  await expect(page.getByText("Awaiting payout by Accounts at the service branch.")).toBeVisible();

  await logout(page);
  await login(page, USERS.accountsGnt);
  await page.goto(url.replace(/^https?:\/\/[^/]+/, ""));
  await page.getByLabel("Payout mode").selectOption({ label: "UPI / Bank Transfer" });
  await page.getByLabel("Payout reference").fill(`RFND${Date.now()}`);
  await page.getByRole("button", { name: "Start payout" }).click();
  await expect(page.getByText("Payout started (Processing)")).toBeVisible();
  await page.getByRole("button", { name: "Reconcile payout" }).click();
  await expect(page.getByText("Payout reconciled")).toBeVisible();
  await page.getByRole("button", { name: "Mark payout completed" }).click();
  await expect(page.getByText(/NIT-RF-\d+ completed/)).toBeVisible();
  await expect(page.getByText("Payout Completed").first()).toBeVisible();
  await shot(page, "refund-completed");
});

test("support cases list on the refunds screen", async ({ page }) => {
  await login(page, USERS.bmGnt);
  await page.goto("/refunds?tab=support");
  await expect(page.getByRole("row", { name: /Can't log into LMS/ })).toBeVisible();
});

// ---------------------------------------------------------------- permissions & mobile

test("counsellor sees the ledger without verification or correction tools", async ({ page }) => {
  await login(page, USERS.salesGnt);
  await page.goto("/payments?q=GNT-R-2627-00001");
  await expect(page.getByRole("heading", { name: "Payments & Receipts" })).toBeVisible();
  await expect(page.getByRole("row", { name: /GNT-R-2627-00001/ })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Correction requests" })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Unallocated advances" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Verify / })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Request correction/ })).toHaveCount(0);
  await expect(page.getByText("Only Accounts (or an admin) can verify payments.", { exact: false })).toBeVisible();
});

test("invoice register and payments work at phone width @mobile", async ({ page }) => {
  await login(page, USERS.accountsGnt);
  await page.goto("/invoices?q=INV-GNT-2627-0002");
  await expect(page.getByRole("link", { name: /INV-GNT-2627-0002/ }).first()).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await shot(page, "invoices-mobile");
  await page.goto("/collections?tab=Overdue");
  await expect(page.getByText("Divya Sree").first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
  await shot(page, "collections-mobile");
});
