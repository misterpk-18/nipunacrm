import { expect, test, type Page } from "@playwright/test";
import { USERS, login, uniquePhone } from "./helpers";

const SHOTS = "/private/tmp/claude-501/-Users-manojtungala-nipuna-crm/3aa0633b-0a9a-4dca-89e8-f5788c3e5648/scratchpad/shots";
const stamp = () => String(Date.now()).slice(-7);
const shot = (page: Page, name: string) => page.screenshot({ path: `${SHOTS}/ops-${name}.png`, fullPage: true });

/** Create a task through the dialog. A past due date sorts it to the top of the (due-ordered) board. */
async function createTask(page: Page, opts: { title: string; owner?: string; lead?: number }) {
  await page.getByRole("button", { name: "Create Task" }).click();
  const dialog = page.getByRole("dialog", { name: "Create task" });
  await dialog.getByLabel("Task type").selectOption({ label: "Follow-up" });
  await dialog.getByLabel("Title", { exact: true }).fill(opts.title);
  if (opts.owner !== undefined) await dialog.getByLabel("Owner").selectOption({ label: opts.owner });
  await dialog.getByLabel("Due").fill("2026-01-05T10:00");
  if (opts.lead) {
    await dialog.getByLabel("Linked record type (optional)").selectOption({ label: "Lead" });
    await dialog.getByLabel("Linked record ID").fill(String(opts.lead));
  }
  await dialog.getByRole("button", { name: "Create task" }).click();
  await expect(page.getByText(/Task #\d+ created/)).toBeVisible();
  await expect(dialog).toBeHidden();
}

// ---------------------------------------------------------------- tasks

test("counsellor creates a linked task, revises its deadline, blocks and completes it", async ({ page }) => {
  const title = `PW follow-up ${stamp()}`;
  await login(page, USERS.salesGnt);
  await page.goto("/tasks");
  await expect(page.getByRole("heading", { name: "Tasks" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "My Tasks" })).toHaveAttribute("data-state", "active");

  await createTask(page, { title, lead: 1 });
  const row = page.getByRole("row").filter({ hasText: title });
  await expect(row).toBeVisible();
  await expect(row.getByText("Overdue")).toBeVisible();
  await expect(row.getByRole("link", { name: "LD-00001" })).toHaveAttribute("href", "/leads/1");

  await row.getByRole("button", { name: "Open" }).click();
  const dialog = page.getByRole("dialog").filter({ hasText: title });
  await dialog.getByLabel("New deadline").fill("2030-02-01T12:00");
  await dialog.getByLabel("Reason for revision").fill("Student travelling");
  await dialog.getByRole("button", { name: "Revise deadline" }).click();
  await expect(page.getByText("Deadline revised")).toBeVisible();
  await expect(dialog.getByText("Reason: Student travelling")).toBeVisible();
  await expect(dialog.getByText("05 Jan, 10:00 am", { exact: true })).toBeVisible(); // original deadline stays visible

  await dialog.getByRole("button", { name: "Block" }).click();
  const confirm = page.getByRole("dialog", { name: "Mark task waiting / blocked" });
  await confirm.getByLabel("Blocked reason").fill("Waiting for documents");
  await confirm.getByRole("button", { name: "Block task" }).click();
  await expect(dialog.getByText("Waiting/Blocked").first()).toBeVisible();
  await expect(dialog.getByText("Waiting for documents")).toBeVisible();

  await dialog.getByRole("button", { name: "Complete" }).click();
  await expect(page.getByText("Task completed")).toBeVisible();
  await expect(dialog.getByText("no further actions")).toBeVisible();
  await shot(page, "task-dialog");
  await page.keyboard.press("Escape");

  // Completed tasks leave My Tasks but show in the Completed tab
  await expect(page.getByRole("row").filter({ hasText: title })).toHaveCount(0);
  await page.getByRole("tab", { name: "Completed" }).click();
  await expect(page).toHaveURL(/tab=Completed/);
  await shot(page, "tasks-completed");
});

test("branch manager sees the team queue, reassigns and cancels a task with a reason", async ({ page }) => {
  const title = `PW cover ${stamp()}`;
  await login(page, USERS.bmGnt);
  await page.goto("/tasks?tab=Team%20Tasks");
  await expect(page.getByRole("row").nth(1)).toBeVisible(); // seeded system tasks
  await shot(page, "tasks-team");

  await page.getByRole("tab", { name: "Unassigned / Needs Cover" }).click();
  await createTask(page, { title, owner: "Unassigned" });
  const row = page.getByRole("row").filter({ hasText: title });
  await expect(row.getByText("Unassigned").first()).toBeVisible();
  await row.click();

  const dialog = page.getByRole("dialog").filter({ hasText: title });
  await dialog.getByLabel("New owner").selectOption({ label: "Counsellor A (GNT)" });
  await dialog.getByRole("button", { name: "Reassign" }).click();
  await expect(page.getByText("Reassigned to Counsellor A (GNT)")).toBeVisible();

  await dialog.getByRole("button", { name: "Cancel task" }).click();
  const confirm = page.getByRole("dialog", { name: "Cancel this task?" });
  await confirm.getByLabel("Cancel reason").fill("Duplicate of another task");
  await confirm.getByRole("button", { name: "Cancel task" }).click();
  await expect(page.getByText("Task cancelled")).toBeVisible();
  await expect(dialog.getByText("Duplicate of another task")).toBeVisible();
});

test("front office can work its own task but not cancel or reassign it", async ({ page }) => {
  const title = `PW fo ${stamp()}`;
  await login(page, USERS.foGnt);
  await page.goto("/tasks");
  await createTask(page, { title });
  await page.getByRole("row").filter({ hasText: title }).click();
  const dialog = page.getByRole("dialog").filter({ hasText: title });
  await expect(dialog.getByRole("button", { name: "Complete" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Cancel task" })).toHaveCount(0);
  await expect(dialog.getByLabel("New owner")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Start" }).click();
  await expect(page.getByText("Task in progress")).toBeVisible();
  await dialog.getByRole("button", { name: "Complete" }).click();
  await expect(page.getByText("Task completed")).toBeVisible();
});

test("tasks list works at phone width @mobile", async ({ page, isMobile }) => {
  test.skip(!isMobile, "phone-width check runs in the mobile project");
  await login(page, USERS.bmGnt);
  await page.goto("/tasks?tab=Team%20Tasks");
  await expect(page.locator(".mobile-lead-card").first()).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await shot(page, "tasks-mobile");
});

// ---------------------------------------------------------------- communications

async function logCommunication(page: Page, v: { channel: string; direction?: "Inbound" | "Outbound"; status?: string; from?: string; to?: string; body: string; failure?: string }) {
  await page.getByRole("button", { name: "Log communication" }).click();
  const dialog = page.getByRole("dialog", { name: "Log communication" });
  await dialog.getByLabel("Channel").selectOption({ label: v.channel });
  if (v.direction) await dialog.getByLabel("Direction").selectOption(v.direction);
  if (v.status) await dialog.getByLabel("Delivery status").selectOption(v.status);
  if (v.from) await dialog.getByLabel("From (phone / email)").fill(v.from);
  if (v.to) await dialog.getByLabel("To (phone / email)").fill(v.to);
  await dialog.getByLabel("Message").fill(v.body);
  if (v.failure) await dialog.getByLabel("Failure reason").fill(v.failure);
  await dialog.getByRole("button", { name: "Save communication" }).click();
  await expect(page.getByText(/Communication logged/)).toBeVisible();
  await expect(dialog).toBeHidden();
}

test("inbox: log an inbound message, see its response due, and reply", async ({ page }) => {
  const body = `PW enquiry ${stamp()}`;
  await login(page, USERS.salesGnt);
  await page.goto("/communications");
  await expect(page.getByRole("heading", { name: "Communications" })).toBeVisible();
  await logCommunication(page, { channel: "WhatsApp", from: uniquePhone(), body });

  await page.getByRole("tab", { name: "Awaiting Reply" }).click();
  await expect(page).toHaveURL(/queue=Awaiting/);
  const row = page.getByRole("row").filter({ hasText: body });
  await expect(row.getByText("Within SLA")).toBeVisible();
  await expect(row.getByText(/Response due in/)).toBeVisible();
  await shot(page, "comms-awaiting");

  await row.getByRole("button", { name: "Reply" }).click();
  const dialog = page.getByRole("dialog", { name: "Reply" });
  await dialog.getByLabel("Reply message").fill("Yes — weekend batches start next month.");
  await dialog.getByRole("button", { name: "Log reply" }).click();
  await expect(page.getByText("Reply logged")).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: body })).toHaveCount(0);
});

test("inbox: a known sender goes to Match Review and is matched to the person and lead", async ({ page }) => {
  const body = `PW known sender ${stamp()}`;
  await login(page, USERS.salesGnt);
  await page.goto("/communications?queue=Match%20Review");
  await expect(page.getByText("Is there a weekend batch for Data Science?").first()).toBeVisible(); // seeded GNT WhatsApp
  await logCommunication(page, { channel: "WhatsApp", from: "9876500001", body });
  await expect(page.getByText(/possible match sent to Match Review/)).toBeVisible();

  const row = page.getByRole("row").filter({ hasText: body });
  await expect(row.getByText("Possible match: Ananya Rao")).toBeVisible();
  await row.getByRole("button", { name: "Match" }).click();
  const dialog = page.getByRole("dialog", { name: "Match communication" });
  await expect(dialog.getByRole("radio").first()).toBeChecked(); // suggested person preselected
  await dialog.getByLabel("Lead (optional)").selectOption({ index: 1 });
  await dialog.getByRole("button", { name: "Confirm match" }).click();
  await expect(page.getByText("Communication matched")).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: body })).toHaveCount(0);

  await page.getByRole("tab", { name: "All", exact: true }).click();
  const matched = page.getByRole("row").filter({ hasText: body });
  await expect(matched.getByText("Ananya Rao")).toBeVisible();
  await expect(matched.getByRole("link", { name: "Lead #1" })).toBeVisible();
});

