import { expect, request as pwRequest, test, type APIRequestContext, type Page } from "@playwright/test";
import { PASSWORD, USERS, login, qualifyAndConvert, uniquePhone } from "./helpers";

const SHOTS = "/private/tmp/claude-501/-Users-manojtungala-nipuna-crm/3aa0633b-0a9a-4dca-89e8-f5788c3e5648/scratchpad/shots";
const BASE = process.env["E2E_BASE_URL"] ?? "http://localhost:5173";
const COORD_VIJ = "coordinator.vij@nipuna.test";
const AWS = { id: 4, label: "AWS with DevOps (NIT-CRS-007)" };

// ---------------------------------------------------------------- API helpers (seed data for UI tests)

type Api = { ctx: APIRequestContext; headers: Record<string, string>; call: <T = Record<string, unknown>>(method: string, path: string, body?: unknown) => Promise<T> };

async function api(email: string): Promise<Api> {
  const ctx = await pwRequest.newContext({ baseURL: BASE });
  const res = await ctx.post("/api/v1/auth/login", { data: { email, password: PASSWORD } });
  expect(res.ok(), await res.text()).toBeTruthy();
  const token = (await res.json()).data.token as string;
  const call = async <T,>(method: string, path: string, body?: unknown): Promise<T> => {
    const r = await ctx.fetch(`/api/v1${path}`, { method, headers: { Authorization: `Bearer ${token}` }, ...(body !== undefined ? { data: body } : {}) });
    const text = await r.text();
    expect(r.ok(), `${method} ${path}: ${text}`).toBeTruthy();
    return (text ? JSON.parse(text).data : null) as T;
  };
  return { ctx, call, headers: { Authorization: `Bearer ${token}` } };
}

type Lookup = { id: number; code: string };

/** Lead → qualify & convert → fee version → approve → delivery plan → invoice → payment → verified (as accounts.gnt),
 *  which creates the admission (the ₹1,000 token is reached). */
async function paidInvoice(name: string, courseId = AWS.id) {
  const sales = await api(USERS.salesGnt);
  const accounts = await api(USERS.accountsGnt);
  const lk = await sales.call<Record<string, Lookup[]>>("GET", "/lookups");
  const id = (list: string, code: string) => lk[list]!.find((x) => x.code === code)!.id;
  const lead = await sales.call<{ lead_id: number; person: { person_id: number } }>("POST", "/leads", {
    branch_id: 1,
    person: { full_name: name, phone: uniquePhone() },
    course_id: courseId,
    lead_source_id: id("lead_sources", "GOOGLE_ADS"),
    contact_channel_id: id("contact_channels", "WEB_FORM"),
    entry_method_id: id("entry_methods", "GOOGLE_ADS_FORM"),
  });
  await qualifyAndConvert(sales.ctx, sales.headers, lead.lead_id);
  const discussion = await sales.call<{ fee_discussion_id: number }>("POST", `/leads/${lead.lead_id}/fee-discussions`, {});
  const version = await sales.call<{ version_id: number }>("POST", `/fee-discussions/${discussion.fee_discussion_id}/versions`, {});
  await sales.call("POST", `/fee-discussion-versions/${version.version_id}/approve`);
  await sales.call("POST", `/leads/${lead.lead_id}/delivery-plan/accept`, { delivery_mode: "Classroom", seat_type: "Confirmed Seat", capacity_review: "Checked", student_accepted: true });
  const invoice = await sales.call<{ invoice_id: number; invoice_number: string; billed_amount: string }>("POST", "/invoices", { lead_ids: [lead.lead_id] });
  const payment = await sales.call<{ payment: { payment_id: number } }>("POST", "/payments", {
    invoice_id: invoice.invoice_id,
    amount: invoice.billed_amount,
    payment_mode_id: id("payment_modes", "UPI_BANK"),
    reference: `UTR${Date.now()}`,
  });
  const verified = await accounts.call<{ admissions_created: { admission_id: number; admission_code: string }[] }>(
    "POST", `/payments/${payment.payment.payment_id}/verify`, { evidence_reviewed: true });
  await sales.ctx.dispose();
  await accounts.ctx.dispose();
  return { lead, invoice, personId: lead.person.person_id, admission: verified.admissions_created[0]! };
}

