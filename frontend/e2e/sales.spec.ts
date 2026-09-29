import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { PASSWORD, USERS, acceptDeliveryPlan, login, qualifyAndConvert, uniquePhone } from "./helpers";

const SHOTS = "/private/tmp/claude-501/-Users-manojtungala-nipuna-crm/3aa0633b-0a9a-4dca-89e8-f5788c3e5648/scratchpad/shots";

// ---------------------------------------------------------------- API helpers (test data setup only)

async function apiLogin(request: APIRequestContext, email: string) {
  const res = await request.post("/api/v1/auth/login", { data: { email, password: PASSWORD } });
  expect(res.ok()).toBeTruthy();
  const token = (await res.json()).data.token as string;
  return { Authorization: `Bearer ${token}` };
}

type Lookup = { id: number; label: string };

/** A fresh Guntur lead owned by sales.gnt, with a course unless `withCourse` is false (re-runnable: unique phone).
 *  With `deal`, it is qualified and converted (db 019: demos and fees happen on deals). */
async function createLead(request: APIRequestContext, name: string, withCourse = true, deal = false) {
  const headers = await apiLogin(request, USERS.salesGnt);
  const lookups = (await (await request.get("/api/v1/lookups", { headers })).json()).data as Record<string, Lookup[]>;
  const courses = (await (await request.get("/api/v1/courses?per_page=100&status=Active", { headers })).json()).data as {
    course_id: number;
    course_code: string;
    standard_fee: string;
    branches: string[];
  }[];
  const course = courses.find((c) => c.branches.includes("NIT-GNT") && Number(c.standard_fee) >= 10000)!;
  const pick = (key: string, label: string) => lookups[key]!.find((l) => l.label === label)!.id;
  const phone = uniquePhone();
  const res = await request.post("/api/v1/leads", {
    headers,
    data: {
      branch_id: 1,
      person: { full_name: name, phone },
      course_id: withCourse ? course.course_id : null,
      lead_source_id: pick("lead_sources", "Walk-in"),
      contact_channel_id: pick("contact_channels", "In person"),
      entry_method_id: pick("entry_methods", "Walk-in desk"),
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const lead = (await res.json()).data as { lead_id: number; name: string };
  if (deal) await qualifyAndConvert(request, headers, lead.lead_id);
  return { ...lead, phone, headers };
}

const createDeal = (request: APIRequestContext, name: string) => createLead(request, name, true, true);

async function scheduleDemo(request: APIRequestContext, headers: Record<string, string>, leadId: number, inSeconds: number) {
  const at = new Date(Date.now() + inSeconds * 1000).toISOString();
  const res = await request.post(`/api/v1/leads/${leadId}/demos`, { headers, data: { scheduled_at: at, trainer_user_id: 8, duration_minutes: 45 } });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()).data as { demo_id: number; demo_code: string };
}

async function logout(page: Page) {
  await page.evaluate(() => window.sessionStorage.clear());
}

// ---------------------------------------------------------------- Counsellor workspace

test("counsellor workspace shows queue counts, rows and AI next best action @mobile", async ({ page }) => {
  await login(page, USERS.salesGnt);
  await page.goto("/counsellor");
  await expect(page.getByRole("heading", { name: "Counsellor Workspace" })).toBeVisible();
  const demosTab = page.getByRole("tab", { name: /^Demos/ });
  await expect(demosTab).not.toContainText("…");
  await demosTab.click();
  await expect(page).toHaveURL(/queue=demos/);
  await expect(page.locator("a:visible", { hasText: "Ananya Rao" }).first()).toBeVisible();
  await expect(page.getByText("Karthik Reddy")).toHaveCount(0); // Vijayawada lead
  await page.screenshot({ path: `${SHOTS}/sales-counsellor-${test.info().project.name}.png`, fullPage: true });

  await page.getByRole("button", { name: "Suggest next best actions" }).click();
  await expect(page.getByRole("button", { name: "Refresh suggestions" })).toBeVisible({ timeout: 30_000 });
});

test("branch manager sees branch-wide queue counts", async ({ page }) => {
  await login(page, USERS.bmGnt);
  await page.goto("/counsellor?queue=new&q=Bhavana");
  await expect(page.getByRole("tab", { name: /^New/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("Bhavana Sri").first()).toBeVisible(); // unassigned GNT lead: not in anyone's own queue
});

// ---------------------------------------------------------------- Pipeline

test("a lead is qualified and converted to a deal, then moves on the pipeline, is managed and marked lost @mobile", async ({ page, request }) => {
  test.setTimeout(90_000);
  const lead = await createLead(request, `Pipeline Mover ${Date.now().toString(36)}`);
  await login(page, USERS.salesGnt);

  // New enquiries are Active leads, not pipeline cards
  await page.goto(`/leads?q=${lead.phone}`);
  await expect(page.locator("a:visible", { hasText: lead.name }).first()).toBeVisible();
  await page.goto(`/pipeline?q=${lead.phone}`);
  await expect(page.getByRole("article", { name: lead.name })).toHaveCount(0);

  // Lead 360: phone beside the actions; Convert stays disabled until every check is reviewed
  await page.goto(`/leads/${lead.lead_id}`);
  await expect(page.getByText("Phone number")).toBeVisible();
  await expect(page.getByRole("link", { name: "WhatsApp" })).toBeVisible();
  const convert = page.getByRole("button", { name: "Convert to deal" });
  await expect(convert).toBeDisabled();
  await expect(page.getByRole("button", { name: "Move stage" })).toHaveCount(0); // not a deal yet
  const checklist = page.getByRole("heading", { name: "Qualification checklist" }).locator("xpath=ancestor::section[1]");
  const markQualified = checklist.getByRole("button", { name: "Mark Qualified" });
  for (const [n, check] of ["Genuine intent confirmed", "Reachable contact confirmed", "Intended course(s) understood", "Branch and delivery mode discussed", "Exact next action agreed", "Possible identity match reviewed"].entries()) {
    await expect(markQualified).toBeDisabled();
    await checklist.getByRole("checkbox", { name: check }).click();
    await expect(checklist.getByText(`${n + 1} of 6 reviewed`)).toBeVisible();
  }
  await markQualified.click();
  await expect(page.getByText("Marked qualified")).toBeVisible();
  await expect(convert).toBeEnabled();
  await page.screenshot({ path: `${SHOTS}/lead-qualified-${test.info().project.name}.png`, fullPage: true });

  await convert.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText(/creates no student, admission, receipt or LMS access/)).toBeVisible();
  await dialog.getByLabel("Expected close").fill(new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10));
  await dialog.getByRole("button", { name: "Convert lead to deal" }).click();
  await expect(page.getByText(/Converted to deal · PL-GNT-\d+/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Confirm delivery plan" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Pipeline card" })).toBeVisible();

  await page.goto(`/pipeline?q=${lead.phone}`);
  const counselling = page.getByRole("region", { name: "Counselling" });
  await expect(counselling.getByRole("article", { name: lead.name })).toBeVisible();
  await page.getByLabel(`Move ${lead.name} to stage`).selectOption("Demo Scheduled");
  await expect(page.getByText(`${lead.name} moved to Demo Scheduled`)).toBeVisible();
  await expect(page.getByRole("region", { name: "Demo" }).getByRole("article", { name: lead.name })).toBeVisible();

  // Owner & follow-up (the counsellor can move the follow-up, not the owner)
  await page.getByRole("button", { name: `Manage ${lead.name}` }).click();
  const manage = page.getByRole("dialog");
  await expect(manage.getByText("only a branch manager can change it")).toBeVisible();
  const at = new Date(Date.now() + 3 * 86400_000).toISOString().slice(0, 11) + "11:00";
  await manage.getByLabel("Next follow-up").fill(at);
  await manage.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Card updated")).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // Mark lost closes the card: it leaves the board and the lead is Lost
  await page.getByLabel(`Move ${lead.name} to stage`).selectOption("Mark lost…");
  const lost = page.getByRole("dialog");
  await lost.getByLabel("Lost reason").selectOption({ index: 1 });
  await lost.getByRole("button", { name: "Mark lost" }).click();
  await expect(page.getByText(`${lead.name} marked lost`)).toBeVisible();
  await expect(page.getByRole("article", { name: lead.name })).toHaveCount(0);
  await page.goto(`/leads?q=${lead.phone}&lead_status=Inactive`);
  await expect(page.locator(":visible", { hasText: "Lost - closed" }).first()).toBeVisible();
});

test("pipeline: seven stage chips filter the board; list view, next actions and system-set stages", async ({ page }) => {
  await login(page, USERS.salesGnt);
  await page.goto("/pipeline");
  await expect(page.getByRole("heading", { name: "Deal pipeline" })).toBeVisible();
  const chips = page.getByRole("group", { name: "Stage filter" }).getByRole("button");
  await expect(chips).toHaveCount(7);
  await expect(chips.first()).toContainText("Counselling");
  await expect(chips.last()).toContainText("Closed lost");
  await expect(page.getByRole("region", { name: "Counselling" }).getByRole("article").first()).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/sales-pipeline-${test.info().project.name}.png`, fullPage: true });
  // Payment review is never moved by hand — only marked lost
  const ppv = page.getByRole("region", { name: "Payment review" }).getByRole("article").first();
  await expect(ppv.getByText("System-set stage")).toBeVisible();
  await expect(ppv.getByRole("button", { name: "Mark lost" })).toBeVisible();

  // A chip filters the board; "Show all stages" clears it
  await page.getByTestId("chip-Admitted").click();
  await expect(page).toHaveURL(/stage=Admitted/);
  await expect(page.getByRole("region", { name: "Admitted" }).getByRole("article").first()).toBeVisible();
  await expect(page.getByRole("region", { name: "Counselling" })).toHaveCount(0);
  await page.getByRole("button", { name: "Show all stages" }).click();
  await expect(page.getByRole("region", { name: "Counselling" })).toBeVisible();

  const actions = page.getByRole("list", { name: "Next actions" });
  await expect(actions.getByRole("link", { name: "Review deal" }).first()).toBeVisible();

  await page.getByRole("button", { name: "List view" }).click();
  await expect(page).toHaveURL(/view=table/);
  await expect(page.getByRole("columnheader", { name: "Delivery plan" })).toBeVisible();
  await expect(page.getByRole("row").nth(1)).toContainText("Counselling"); // stage order
});

test("dashboard long-gap card lists the persons whose next instalment is far off", async ({ page }) => {
  await login(page, USERS.accountsVij);
  await page.goto("/dashboard?tab=performance"); // period KPIs live on the Performance tab of the V4 overview
  const card = page.getByRole("button", { name: /Long-gap plans: [1-9]/ });
  await expect(card).toBeVisible();
  await card.click();
  const dialog = page.getByRole("dialog", { name: "Long-gap plans" });
  await expect(dialog.getByRole("link", { name: /Charan Teja/ })).toBeVisible(); // seeded: ₹1,000 token, next due in 40 days
  await expect(dialog.getByText(/\d+ days/).first()).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/dashboard-long-gaps-${test.info().project.name}.png`, fullPage: true });
  await dialog.getByRole("link", { name: /Charan Teja/ }).click();
  await expect(page.getByRole("heading", { name: "Charan Teja" })).toBeVisible();
});

