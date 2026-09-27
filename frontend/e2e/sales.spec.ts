import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { PASSWORD, USERS, login, uniquePhone } from "./helpers";

const SHOTS = "/private/tmp/claude-501/-Users-manojtungala-nipuna-crm/3aa0633b-0a9a-4dca-89e8-f5788c3e5648/scratchpad/shots";

// ---------------------------------------------------------------- API helpers (test data setup only)

async function apiLogin(request: APIRequestContext, email: string) {
  const res = await request.post("/api/v1/auth/login", { data: { email, password: PASSWORD } });
  expect(res.ok()).toBeTruthy();
  const token = (await res.json()).data.token as string;
  return { Authorization: `Bearer ${token}` };
}

type Lookup = { id: number; label: string };

/** A fresh Guntur lead owned by sales.gnt, with a course unless `withCourse` is false (re-runnable: unique phone). */
async function createLead(request: APIRequestContext, name: string, withCourse = true) {
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
  return { ...lead, phone, headers };
}

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

test("pipeline board loads stages and moves a lead between manual stages @mobile", async ({ page, request }) => {
  const lead = await createLead(request, "Pipeline Mover");
  await login(page, USERS.salesGnt);
  await page.goto(`/pipeline?q=${lead.phone}`);
  const newCol = page.getByRole("region", { name: "New Enquiry" });
  await expect(newCol.getByRole("link", { name: "Pipeline Mover" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Admitted" })).toBeVisible();
  await page.getByLabel("Move Pipeline Mover to stage").selectOption("Counselling");
  await expect(page.getByText("Pipeline Mover moved to Counselling")).toBeVisible();
  await expect(page.getByRole("region", { name: "Counselling" }).getByRole("link", { name: "Pipeline Mover" })).toBeVisible();

  await page.goto("/pipeline");
  await expect(page.getByRole("region", { name: "Counselling" }).getByRole("article").first()).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/sales-pipeline-${test.info().project.name}.png`, fullPage: true });
  await page.getByRole("button", { name: "Table" }).click();
  await page.getByLabel("Search pipeline").fill("Rohit Kumar");
  await page.getByLabel("Search pipeline").press("Enter");
  await expect(page).toHaveURL(/view=table/);
  await expect(page.getByRole("columnheader", { name: "Stage" })).toBeVisible();
  // protected stages are never movable by hand
  await expect(page.getByRole("row", { name: /Rohit Kumar/ }).getByText("System-set stage")).toBeVisible();
});

// ---------------------------------------------------------------- Demos

test("counsellor books a demo for a lead with no course", async ({ page, request }) => {
  const lead = await createLead(request, `No Course Demo ${Date.now().toString(36)}`, false);
  await login(page, USERS.salesGnt);
  await page.goto(`/leads/${lead.lead_id}`);
  await page.getByRole("button", { name: /Schedule demo/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Course (optional)")).toBeVisible();
  const at = new Date(Date.now() + 2 * 86400_000).toISOString().slice(0, 11) + "12:00";
  await dialog.getByLabel("Demo date and time").fill(at);
  await dialog.getByRole("button", { name: "Schedule" }).click();
  await expect(page.locator("[data-sonner-toast]").getByText(/Demo DM-GNT-\d+ scheduled/)).toBeVisible();
  await page.goto("/demos");
  await expect(page.getByRole("article").filter({ hasText: lead.name }).getByText(/No course/)).toBeVisible();
});

test("counsellor confirms, reschedules and cancels a demo with reasons; reminders load", async ({ page, request }) => {
  const name = `Demo Flow ${Date.now().toString(36)}`;
  const lead = await createLead(request, name);
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
  const lead = await createLead(request, "Outcome Learner");
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

test("fee discussion with extra concession: request special closing, manager approves, counsellor accepts plan and issues invoice", async ({ page, request }) => {
  test.setTimeout(90_000);
  const lead = await createLead(request, "Fee Flow Learner");

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

  // counsellor: share, accept plan, issue invoice
  await logout(page);
  await login(page, USERS.salesGnt);
  await page.goto(discussionUrl);
  await expect(page.getByText("Version 1 · Approved")).toBeVisible();
  await page.getByRole("button", { name: "Share approved fee" }).click();
  await expect(page.getByText("Approved fee marked as shared")).toBeVisible();
  await page.getByRole("button", { name: "Accept plan" }).click();
  await dialog.getByLabel("Seat type").selectOption("Future Plan");
  await dialog.getByLabel("Planned start date").fill("2030-03-01");
  await dialog.getByLabel("Delivery mode").selectOption("Hybrid");
  await dialog.getByRole("button", { name: "Accept plan" }).click();
  await expect(page.getByText("Accepted plan recorded")).toBeVisible();
  await expect(page.locator("dd", { hasText: "Future Plan" })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/sales-fee-quote.png`, fullPage: true });

  await page.getByRole("button", { name: "Issue invoice" }).click();
  await dialog.getByRole("button", { name: "Issue invoice" }).click();
  await expect(page.getByText(/Invoice INV-[\w-]+ issued/)).toBeVisible();
  await expect(page).toHaveURL(/\/invoices\/\d+/);
});

test("manager rejects a special closing request with a reason", async ({ page, request }) => {
  test.setTimeout(60_000);
  const lead = await createLead(request, "Reject Flow Learner");
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

test("standard-price version is approved directly by the counsellor", async ({ page, request }) => {
  const lead = await createLead(request, "Standard Price Learner");
  await login(page, USERS.salesGnt);
  await page.goto(`/fee-quote?leadId=${lead.lead_id}`);
  await page.getByRole("button", { name: "Start fee discussion" }).click();
  await expect(page).toHaveURL(/discussionId=/);
  await page.getByLabel("Payment plan").selectOption({ label: "Two Instalments" });
  await page.getByRole("button", { name: "Save discussion" }).click();
  await expect(page.getByText(/Version 1 saved/)).toBeVisible();
  await page.getByRole("button", { name: "Approve version" }).click();
  await expect(page.getByText("Version 1 approved")).toBeVisible();
  await page.getByRole("button", { name: "Issue invoice" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel(/Instalment 2 .* due day/)).toHaveValue("12");
  await dialog.getByLabel(/Instalment 2 .* due day/).fill("14");
  await dialog.getByRole("button", { name: "Issue invoice" }).click();
  await expect(page).toHaveURL(/\/invoices\/\d+/);
});
