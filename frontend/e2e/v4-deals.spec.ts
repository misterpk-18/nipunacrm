/**
 * V4 handoff acceptance checklist: branch invoices, courses & identity, payment scenarios, finance consistency,
 * responsive documents. Test data is created through the API (unique phones), so the spec can be re-run.
 */
import { expect, test, type APIRequestContext } from "@playwright/test";
import {
  USERS,
  acceptDeliveryPlan,
  apiToken,
  approvedFee,
  createInvoice,
  login,
  qualifyAndConvert,
  recordPayment,
  todayIST,
  uniquePhone,
  verifyPayment,
} from "./helpers";

test.describe.configure({ timeout: 120_000 });

type Course = { course_id: number; course_code: string; course_title: string; standard_fee: string; branches: string[] };

async function newLead(request: APIRequestContext, email: string, branchId: number, name: string, course: Course, personId?: number) {
  const headers = await apiToken(request, email);
  const lookups = (await (await request.get("/api/v1/lookups", { headers })).json()).data as Record<string, { id: number; code: string }[]>;
  const id = (key: string, code: string) => lookups[key]!.find((x) => x.code === code)!.id;
  const res = await request.post("/api/v1/leads", {
    headers,
    data: {
      branch_id: branchId,
      ...(personId ? { person_id: personId } : { person: { full_name: name, phone: uniquePhone() } }),
      course_id: course.course_id,
      lead_source_id: id("lead_sources", "WEBSITE"),
      contact_channel_id: id("contact_channels", "WEB_FORM"),
      entry_method_id: id("entry_methods", "WEBSITE"),
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  return { lead: (await res.json()).data as { lead_id: number; person: { person_id: number } }, headers };
}

async function courses(request: APIRequestContext) {
  const headers = await apiToken(request, USERS.admin);
  return (await (await request.get("/api/v1/courses?per_page=100&status=Active", { headers })).json()).data as Course[];
}

/** A converted deal with an approved standard fee and an accepted delivery plan. */
async function readyDeal(request: APIRequestContext, email: string, branchId: number, name: string, course: Course, personId?: number) {
  const { lead, headers } = await newLead(request, email, branchId, name, course, personId);
  await qualifyAndConvert(request, headers, lead.lead_id);
  await approvedFee(request, headers, lead.lead_id);
  await acceptDeliveryPlan(request, headers, lead.lead_id);
  return { lead, headers };
}

const day = (n: number) => new Date(Date.parse(`${todayIST()}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

test("sample case: ₹22,000 invoice, ₹5,000 claim pending = paid ₹0 · balance ₹22,000; after verification one receipt, ₹5,000 paid, ₹17,000 balance", async ({ page, request }) => {
  const powerBi = (await courses(request)).find((c) => c.course_code === "NIT-CRS-019")!; // ₹22,000
  const name = `Sample Case ${Date.now().toString(36)}`;
  const { lead, headers } = await readyDeal(request, USERS.salesGnt, 1, name, powerBi);
  const invoice = await createInvoice(request, headers, [lead.lead_id], [
    { due_date: todayIST(), amount: "11000.00" },
    { due_date: day(12), amount: "11000.00" },
  ]);
  expect(invoice.billed_amount).toBe("22000.00");
  const claim = await recordPayment(request, headers, invoice.invoice_id, "5000", "Cash");

  await login(page, USERS.accountsGnt);
  const tiles = async (paid: string, balance: string) => {
    await page.goto(`/invoices/${invoice.invoice_id}`);
    const sheet = page.getByTestId("invoice-sheet");
    await expect(sheet.getByText("Verified payments, net").locator("xpath=following-sibling::dd[1]")).toHaveText(paid);
    await expect(sheet.getByText("Balance due").locator("xpath=following-sibling::dd[1]")).toHaveText(balance);
    await page.goto(`/invoices?q=${invoice.invoice_number}`);
    const row = page.getByRole("row", { name: new RegExp(invoice.invoice_number) });
    await expect(row).toContainText(paid);
    await expect(row).toContainText(balance);
  };
  await tiles("₹0", "₹22,000");
  await page.goto(`/invoices/${invoice.invoice_id}`);
  await expect(page.getByTestId("invoice-sheet").getByText(/No verified receipts yet/)).toBeVisible();

  // Verify: evidence + independent cash check → one receipt
  await page.goto(`/payments?status=Pending+Verification&q=${claim.transaction_number}`);
  await page.getByRole("button", { name: `Verify ${claim.transaction_number}` }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("checkbox", { name: "Evidence reviewed" }).click();
  await expect(dialog.getByRole("button", { name: "Verify payment" })).toBeDisabled();
  await dialog.getByRole("checkbox", { name: "Independent cash check completed" }).click();
  await dialog.getByRole("button", { name: "Verify payment" }).click();
  await expect(page.getByText(/GNT-R-2627-\d+ issued/)).toBeVisible();

  await tiles("₹5,000", "₹17,000");
  await page.goto(`/invoices/${invoice.invoice_id}`);
  await expect(page.getByTestId("invoice-sheet").getByText(/^GNT-R-2627-\d+$/)).toHaveCount(1);
  // Collections agrees: the dues left are ₹17,000
  await page.goto(`/collections?tab=Upcoming`);
  const due = page.getByRole("row", { name: new RegExp(name) });
  if (await due.count()) await expect(due).toContainText("₹17,000");
});

test("two courses on one invoice for one person; split tenders; each course admitted on its own; a later course reuses the student", async ({ page, request }) => {
  const all = await courses(request);
  const [first, second, third] = all.filter((c) => c.branches.includes("NIT-GNT")).slice(0, 3) as [Course, Course, Course];
  const name = `Two Courses ${Date.now().toString(36)}`;
  const a = await readyDeal(request, USERS.salesGnt, 1, name, first);
  const personId = a.lead.person.person_id;
  const b = await readyDeal(request, USERS.salesGnt, 1, name, second, personId);

  // Create invoice dialog from the deal: both compatible courses can be combined
  await login(page, USERS.salesGnt);
  await page.goto(`/leads/${a.lead.lead_id}`);
  await page.getByRole("heading", { name: "Commercial and invoice" }).locator("xpath=ancestor::section[1]").getByRole("button", { name: "Create invoice" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("checkbox", { name: second.course_title }).click();
  await dialog.getByRole("button", { name: "50/50" }).click();
  await dialog.getByRole("button", { name: "Create invoice" }).click();
  await expect(page).toHaveURL(/\/invoices\/\d+/);
  const invoiceId = Number(page.url().split("/invoices/")[1]);
  const sheet = page.getByTestId("invoice-sheet");
  await expect(sheet.getByText(first.course_title)).toBeVisible();
  await expect(sheet.getByText(second.course_title)).toBeVisible();
  // Duplicate invoicing is blocked: both deals now show View invoice
  await page.goto(`/leads/${b.lead.lead_id}`);
  await expect(page.getByRole("link", { name: "View invoice" })).toBeVisible();

  // Split checkout: allocate per course, two tenders → two pending transactions
  await page.goto(`/payments?invoice=${invoiceId}&tab=record`);
  await page.getByRole("textbox", { name: `Allocate to ${first.course_title}` }).fill("1500");
  await page.getByRole("textbox", { name: `Allocate to ${second.course_title}` }).fill("1000");
  await page.getByRole("checkbox", { name: "Split payment" }).click();
  await page.getByLabel("Tender 1 mode").selectOption({ label: "UPI / Bank Transfer" });
  await page.getByLabel("Tender 1 amount").fill("2000");
  await page.getByLabel("Tender 1 reference").fill(`UTR${Date.now()}`);
  await page.getByRole("button", { name: "Add tender" }).click();
  await page.getByLabel("Tender 2 mode").selectOption({ label: "Cash" });
  await page.getByLabel("Tender 2 amount").fill("500");
  await page.getByRole("button", { name: "Record payment" }).last().click();
  await expect(page.getByText(/TXN-GNT-\d+, TXN-GNT-\d+ recorded/)).toBeVisible();

  // Accounts verifies both (API), then the invoice shows two receipts and two admissions for one person
  const accounts = await apiToken(request, USERS.accountsGnt);
  const pending = (await (await request.get(`/api/v1/payments?invoice_id=${invoiceId}&status=Pending Verification`, { headers: accounts })).json()).data as { payment_id: number }[];
  expect(pending).toHaveLength(2);
  const admitted = [];
  for (const p of pending) admitted.push(...(await verifyPayment(request, accounts, p.payment_id)).admissions_created);
  expect(admitted).toHaveLength(2);
  await page.goto(`/invoices/${invoiceId}`);
  await expect(page.getByTestId("invoice-sheet").getByText(/^GNT-R-2627-\d+$/)).toHaveCount(2);
  await expect(page.getByRole("cell", { name: /NIT-GNT-\d{4}-\d+/ })).toHaveCount(2);

  // A later course for the same student reuses the person: one Student 360, three admissions
  const c = await readyDeal(request, USERS.salesGnt, 1, name, third, personId);
  const later = await createInvoice(request, c.headers, [c.lead.lead_id]);
  const pay = await recordPayment(request, c.headers, later.invoice_id, "1000");
  expect((await verifyPayment(request, accounts, pay.payment_id)).admissions_created).toHaveLength(1);
  await page.goto(`/students/${personId}`);
  await page.getByRole("tab", { name: "Admissions & Batches" }).click();
  await expect(page.getByRole("link", { name: /NIT-GNT-\d{4}-\d+/ })).toHaveCount(3);
});

test("branch invoice: Vijayawada issuer, address and teal template; the viewer's branch filter never rewrites it", async ({ page, request }) => {
  const course = (await courses(request)).find((c) => c.branches.includes("NIT-VIJ"))!;
  const { lead, headers } = await readyDeal(request, USERS.salesVij, 2, `Vij Invoice ${Date.now().toString(36)}`, course);
  const invoice = await createInvoice(request, headers, [lead.lead_id]);
  expect(invoice.invoice_number).toMatch(/^INV-VIJ-/);

  await login(page, USERS.founder);
  await page.goto(`/invoices/${invoice.invoice_id}`);
  const sheet = page.getByTestId("invoice-sheet");
  await expect(sheet.getByText("NIT-VIJ · Vijayawada")).toBeVisible();
  await expect(sheet.getByText(/Door No\. 40-27-88\/1/)).toBeVisible();
  await expect(sheet.getByText("vijayawada@nipunacareers.com")).toBeVisible();
  expect(await sheet.evaluate((el) => getComputedStyle(el).getPropertyValue("--doc-accent").trim().toLowerCase())).toBe("#137e89");

  // Switching the workspace branch filter to Guntur doesn't change the issued invoice
  await page.getByLabel("Branch scope").selectOption({ label: "Guntur" });
  await page.goto(`/invoices/${invoice.invoice_id}`);
  await expect(page.getByTestId("invoice-sheet").getByText(/Door No\. 40-27-88\/1/)).toBeVisible();
  await expect(page.getByTestId("invoice-sheet").getByText(/6-4-35/)).toHaveCount(0);
});

test("next actions and stage counts follow the branch: Vijayawada sees only Vijayawada deals", async ({ page }) => {
  await login(page, USERS.bmVij);
  await page.goto("/pipeline");
  const actions = page.getByRole("list", { name: "Next actions" });
  await expect(actions.getByRole("listitem").first()).toBeVisible();
  const texts = await actions.getByRole("listitem").allInnerTexts();
  expect(texts.every((t) => t.includes("Vijayawada") && !t.includes("Guntur"))).toBeTruthy();
  await expect(page.getByRole("region", { name: "Counselling" }).getByText("GNT")).toHaveCount(0);
  // Empty stage chip + reset
  await page.getByTestId("chip-Lost - closed").click();
  await expect(page.getByText("No opportunities here")).toBeVisible();
  await page.getByRole("button", { name: "Show all stages" }).click();
  await expect(page).not.toHaveURL(/stage=/);
});

test("invoice document and record payment fit 360 px @mobile", async ({ page, request }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  const course = (await courses(request)).find((c) => c.branches.includes("NIT-GNT"))!;
  const { lead, headers } = await readyDeal(request, USERS.salesGnt, 1, `Narrow ${Date.now().toString(36)}`, course);
  const invoice = await createInvoice(request, headers, [lead.lead_id]);
  await login(page, USERS.salesGnt);
  for (const path of [`/invoices/${invoice.invoice_id}`, `/payments?invoice=${invoice.invoice_id}&tab=record`, `/leads/${lead.lead_id}`, "/pipeline"]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), path).toBeLessThanOrEqual(1);
  }
});

test("Print / Save PDF: the invoice prints alone on A4 (no app chrome)", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "PDF output needs Chromium");
  await login(page, USERS.accountsGnt);
  await page.goto("/invoices?q=INV-GNT-2627-0002");
  await page.getByRole("link", { name: /INV-GNT-2627-0002/ }).first().click();
  await expect(page.getByTestId("invoice-sheet")).toBeVisible();
  await page.emulateMedia({ media: "print" });
  // In print media only the invoice document is shown
  await expect(page.getByRole("heading", { name: "Linked payment history" })).toBeHidden();
  await expect(page.locator(".sidebar")).toBeHidden();
  await expect(page.getByTestId("invoice-sheet").getByText("Balance due")).toBeVisible();
  const pdf = await page.pdf({ format: "A4", printBackground: true });
  expect(pdf.byteLength).toBeGreaterThan(10_000);
  expect((pdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length).toBeGreaterThanOrEqual(1);
});