// ---------------------------------------------------------------- Persons

test("persons: search by name or mobile, open Person 360 @mobile", async ({ page, request }) => {
  const lead = await createLead(request, `Person Finder ${Date.now().toString(36)}`);
  await login(page, USERS.salesGnt);
  await page.goto("/persons");
  await expect(page.getByRole("heading", { name: "Persons" })).toBeVisible();
  await page.getByLabel("Search persons").fill(lead.phone.slice(-6));
  await expect(page).toHaveURL(new RegExp(`q=.*${lead.phone.slice(-6)}`));
  await expect(page.locator("a:visible", { hasText: lead.name })).toHaveCount(1);
  await page.getByLabel("Search persons").fill(lead.name.split(" ").slice(0, 2).join(" "));
  await page.locator("a:visible", { hasText: lead.name }).first().click();

  await expect(page.getByRole("heading", { name: lead.name })).toBeVisible();
  await expect(page.getByText("Not in the pipeline")).toBeVisible();
  const leads = page.getByRole("heading", { name: "Leads" }).locator("xpath=ancestor::section[1]");
  await expect(leads.getByText("Active", { exact: true })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/persons-360-${test.info().project.name}.png`, fullPage: true });
});

test("header search finds persons", async ({ page }) => {
  await login(page, USERS.bmGnt);
  await page.getByLabel("Search all persons").fill("Ananya");
  await page.getByLabel("Search all persons").press("Enter");
  await expect(page).toHaveURL(/\/persons\?q=Ananya/);
  await expect(page.locator("a:visible", { hasText: "Ananya Rao" }).first()).toBeVisible();
});

// ---------------------------------------------------------------- Demos

test("counsellor books a demo for a deal from Lead 360", async ({ page, request }) => {
  const lead = await createDeal(request, `Deal Demo ${Date.now().toString(36)}`);
  await login(page, USERS.salesGnt);
  await page.goto(`/leads/${lead.lead_id}`);
  await page.getByRole("button", { name: /Schedule demo/ }).click();
  const dialog = page.getByRole("dialog");
  const at = new Date(Date.now() + 2 * 86400_000).toISOString().slice(0, 11) + "12:00";
  await dialog.getByLabel("Demo date and time").fill(at);
  await dialog.getByRole("button", { name: "Schedule" }).click();
  await expect(page.locator("[data-sonner-toast]").getByText(/Demo DM-GNT-\d+ scheduled/)).toBeVisible();
  await page.goto("/demos");
  await expect(page.getByRole("article").filter({ hasText: lead.name }).first()).toBeVisible();
});

test("counsellor confirms, reschedules and cancels a demo with reasons; reminders load", async ({ page, request }) => {
  const name = `Demo Flow ${Date.now().toString(36)}`;
  const lead = await createDeal(request, name);
  const demo = await scheduleDemo(request, lead.headers, lead.lead_id, 3 * 86400);
  await login(page, USERS.salesGnt);
  await page.goto("/demos");
  await expect(page.getByRole("heading", { name: "Demo Management" })).toBeVisible();
  await expect(page.getByRole("article").first()).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/sales-demos.png`, fullPage: true });
  const card = page.getByRole("article", { name: `Demo ${demo.demo_code}` });
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "Reminders" }).click();
  await expect(card.getByText(/Booking confirmation/)).toBeVisible();

  await card.getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByText(`${demo.demo_code} confirmed`)).toBeVisible();
  await expect(card.getByText("Confirmed", { exact: true })).toBeVisible();

  await card.getByRole("button", { name: "Reschedule" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("New date / time (IST)").fill("2030-02-10T11:00");
  await dialog.getByLabel("Reason (required)").selectOption("Student requested");
  await dialog.getByRole("button", { name: "Confirm reschedule" }).click();
  await expect(page.getByText(new RegExp(`${demo.demo_code} rescheduled as`))).toBeVisible();

  await page.goto("/demos?from=2030-02-10&to=2030-02-10");
  const next = page.getByRole("article").filter({ hasText: name }).first();
  await expect(next).toBeVisible();
  await next.getByRole("button", { name: "Cancel" }).click();
  await dialog.getByLabel("Cancellation reason (required)").selectOption("Student not available");
  await dialog.getByRole("button", { name: "Confirm cancellation" }).click();
  await expect(page.getByText(/cancelled · pending reminders cleared/)).toBeVisible();
  await expect(next.getByText("Cancelled", { exact: true })).toBeVisible();
});