test("inbox: a failed email can be retried", async ({ page }) => {
  const body = `PW failed mail ${stamp()}`;
  await login(page, USERS.salesGnt);
  await page.goto("/communications");
  await logCommunication(page, { channel: "Email", direction: "Outbound", status: "Failed", to: `pw${stamp()}@example.test`, body, failure: "Mailbox full" });
  await page.getByRole("tab", { name: "Failed Communications" }).click();
  const row = page.getByRole("row").filter({ hasText: body });
  await expect(row.getByText("Mailbox full")).toBeVisible();
  await row.getByRole("button", { name: "Retry" }).click();
  await page.getByRole("dialog", { name: "Retry this communication?" }).getByRole("button", { name: "Log retry" }).click();
  await expect(page.getByText("Retry logged")).toBeVisible();
  await page.getByRole("tab", { name: "All", exact: true }).click();
  await expect(page.getByText(/Retry of #\d+/).first()).toBeVisible();
});

test("communications is hidden from roles outside the sales team", async ({ page }) => {
  await login(page, USERS.placementGnt);
  await page.goto("/communications");
  await expect(page.getByText("You don't have access to this screen")).toBeVisible();
});

test("communications inbox at phone width @mobile", async ({ page, isMobile }) => {
  test.skip(!isMobile, "phone-width check runs in the mobile project");
  await login(page, USERS.salesGnt);
  await page.goto("/communications");
  await expect(page.locator(".mobile-lead-card").first()).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await shot(page, "comms-mobile");
});

// ---------------------------------------------------------------- notifications

test("notification centre shows tabs, unread count and read / acknowledge / complete actions", async ({ page }) => {
  await login(page, USERS.accountsGnt);
  await page.goto("/notifications");
  await expect(page.getByRole("heading", { name: "Notification Centre" })).toBeVisible();
  await expect(page.getByText(/Verify payment/).first()).toBeVisible();
  await expect(page.getByText(/\d+ unread/)).toBeVisible();
  await shot(page, "notifications");

  await page.getByRole("tab", { name: "Completed" }).click();
  await expect(page).toHaveURL(/tab=Completed/);
  await expect(page.getByText(/Verify payment/).first()).toBeVisible();
  await page.getByRole("tab", { name: "My Notifications" }).click();

  // Seeded + other suites' payments keep producing notifications; act on whatever is still pending.
  const ack = page.getByRole("button", { name: "Acknowledge" }).first();
  if (await ack.count()) {
    await ack.click();
    await expect(page.getByText("Acknowledged").first()).toBeVisible();
  }
  const read = page.getByRole("button", { name: "Mark read" }).first();
  if (await read.count()) {
    const before = Number((await page.getByText(/\d+ unread/).textContent())?.match(/\d+/)?.[0]);
    await read.click();
    await expect(page.getByText("Marked read")).toBeVisible();
    await expect(page.getByText(`${before - 1} unread`)).toBeVisible();
  }
  await page.getByRole("tab", { name: "Action Required" }).click();
  const complete = page.getByRole("button", { name: "Complete" }).first();
  if (await complete.count()) {
    await complete.click();
    await expect(page.getByText("Marked complete")).toBeVisible();
  }
});

// ---------------------------------------------------------------- placement & alumni

test("placement team adds a company and job, updates a profile, and moves an application", async ({ page }) => {
  test.setTimeout(90_000); // many round trips; the shared dev server is busy with other suites
  const id = stamp();
  const company = `PW Employer ${id}`;
  const job = `PW Analyst ${id}`;
  await login(page, USERS.placementGnt);
  await page.goto("/placement-alumni");
  await expect(page.getByText("Career assistance only — no guaranteed placement.")).toBeVisible();
  await expect(page.getByText("Junior Data Analyst").first()).toBeVisible();
  await expect(page.getByText("Sample Employer A").first()).toBeVisible();

  await page.getByRole("button", { name: "Add company" }).click();
  const co = page.getByRole("dialog", { name: "Add company" });
  await co.getByLabel("Company name").fill(company);
  await co.getByLabel("City").fill("Guntur");
  await co.getByRole("button", { name: "Save company" }).click();
  await expect(page.getByText(`${company} added`)).toBeVisible();

  await page.getByRole("button", { name: "New job opening" }).click();
  const jd = page.getByRole("dialog", { name: "New job opening" });
  await jd.getByLabel("Company").selectOption({ label: company });
  await jd.getByLabel("Job title").fill(job);
  await jd.getByLabel("Required skills").fill("SQL, Power BI");
  await jd.getByLabel("Status").selectOption("Open");
  await jd.getByRole("button", { name: "Save job opening" }).click();
  await expect(page.getByText(/JOB-\d+ created/)).toBeVisible();

  const jobRow = page.getByRole("row").filter({ hasText: job });
  await jobRow.getByRole("combobox").selectOption("On Hold");
  await expect(page.getByText(/JOB-\d+ updated/).first()).toBeVisible();
  await expect(jobRow.getByRole("combobox")).toHaveValue("On Hold");
  await jobRow.getByRole("combobox").selectOption("Open");
  await expect(jobRow.getByRole("combobox")).toHaveValue("Open");

  // Profile + consent + application for Rohit Kumar
  await page.getByLabel("Search students").fill("Rohit Kumar");
  await page.getByLabel("Search students").press("Enter");
  await page.getByRole("row").filter({ hasText: "Rohit Kumar" }).getByRole("button", { name: "Placement profile" }).click();
  const pd = page.getByRole("dialog", { name: /Placement profile · Rohit Kumar/ });
  await pd.getByLabel("Readiness").selectOption("Ready");
  await pd.getByLabel("Skills").fill("Python, SQL");
  await pd.getByLabel("Preferred location").fill("Guntur");
  await pd.getByRole("button", { name: "Save profile" }).click();
  await expect(page.getByText("Placement profile saved")).toBeVisible();

  const consent = pd.getByRole("button", { name: "Record explicit consent" });
  if (await consent.count()) {
    await consent.click();
    await page.getByRole("dialog", { name: "Record explicit referral consent?" }).getByRole("button", { name: "Record consent" }).click();
    await expect(page.getByText("Explicit referral consent recorded")).toBeVisible();
  }
  await expect(pd.getByText("Explicit Consent")).toBeVisible();

  const option = await pd.getByLabel("Job opening").locator("option", { hasText: job }).getAttribute("value");
  await pd.getByLabel("Job opening").selectOption(option!);
  await pd.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByText(`Applied to ${job}`)).toBeVisible();
  const appRow = pd.getByRole("row").filter({ hasText: job });
  await expect(appRow.getByText("Applied")).toBeVisible();
  await shot(page, "placement-profile");

  await appRow.getByRole("button", { name: "Change stage" }).click();
  const sd = page.getByRole("dialog", { name: "Change application stage" });
  await sd.getByLabel("New stage").selectOption("Interview Scheduled");
  await sd.getByLabel("Interview at").fill("2030-03-01T11:00");
  await sd.getByRole("button", { name: "Save stage" }).click();
  await expect(page.getByText("Stage changed to Interview Scheduled")).toBeVisible();

  await appRow.getByRole("button", { name: "Add event" }).click();
  const ed = page.getByRole("dialog", { name: "Add application event" });
  await ed.getByLabel("Event type").selectOption("Interview No-show");
  await ed.getByLabel("Event notes").fill("Did not attend; rescheduling");
  await ed.getByRole("button", { name: "Record event" }).click();
  await expect(page.getByText("Event recorded")).toBeVisible();
  await expect(appRow.getByText("Interview Scheduled")).toBeVisible(); // a no-show doesn't close it
  await page.keyboard.press("Escape");

  await expect(page.getByRole("heading", { name: "Alumni and support" })).toBeVisible();
  await shot(page, "placement");
});

test("academic coordinator sees alumni only", async ({ page }) => {
  await login(page, USERS.coordGnt);
  await page.goto("/placement-alumni");
  await expect(page.getByRole("heading", { name: "Alumni and support" })).toBeVisible();
  await expect(page.getByRole("button", { name: "New job opening" })).toHaveCount(0);
});

test("sales cannot open placement", async ({ page }) => {
  await login(page, USERS.salesGnt);
  await page.goto("/placement-alumni");
  await expect(page.getByText("You don't have access to this screen")).toBeVisible();
});