async function confirmFreshAuth(page: Page) {
  const dialog = page.getByRole("dialog", { name: "Confirm your password" });
  if (await dialog.isVisible().catch(() => false)) {
    await dialog.getByLabel("Password").fill(PASSWORD);
    await dialog.getByRole("button", { name: "Continue" }).click();
  }
}

async function shot(page: Page, name: string) {
  await page.screenshot({ path: `${SHOTS}/academics-${name}.png`, fullPage: true });
}

async function logout(page: Page) {
  await page.evaluate(() => window.sessionStorage.clear());
}

// ---------------------------------------------------------------- tests

test("@mobile admissions list shows own-branch admissions and the detail panel", async ({ page }, info) => {
  await login(page, USERS.bmGnt);
  await page.goto("/admissions");
  await expect(page.getByRole("heading", { name: "Admissions" })).toBeVisible();
  await expect(page.getByRole("link", { name: /Rohit Kumar/ }).first()).toBeVisible();
  await expect(page.getByRole("link", { name: /Divya Sree/ }).first()).toBeVisible();
  await expect(page.getByText("Charan Teja")).toHaveCount(0); // Vijayawada
  await shot(page, `admissions-${info.project.name}`);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);

  await page.getByRole("button", { name: /NIT-GNT-2026-000001/ }).click();
  const sheet = page.getByRole("dialog", { name: "Admission detail" });
  await expect(sheet.getByText("Java Full Stack Developer (NIT-CRS-047)")).toBeVisible();
  await expect(sheet.getByRole("link", { name: "GNT-B-0001" })).toBeVisible();
  await expect(sheet.getByText("v2026.1").first()).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Transfer" })).toBeVisible(); // branch manager
  await shot(page, `admission-detail-${info.project.name}`);
});

test("@mobile students list and Student 360 tabs load real data", async ({ page }, info) => {
  await login(page, USERS.bmGnt);
  await page.goto("/students");
  await expect(page.getByRole("heading", { name: "Students" })).toBeVisible();
  await shot(page, `students-${info.project.name}`);
  await page.getByRole("link", { name: /Divya Sree/ }).first().click();
  await expect(page.getByRole("heading", { name: "Divya Sree" })).toBeVisible();
  await expect(page.getByText("PER-GNT-00005").first()).toBeVisible();
  await page.getByRole("tab", { name: "Admissions & Batches" }).click();
  await expect(page.getByRole("link", { name: "NIT-GNT-2026-000002" })).toBeVisible();
  await expect(page.getByRole("link", { name: "GNT-B-0002" })).toBeVisible();
  await page.getByRole("tab", { name: "Finance" }).click();
  await expect(page.getByRole("link", { name: "INV-GNT-2627-0002" })).toBeVisible();
  await page.getByRole("tab", { name: "Timeline" }).click();
  await expect(page.getByText(/Payment GNT-R-/).first()).toBeVisible();
  await page.getByRole("tab", { name: "Audit" }).click();
  await expect(page.getByText("ADMISSION CREATED").first()).toBeVisible();
  await shot(page, `student360-${info.project.name}`);
});

test("person without an admission opens from Lead 360 with basics and opportunities", async ({ page }) => {
  const sales = await api(USERS.salesGnt);
  const lk = await sales.call<Record<string, Lookup[]>>("GET", "/lookups");
  const id = (list: string, code: string) => lk[list]!.find((x) => x.code === code)!.id;
  const lead = await sales.call<{ lead_id: number; lead_code: string; person: { person_id: number } }>("POST", "/leads", {
    branch_id: 1,
    person: { full_name: "Prospect NoAdmission", phone: uniquePhone() },
    course_id: AWS.id,
    lead_source_id: id("lead_sources", "WALK_IN"),
    contact_channel_id: id("contact_channels", "IN_PERSON"),
    entry_method_id: id("entry_methods", "WALK_IN_DESK"),
  });
  await sales.ctx.dispose();
  await login(page, USERS.salesGnt);
  await page.goto(`/leads/${lead.lead_id}`);
  await page.getByRole("link", { name: "Open person" }).click(); // Person 360
  await expect(page.getByRole("heading", { name: "Prospect NoAdmission" })).toBeVisible();
  await expect(page.getByRole("link", { name: lead.lead_code })).toBeVisible();
  await page.goto(`/students/${lead.person.person_id}`);
  await expect(page.getByRole("heading", { name: "Prospect NoAdmission" })).toBeVisible();
  await expect(page.getByText("no admission yet")).toBeVisible();
  await expect(page.getByRole("link", { name: lead.lead_code })).toBeVisible();
});