test("trainer records demo attendance and outcome; cannot change bookings", async ({ page, request }) => {
  test.setTimeout(150_000);
  const lead = await createDeal(request, "Outcome Learner");
  const demo = await scheduleDemo(request, lead.headers, lead.lead_id, 40);
  await login(page, USERS.trainerG1);
  await page.goto(`/demos?status=Scheduled`);
  const card = page.getByRole("article", { name: `Demo ${demo.demo_code}` });
  await expect(card).toBeVisible();
  await expect(card.getByRole("button", { name: "Reschedule" })).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Confirm" })).toHaveCount(0);
  const record = card.getByRole("button", { name: "Record attendance / outcome" });
  await expect(record).toBeDisabled(); // not started yet

  await page.waitForTimeout(45_000);
  await page.reload();
  await record.click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Attendance").selectOption("Attended");
  await dialog.getByLabel("Rating (1–5)").selectOption("4");
  await dialog.getByLabel("Trainer feedback").fill("Good grasp of basics");
  await dialog.getByLabel("Next follow-up (exact IST)").fill("2030-01-20T11:00");
  await dialog.getByRole("button", { name: "Save outcome" }).click();
  await expect(page.getByText(`${demo.demo_code} marked Attended · commercial follow-up task created`)).toBeVisible();
  await page.goto(`/demos?status=Attended`);
  await expect(page.getByRole("article", { name: `Demo ${demo.demo_code}` }).getByText("Interested — fee discussion")).toBeVisible();
});

