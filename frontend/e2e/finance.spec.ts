import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { PASSWORD, USERS, apiToken, login, qualifyAndConvert, todayIST, uniquePhone } from "./helpers";

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

/** Lead → qualify & convert → fee version → approve → accept delivery plan → invoice (Guntur, as Counsellor A). */
async function issuedInvoice(request: APIRequestContext, name: string, plan: "FULL" | "TWO_INSTALMENTS" = "FULL") {
  const sales = await api(request, USERS.salesGnt);
  const lookups = await sales.call("GET", "/lookups");
  const id = (list: { id: number; code: string }[], code: string) => list.find((x) => x.code === code)!.id;
  const lead = await sales.call("POST", "/leads", {
    branch_id: 1,
    person: { full_name: name, phone: freshPhone() },
    course_id: 3,
    lead_source_id: id(lookups.lead_sources, "WEBSITE"),
    contact_channel_id: id(lookups.contact_channels, "WEB_FORM"),
    entry_method_id: id(lookups.entry_methods, "WEBSITE"),
  });
  await qualifyAndConvert(request, await apiToken(request, USERS.salesGnt), lead.lead_id);
  const discussion = await sales.call("POST", `/leads/${lead.lead_id}/fee-discussions`, {});
  const version = await sales.call("POST", `/fee-discussions/${discussion.fee_discussion_id}/versions`, {});
  await sales.call("POST", `/fee-discussion-versions/${version.version_id}/approve`);
  await sales.call("POST", `/leads/${lead.lead_id}/delivery-plan/accept`, { delivery_mode: "Classroom", seat_type: "Confirmed Seat", capacity_review: "Checked", student_accepted: true });
  const total = Math.round(Number(version.final_payable) * 100);
  const day = (n: number) => new Date(Date.parse(`${todayIST()}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  const installments =
    plan === "FULL"
      ? [{ due_date: todayIST(), amount: (total / 100).toFixed(2) }]
      : [
          { due_date: todayIST(), amount: (Math.floor(total / 2) / 100).toFixed(2) },
          { due_date: day(12), amount: ((total - Math.floor(total / 2)) / 100).toFixed(2) },
        ];
  const invoice = await sales.call("POST", "/invoices", { lead_ids: [lead.lead_id], installments });
  return { sales, lead, invoice, upi: id(lookups.payment_modes, "UPI_BANK") };
}

async function verifiedPayment(request: APIRequestContext, flow: Awaited<ReturnType<typeof issuedInvoice>>, amount: string) {
  const { payment } = await flow.sales.call("POST", "/payments", { invoice_id: flow.invoice.invoice_id, amount, payment_mode_id: flow.upi, reference: `UTR${freshPhone()}` });
  const accounts = await api(request, USERS.accountsGnt);
  const verified = await accounts.call("POST", `/payments/${payment.payment_id}/verify`, { evidence_reviewed: true });
  return verified as { payment_id: number; receipt_number: string; transaction_number: string; admissions_created: { admission_id: number }[] };
}

async function admitted(request: APIRequestContext, name: string, plan: "FULL" | "TWO_INSTALMENTS", amount?: string) {
  const flow = await issuedInvoice(request, name, plan);
  const half = (Math.round(Number(flow.invoice.billed_amount) * 50) / 100).toFixed(2); // test data only
  const payment = await verifiedPayment(request, flow, amount === "half" ? half : (amount ?? flow.invoice.billed_amount));
  const admission = payment.admissions_created[0]!; // created on verification (₹1,000 token reached)
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

test("invoices show real totals and open the branch invoice with schedule, courses, ledger and print", async ({ page }) => {
  await login(page, USERS.accountsGnt);
  await page.goto("/invoices");
  await expect(page.getByRole("heading", { name: "Invoices" })).toBeVisible();
  await expect(page.getByText("Never counted as paid")).toBeVisible();
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
  await expect(page.getByRole("cell", { name: /Receipt GNT-R-2627-00002/ }).first()).toBeVisible();
  await expect(page.getByRole("cell", { name: /NIT-GNT-2026-000002/ })).toBeVisible(); // the course's admission

  // The branch invoice document: Guntur issuer snapshot, bill-to, course line, verified receipts
  const sheet = page.getByTestId("invoice-sheet");
  await expect(sheet.getByText("Course invoice")).toBeVisible();
  await expect(sheet.getByText("Divya Sree")).toBeVisible();
  await expect(sheet.getByText(/Door No\. 6-4-35/)).toBeVisible();
  await expect(sheet.getByText("GNT-R-2627-00002")).toBeVisible();
  await expect(page.getByRole("button", { name: "Print / Save PDF" })).toBeEnabled();
  await shot(page, "invoice-detail");

  const receiptRow = page.getByRole("row", { name: /Receipt GNT-R-2627-00002/ });
  await receiptRow.getByRole("button", { name: /^Receipt TXN-/ }).click();
  await expect(page.getByTestId("receipt-sheet").getByText("GNT-R-2627-00002")).toBeVisible();
  await expect(page.getByRole("dialog").getByRole("heading", { name: "Payment receipt" })).toBeVisible();
});

test("counsellor records a payment claim with proof; Accounts verifies it; the course is admitted", async ({ page, request }) => {
  const name = `Fin Pay ${Date.now()}`;
  const { invoice } = await issuedInvoice(request, name);

  await login(page, USERS.salesGnt);
  await page.goto(`/invoices/${invoice.invoice_id}`);
  await expect(page.getByRole("heading", { name: invoice.invoice_number })).toBeVisible();
  await expect(page.getByText(/must reach ₹1000/)).toBeVisible();
  await page.getByRole("link", { name: "Record payment" }).click();
  await expect(page).toHaveURL(new RegExp(`/payments\\?.*invoice=${invoice.invoice_id}`));
  await expect(page.getByLabel("Starting invoice / payer")).toHaveValue(String(invoice.invoice_id)); // preselected
  const allocate = page.getByRole("textbox", { name: /^Allocate to / });
  await allocate.fill("5000");
  await page.getByLabel("Tender 1 mode").selectOption({ label: "UPI / Bank Transfer" });
  await expect(page.getByRole("button", { name: "Record payment" }).last()).toBeDisabled(); // needs a reference
  await page.getByLabel("Tender 1 reference").fill(`UTR${Date.now()}`);
  await page.getByLabel("Proof (optional)").setInputFiles({ name: "proof.png", mimeType: "image/png", buffer: Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000000020001e221bc330000000049454e44ae426082", "hex") });
  await page.getByRole("button", { name: "Record payment" }).last().click();
  await expect(page.getByText(/TXN-GNT-\d+ recorded · pending verification \(no receipt yet\)/)).toBeVisible();

  // The claim shows on the invoice: nothing counted yet, no receipt number
  await page.goto(`/invoices/${invoice.invoice_id}`);
  const row = page.getByRole("row", { name: /No receipt until verified/ });
  await expect(row).toBeVisible();
  const txn = (await row.getByRole("cell").first().innerText()).split("\n")[0]!.trim();
  await expect(page.getByRole("button", { name: `Verify ${txn}` })).toHaveCount(0); // counsellors can't verify
  await row.getByRole("button", { name: `Claim ${txn}` }).click();
  await expect(page.getByRole("dialog").getByRole("heading", { name: "Payment claim" })).toBeVisible();
  await expect(page.getByTestId("receipt-sheet").getByText(/Not a receipt/).first()).toBeVisible();
  await page.keyboard.press("Escape");

  await logout(page);
  await login(page, USERS.accountsGnt);
  await page.goto(`/payments?status=Pending+Verification&q=${encodeURIComponent(name)}`);
  await expect(page.getByRole("cell", { name: txn, exact: false }).first()).toBeVisible();
  await shot(page, "payments-pending");
  await page.getByRole("button", { name: `Verify ${txn}` }).click();
  const verify = page.getByRole("dialog");
  await expect(verify.getByRole("button", { name: "Verify payment" })).toBeDisabled();
  await verify.getByRole("checkbox", { name: "Evidence reviewed" }).click();
  await verify.getByRole("button", { name: "Verify payment" }).click();
  await expect(page.getByText(/GNT-R-2627-\d+ issued · admitted: NIT-GNT-/)).toBeVisible();

  await page.goto(`/invoices/${invoice.invoice_id}`);
  await expect(page.getByRole("cell", { name: /NIT-GNT-\d{4}-\d+/ })).toBeVisible();
  await expect(page.getByRole("button", { name: `Verify ${txn}` })).toHaveCount(0); // verify only pending claims
});

test("Accounts fails a pending claim with a reason", async ({ page, request }) => {
  const flow = await issuedInvoice(request, `Fin Fail ${Date.now()}`);
  const { payment } = await flow.sales.call("POST", "/payments", { invoice_id: flow.invoice.invoice_id, amount: "2000", payment_mode_id: flow.upi, reference: `UTR${freshPhone()}` });
  await login(page, USERS.accountsGnt);
  await page.goto(`/invoices/${flow.invoice.invoice_id}`);
  await page.getByRole("button", { name: `Fail ${payment.transaction_number}` }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Failure reason").fill("Not in bank statement");
  await dialog.getByRole("button", { name: "Mark failed" }).click();
  await expect(page.getByText(`${payment.transaction_number} marked Failed`)).toBeVisible();
  await expect(page.getByRole("row", { name: new RegExp(payment.transaction_number) }).getByText("Failed — no receipt")).toBeVisible();
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
  await expect(page.getByRole("heading", { name: "Payments & receipts" })).toBeVisible();
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