test("course master: admin creates a course, sets branches, adds and publishes a curriculum; others are read-only", async ({ page }) => {
  test.setTimeout(90_000);
  const code = `NIT-E2E-${String(Date.now()).slice(-6)}`;
  await login(page, USERS.admin);
  await page.goto("/course-master");
  await expect(page.getByText("AWS with DevOps").first()).toBeVisible();
  await expect(page.getByText("Full Payment")).toBeVisible(); // payment plans
  await page.getByRole("button", { name: "New course" }).click();
  let dialog = page.getByRole("dialog", { name: "New course" });
  await dialog.getByLabel("Course code").fill(code);
  await dialog.getByLabel("Course title").fill(`E2E Course ${code}`);
  await dialog.getByLabel("Category").fill("E2E");
  await dialog.getByLabel("Standard fee (₹)").fill("12000");
  await dialog.getByLabel("Guntur").check();
  await dialog.getByRole("button", { name: "Create course" }).click();
  await expect(page.getByText(`${code} created`)).toBeVisible();

  await page.getByLabel("Search courses").fill(code);
  await page.getByLabel("Search courses").press("Enter");
  const row = page.getByRole("row", { name: new RegExp(code) });
  await expect(row).toContainText("NIT-GNT");
  await row.getByRole("button", { name: /Branches/ }).click();
  dialog = page.getByRole("dialog", { name: new RegExp(`Branch availability`) });
  await dialog.getByLabel(/Vijayawada/).check();
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(row).toContainText("NIT-GNT · NIT-VIJ");
  await row.getByRole("button", { name: /Edit/ }).click();
  dialog = page.getByRole("dialog", { name: `Edit ${code}` });
  await dialog.getByLabel("Standard fee (₹)").fill("12500");
  await dialog.getByRole("button", { name: "Save course" }).click();
  await expect(row).toContainText("₹12,500");
  await shot(page, "course-master");

  // Curriculum for the new course (Batch Workspace), as the Guntur coordinator
  await logout(page);
  await login(page, USERS.coordGnt);
  await page.goto("/batches");
  await page.getByRole("button", { name: "New version" }).click();
  dialog = page.getByRole("dialog", { name: "New curriculum version" });
  await dialog.getByLabel("Course").selectOption({ label: `E2E Course ${code} (${code})` });
  await dialog.getByLabel("Version label").fill("v1");
  await dialog.getByRole("button", { name: "Create version" }).click();
  await expect(page.getByText("Curriculum v1 created")).toBeVisible();
  await page.getByLabel("Filter by course").selectOption({ label: `E2E Course ${code} (${code})` });
  const cvRow = page.getByRole("row", { name: /v1/ });
  await expect(cvRow).toContainText("Draft");
  await cvRow.getByRole("button", { name: "Publish" }).click();
  await page.getByRole("dialog", { name: "Publish v1?" }).getByRole("button", { name: "Publish" }).click();
  await expect(cvRow).toContainText("Published");

  // Read-only for a trainer
  await logout(page);
  await login(page, USERS.trainerG1);
  await page.goto("/course-master");
  await expect(page.getByText("read-only")).toBeVisible();
  await expect(page.getByRole("button", { name: "New course" })).toHaveCount(0);

  // Tidy up: retire the test course
  await logout(page);
  await login(page, USERS.admin);
  await page.goto(`/course-master?q=${code}`);
  await page.getByRole("row", { name: new RegExp(code) }).getByRole("button", { name: /Edit/ }).click();
  dialog = page.getByRole("dialog", { name: `Edit ${code}` });
  await dialog.getByLabel("Course status").selectOption("Inactive");
  await dialog.getByRole("button", { name: "Save course" }).click();
  await expect(page.getByRole("row", { name: new RegExp(code) })).toContainText("Inactive");
});