// ---------------------------------------------------------------- Fee discussion → special closing → invoice

test("fee discussion with extra concession: special closing approved, delivery plan confirmed, invoice created from the deal", async ({ page, request }) => {
  test.setTimeout(90_000);
  const lead = await createDeal(request, "Fee Flow Learner");

  await login(page, USERS.salesGnt);
  await page.goto("/fee-quote");
  await expect(page.getByRole("heading", { name: "Fee Discussion & Invoice" })).toBeVisible();
  await expect(page.getByRole("row", { name: /Pavani Reddy/ })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/sales-fee-picker.png`, fullPage: true });
  await page.getByLabel("Find lead").fill(lead.phone);
  await page.getByLabel("Find lead").press("Enter");
  await page.locator("section", { hasText: "Find a lead" }).getByRole("row", { name: /Fee Flow Learner/ }).getByRole("button", { name: "Open fees" }).click();
  await expect(page).toHaveURL(new RegExp(`leadId=${lead.lead_id}`));

  await page.getByRole("button", { name: "Start fee discussion" }).click();
  await expect(page.getByText(/Fee discussion FD-\d+ started/)).toBeVisible();
  await expect(page).toHaveURL(/discussionId=/);

  await page.getByLabel("Extra concession (₹)").fill("500");
  await page.getByRole("button", { name: "Save discussion" }).click();
  await expect(page.getByText(/Version 1 saved .* needs special closing/)).toBeVisible();
  await page.getByRole("button", { name: "Request special closing" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Reason for the request").fill("Student comparing with competitor; closes today");
  await dialog.getByRole("button", { name: "Send for approval" }).click();
  await expect(page.getByText(/Special closing SCR-\d+ requested/)).toBeVisible();
  await expect(page.getByText(/is waiting for a manager's decision/)).toBeVisible();
  const discussionUrl = page.url();

  // counsellors can't reach the approvals queue
  await page.goto("/discount-approval");
  await expect(page.getByText("You don't have access to this screen")).toBeVisible();

  // branch manager approves (fresh password confirmation)
  await logout(page);
  await login(page, USERS.bmGnt);
  await page.goto("/discount-approval");
  const row = page.getByRole("row", { name: /Fee Flow Learner/ }).first();
  await expect(row).toBeVisible();
  await row.click();
  await page.screenshot({ path: `${SHOTS}/sales-discount-approval.png`, fullPage: true });
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await dialog.getByLabel("Decision reason (optional)").fill("Within BM limit");
  await dialog.getByRole("button", { name: "Approve" }).click();
  const fresh = page.getByLabel("Password");
  if (await fresh.isVisible({ timeout: 3000 }).catch(() => false)) {
    await fresh.fill(PASSWORD);
    await page.getByRole("button", { name: "Continue" }).click();
  }
  await expect(page.getByText(/SCR-\d+ approved · version approved/)).toBeVisible();

  // counsellor: share the fee, confirm the delivery plan on the deal, create the invoice
  await logout(page);
  await login(page, USERS.salesGnt);
  await page.goto(discussionUrl);
  await expect(page.getByText("Version 1 · Approved")).toBeVisible();
  await page.getByRole("button", { name: "Share approved fee" }).click();
  await expect(page.getByText("Approved fee marked as shared")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/sales-fee-quote.png`, fullPage: true });

  await page.goto(`/leads/${lead.lead_id}`);
  const plan = page.getByRole("heading", { name: "Confirm delivery plan" }).locator("xpath=ancestor::section[1]");
  await plan.getByLabel("Seat type").selectOption("Future Plan");
  await plan.getByLabel("Planned start date").fill("2030-03-01");
  await plan.getByLabel("Delivery mode").selectOption("Hybrid");
  await plan.getByLabel("Capacity review").selectOption("Checked");
  await expect(plan.getByRole("button", { name: "Confirm delivery plan" })).toBeDisabled();
  await plan.getByRole("checkbox", { name: "Student acceptance captured" }).click();
  await plan.getByRole("button", { name: "Confirm delivery plan" }).click();
  await expect(page.getByText(/DP-\d+ saved and accepted/)).toBeVisible();
  await expect(plan.getByText("Future Plan")).toBeVisible();

  const commercial = page.getByRole("heading", { name: "Commercial and invoice" }).locator("xpath=ancestor::section[1]");
  await commercial.getByRole("button", { name: "Create invoice" }).click();
  const create = page.getByRole("dialog");
  await expect(create.getByText("Door No. 6-4-35", { exact: false })).toBeVisible(); // Guntur issuer preview
  await expect(create.getByRole("checkbox").first()).toBeChecked();
  await create.getByRole("button", { name: "Create invoice" }).click();
  await expect(page.getByText(/Invoice INV-[\w-]+ created/)).toBeVisible();
  await expect(page).toHaveURL(/\/invoices\/\d+/);
  await expect(page.getByTestId("invoice-sheet")).toContainText("Fee Flow Learner");

  // back on the deal: View invoice replaces Create invoice
  await page.goto(`/leads/${lead.lead_id}`);
  await expect(page.getByRole("link", { name: "View invoice" })).toBeVisible();
});