test("admission lifecycle: create from a paid invoice, map, batch, allocate, join, documents, certificate, fee change, case", async ({ page }) => {
  test.setTimeout(180_000);
  const name = `E2E Learner ${String(Date.now()).slice(-6)}`;
  const flow = await paidInvoice(name);

  // 1. Verification created the admission; the eligibility review no longer lists the course
  const { invoice, personId, admission } = flow;
  await login(page, USERS.salesGnt);
  await page.goto(`/admissions/new?invoiceId=${invoice.invoice_id}`);
  await expect(page.getByRole("heading", { name: "Admission eligibility" })).toBeVisible();
  await expect(page.getByText("Every invoiced course is admitted")).toBeVisible();
  await shot(page, "new-admission");
  const code = admission.admission_code;
  await page.goto(`/admissions?q=${encodeURIComponent(code)}`);
  await expect(page.getByText("Awaiting Batch Allocation").first()).toBeVisible();

  // 2. Counsellor uploads an identity document and requests a fee change
  await page.goto(`/students/${personId}`);
  await expect(page.getByRole("heading", { name })).toBeVisible();
  await page.getByRole("tab", { name: "Documents" }).click();
  await page.getByRole("button", { name: "Upload document" }).click();
  let dialog = page.getByRole("dialog", { name: "Upload document" });
  await dialog.getByLabel("Document type").selectOption({ label: "Identity proof" });
  await dialog.getByLabel("File").setInputFiles({ name: "aadhaar.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n%e2e\n") });
  await dialog.getByRole("button", { name: "Upload" }).click();
  await expect(page.getByText("Document uploaded — review required")).toBeVisible();
  await expect(page.getByText("Another reviewer must verify")).toBeVisible();

  await page.goto(`/admissions?q=${encodeURIComponent(code)}`);
  await page.getByRole("button", { name: new RegExp(code) }).click();
  let sheet = page.getByRole("dialog", { name: "Admission detail" });
  await sheet.getByRole("button", { name: "Request fee change" }).click();
  dialog = page.getByRole("dialog", { name: "Request fee change" });
  await dialog.getByLabel("New final fee (₹)").fill("23000");
  await dialog.getByLabel("Reason for fee change").fill("Added internship module");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(sheet.getByRole("row", { name: /internship module/ })).toContainText("Pending");

  // 3. Admin approves the fee change
  await logout(page);
  await login(page, USERS.admin);
  await page.goto(`/admissions?q=${encodeURIComponent(code)}`);
  await page.getByRole("button", { name: new RegExp(code) }).click();
  sheet = page.getByRole("dialog", { name: "Admission detail" });
  await sheet.getByRole("button", { name: "Approve" }).click();
  await page.getByRole("dialog", { name: "Approve fee change?" }).getByRole("button", { name: "Approve" }).click();
  await confirmFreshAuth(page);
  await expect(sheet.getByRole("row", { name: /internship module/ })).toContainText("Approved");

  // 4. Accounts applies it
  await logout(page);
  await login(page, USERS.accountsGnt);
  await page.goto(`/admissions?q=${encodeURIComponent(code)}`);
  await page.getByRole("button", { name: new RegExp(code) }).click();
  sheet = page.getByRole("dialog", { name: "Admission detail" });
  await sheet.getByRole("button", { name: "Apply" }).click();
  await page.getByRole("dialog", { name: "Apply approved fee change?" }).getByRole("button", { name: "Apply" }).click();
  await confirmFreshAuth(page);
  await expect(sheet.getByRole("row", { name: /internship module/ })).toContainText("Applied");
  await expect(sheet.getByText("₹23,000").first()).toBeVisible();

  // 5. Coordinator: verify document, create a batch starting today, map curriculum, allocate, record joining
  await logout(page);
  await login(page, USERS.coordGnt);
  await page.goto(`/students/${personId}`);
  await page.getByRole("tab", { name: "Documents" }).click();
  await page.getByRole("button", { name: "Verify" }).click();
  await page.getByRole("dialog", { name: /Verify Identity proof/ }).getByRole("button", { name: "Verify" }).click();
  await expect(page.getByText("Document verified")).toBeVisible();

  await page.goto("/batches");
  await expect(page.getByRole("heading", { name: "Batch Workspace" })).toBeVisible();
  await expect(page.getByRole("link", { name: /GNT-B-0001/ })).toBeVisible();
  await expect(page.getByRole("row", { name: new RegExp(code) })).toBeVisible(); // awaiting allocation
  await shot(page, "batches");
  await page.getByRole("button", { name: "New batch" }).click();
  dialog = page.getByRole("dialog", { name: "New batch" });
  const batchName = `E2E AWS ${String(Date.now()).slice(-5)}`;
  await dialog.getByLabel("Batch name").fill(batchName);
  await dialog.getByLabel("Course", { exact: true }).selectOption({ label: AWS.label });
  const today = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
  await dialog.getByLabel("Start date").fill(today);
  await dialog.getByLabel("Start time").fill("18:00");
  await dialog.getByLabel("End time").fill("20:00");
  await dialog.getByLabel("Trainer").selectOption({ label: "Trainer G1" });
  await dialog.getByLabel("Capacity").fill("5");
  await dialog.getByRole("button", { name: "Create batch" }).click();
  await expect(page.getByRole("heading", { name: new RegExp(batchName) })).toBeVisible();
  await expect(page.getByText("0/5 · 5 seats left")).toBeVisible();
  await expect(page.getByText("v2026.1")).toBeVisible(); // course's published curriculum
  const batchUrl = page.url();

  await page.getByRole("button", { name: "Open for allocation" }).click();
  await page.getByRole("dialog", { name: "Open for allocation?" }).getByRole("button", { name: "Open for allocation" }).click();
  await expect(page.getByText(/is now Open/)).toBeVisible();

  // Pre-check blocks until the curriculum is mapped
  const firstPick = page.getByLabel("Admission to allocate");
  await firstPick.selectOption((await firstPick.locator("option", { hasText: code }).getAttribute("value"))!);
  await expect(page.getByRole("status").filter({ hasText: "Curriculum Mapping Pending" })).toBeVisible();

  await page.goto(`/admissions?q=${encodeURIComponent(code)}`);
  await page.getByRole("button", { name: new RegExp(code) }).click();
  sheet = page.getByRole("dialog", { name: "Admission detail" });
  await sheet.getByLabel("Published curriculum version").selectOption({ label: "AWS with DevOps · v2026.1" });
  await sheet.getByRole("button", { name: "Map curriculum" }).click();
  await expect(sheet.getByText("Curriculum Mapped")).toBeVisible();

  await page.goto(batchUrl);
  const pick = page.getByLabel("Admission to allocate");
  await pick.selectOption((await pick.locator("option", { hasText: code }).getAttribute("value"))!);
  await expect(page.getByRole("status").filter({ hasText: "All checks passed" })).toBeVisible();
  await page.getByRole("button", { name: "Allocate" }).click();
  await expect(page.getByText(/First regular attendance still pending/)).toBeVisible();
  const member = page.getByRole("row", { name: new RegExp(code) });
  await expect(member).toContainText(name);
  await expect(page.getByText("1/5 · 4 seats left")).toBeVisible();
  await member.getByRole("button", { name: "Record first attendance" }).click();
  await page.getByRole("dialog", { name: /Record first attendance/ }).getByRole("button", { name: "Record joining" }).click();
  await expect(member).not.toContainText("Not yet recorded");
  await shot(page, "batch-detail");

  // 6. Certificates and completion
  await page.goto(`/students/${personId}`);
  await page.getByRole("tab", { name: "Certificates" }).click();
  await page.getByRole("button", { name: "Certificate" }).click();
  dialog = page.getByRole("dialog", { name: "Start certificate record" });
  await dialog.getByLabel("Eligibility", { exact: true }).selectOption("Eligible");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Certificate record created")).toBeVisible();
  await page.getByRole("button", { name: "Issue" }).click();
  await page.getByRole("dialog", { name: "Issue certificate?" }).getByRole("button", { name: "Issue" }).click();
  await expect(page.getByRole("row", { name: /AWS with DevOps/ }).getByText("Issued")).toBeVisible();

  await page.goto(`/admissions?q=${encodeURIComponent(code)}`);
  await page.getByRole("button", { name: new RegExp(code) }).click();
  sheet = page.getByRole("dialog", { name: "Admission detail" });
  await expect(sheet.getByText("In Progress").first()).toBeVisible();
  await sheet.getByRole("button", { name: "Complete" }).click();
  await page.getByRole("dialog", { name: "Authorise academic completion?" }).getByRole("button", { name: "Authorise completion" }).click();
  await expect(sheet.getByText("Completed").first()).toBeVisible();
  await expect(sheet.getByText(/support until/)).toBeVisible();

  // 7. Support case on Student 360
  await page.goto(`/students/${personId}`);
  await page.getByRole("tab", { name: "Support cases" }).click();
  await page.getByRole("button", { name: "Support case" }).click();
  dialog = page.getByRole("dialog", { name: "Open support case" });
  await dialog.getByLabel("Case type").selectOption({ label: "Certificate" });
  await dialog.getByLabel("Subject").fill("Needs a printed copy");
  await dialog.getByRole("button", { name: "Open case" }).click();
  const caseRow = page.getByRole("row", { name: /Needs a printed copy/ });
  await expect(caseRow).toContainText("Open");
  await caseRow.getByRole("button", { name: "Update" }).click();
  dialog = page.getByRole("dialog", { name: /Update SUP-/ });
  await dialog.getByLabel("Case status").selectOption("Resolved");
  await dialog.getByLabel("Resolution notes").fill("Printed copy handed over");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(caseRow).toContainText("Resolved");
  await shot(page, "student360-new");
});

test("branch manager cancels an admission with a reason; coordinator can't cancel or create", async ({ page }) => {
  test.setTimeout(90_000);
  const { admission } = await paidInvoice(`E2E Cancel ${String(Date.now()).slice(-6)}`);

  await login(page, USERS.coordGnt);
  await page.goto(`/admissions?admission=${admission.admission_id}`);
  let sheet = page.getByRole("dialog", { name: "Admission detail" });
  await expect(sheet.getByText(admission.admission_code).first()).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Cancel admission" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Create Admission" })).toHaveCount(0); // the eligibility review is for sales / accounts

  await logout(page);
  await login(page, USERS.bmGnt);
  await page.goto(`/admissions?admission=${admission.admission_id}`);
  sheet = page.getByRole("dialog", { name: "Admission detail" });
  await sheet.getByRole("button", { name: "Cancel admission" }).click();
  const dialog = page.getByRole("dialog", { name: `Cancel ${admission.admission_code}?` });
  await dialog.getByLabel("Cancellation reason").fill("Student relocated before start");
  await dialog.getByRole("button", { name: "Cancel admission" }).click();
  await expect(sheet.getByText(/Cancelled .* Student relocated before start/)).toBeVisible();
});

test("Vijayawada coordinator sees only Vijayawada batches; sales can't open batches", async ({ page }) => {
  await login(page, COORD_VIJ);
  await page.goto("/batches");
  await expect(page.getByRole("heading", { name: "Batch Workspace" })).toBeVisible();
  await expect(page.getByRole("link", { name: /VIJ-B-/ }).first()).toBeVisible();
  await expect(page.getByRole("link", { name: /GNT-B-/ })).toHaveCount(0);
  await page.getByRole("link", { name: /VIJ-B-/ }).first().click();
  await expect(page.getByRole("heading", { name: "Schedule" })).toBeVisible();

  await logout(page);
  await login(page, USERS.salesGnt);
  await page.goto("/batches");
  await expect(page.getByText("You don't have access to this screen")).toBeVisible();
});