test("manager rejects a special closing request with a reason", async ({ page, request }) => {
  test.setTimeout(60_000);
  const lead = await createDeal(request, "Reject Flow Learner");
  const headers = lead.headers;
  const start = await request.post(`/api/v1/leads/${lead.lead_id}/fee-discussions`, { headers, data: {} });
  const discussion = (await start.json()).data as { fee_discussion_id: number };
  const version = (await (await request.post(`/api/v1/fee-discussions/${discussion.fee_discussion_id}/versions`, { headers, data: { extra_concession: "700" } })).json())
    .data as { version_id: number };
  const scrRes = await request.post(`/api/v1/fee-discussion-versions/${version.version_id}/special-closing-requests`, { headers, data: { request_reason: "Needs help" } });
  const scr = (await scrRes.json()).data as { scr_id: number; scr_code: string };

  await login(page, USERS.bmGnt);
  await page.goto(`/discount-approval?id=${scr.scr_id}`);
  await expect(page.getByRole("heading", { name: `${scr.scr_code} · Reject Flow Learner` })).toBeVisible();
  await page.getByRole("button", { name: "Reject" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Reason").fill("Concession not justified");
  await dialog.getByRole("button", { name: "Reject" }).click();
  await expect(page.getByText(`${scr.scr_code} rejected`)).toBeVisible();

  await page.goto(`/fee-quote?leadId=${lead.lead_id}&discussionId=${discussion.fee_discussion_id}`);
  await expect(page.getByText("Version 1 · Rejected")).toBeVisible();
  await expect(page.getByText(`${scr.scr_code} · Rejected`)).toBeVisible();
});

test("standard-price version is approved directly; the invoice carries a flexible schedule", async ({ page, request }) => {
  const lead = await createDeal(request, "Standard Price Learner");
  await login(page, USERS.salesGnt);
  await page.goto(`/fee-quote?leadId=${lead.lead_id}`);
  await page.getByRole("button", { name: "Start fee discussion" }).click();
  await expect(page).toHaveURL(/discussionId=/);
  await expect(page.getByLabel("Instalments")).toHaveCount(0); // the schedule moved to the invoice
  await page.getByRole("button", { name: "Save discussion" }).click();
  await expect(page.getByText(/Version 1 saved/)).toBeVisible();
  await page.getByRole("button", { name: "Approve version" }).click();
  await expect(page.getByText("Version 1 approved")).toBeVisible();
  await acceptDeliveryPlan(request, lead.headers, lead.lead_id);

  await page.getByRole("button", { name: "Create invoice" }).click();
  const dialog = page.getByRole("dialog");
  // ₹1,000 token today and the rest in 45 days — the counsellor decides the split
  await dialog.getByRole("button", { name: "50/50" }).click();
  const total = Number((await dialog.getByLabel("Instalment 1 amount").inputValue())) * 2;
  const day = (n: number) => new Date(Date.now() + 5.5 * 3600_000 + n * 86_400_000).toISOString().slice(0, 10);
  await dialog.getByLabel("Instalment 1 amount").fill("1000");
  await expect(dialog.getByText(/Instalments add up to/)).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Create invoice" })).toBeDisabled();
  await dialog.getByLabel("Instalment 2 due date").fill(day(45));
  await dialog.getByLabel("Instalment 2 amount").fill(String(total - 1000));
  await dialog.getByRole("button", { name: "Create invoice" }).click();
  await expect(page).toHaveURL(/\/invoices\/\d+/);
  await expect(page.getByTestId("invoice-sheet").getByText("Instalment 1")).toBeVisible();
  await expect(page.getByTestId("invoice-sheet")).toContainText("₹1,000");
});
