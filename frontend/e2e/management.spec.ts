import { expect, test, type Page } from "@playwright/test";
import { USERS, login } from "./helpers";

const SHOTS = "/private/tmp/claude-501/-Users-manojtungala-nipuna-crm/3aa0633b-0a9a-4dca-89e8-f5788c3e5648/scratchpad/shots";
const stamp = () => String(Date.now()).slice(-8);
const shot = (page: Page, name: string) => page.screenshot({ path: `${SHOTS}/mgmt-${name}.png`, fullPage: true });

async function apiToken(page: Page) {
  return page.evaluate(() => window.sessionStorage.getItem("nipuna-session"));
}

/** Switch user within one test: drop the session token, then sign in again. */
async function relogin(page: Page, email: string) {
  await page.evaluate(() => window.sessionStorage.clear());
  await login(page, email);
}

async function confirmDialog(page: Page, action: string) {
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: action, exact: true }).click();
  await expect(dialog).toHaveCount(0);
}

test("founder dashboard shows company KPIs, branch comparison, funnel, targets and AI brief", async ({ page }) => {
  await login(page, USERS.founder);
  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { name: "Founder / CEO Dashboard" })).toBeVisible();
  await expect(page.getByRole("link", { name: /Genuine Enquiries/ })).toBeVisible();
  const comparison = page.locator("section", { has: page.getByRole("heading", { name: "Branch comparison" }) });
  await expect(comparison.getByRole("cell", { name: "Guntur" })).toBeVisible();
  await expect(comparison.getByRole("cell", { name: "Vijayawada" })).toBeVisible();
  await expect(page.getByRole("figure", { name: "Lead funnel by stage" })).toBeVisible();
  await expect(page.getByText("New Enquiry").first()).toBeVisible();
  await expect(page.getByRole("meter").first()).toBeVisible();
  await expect(page.getByText("AI Management Brief")).toBeVisible();
  await expect(page.getByText(/Verified collections ₹/)).toBeVisible();
  await page.getByRole("button", { name: "Helpful" }).click();
  await expect(page.getByText("Feedback recorded: Helpful")).toBeVisible();

  // Period switch refetches (Last Month has its own range)
  await page.getByRole("button", { name: "Last Month", exact: true }).click();
  await expect(page.getByText(/Last Month ·/).first()).toBeVisible();
  await page.getByRole("button", { name: "This Month", exact: true }).click();
  await shot(page, "dashboard-founder");

  // Branch scope switcher narrows the comparison
  await page.getByLabel("Branch scope").selectOption({ label: "Guntur" });
  await expect(comparison.getByRole("cell", { name: "Vijayawada" })).toHaveCount(0);
  await page.getByLabel("Branch scope").selectOption({ index: 0 });
});

test("branch manager view: own branch, team queues with links, no admin access", async ({ page }) => {
  await login(page, USERS.bmGnt);
  await page.goto("/branch-manager");
  await expect(page.getByRole("heading", { name: "Branch Manager Dashboard" })).toBeVisible();
  const queues = page.locator("section", { has: page.getByRole("heading", { name: "Team queues" }) });
  await expect(queues.getByText("Unassigned leads")).toBeVisible();
  await expect(queues.getByText("Overdue tasks")).toBeVisible();
  await expect(queues.getByText("Payments pending verification")).toBeVisible();
  await expect(queues.getByText("Approvals pending")).toBeVisible();
  await expect(page.getByText("Top staff")).toBeVisible();
  await expect(page.getByText("AI Management Brief")).toBeVisible();
  await expect(page.getByRole("figure", { name: /Verified collections and pending/ })).toBeVisible();
  const comparison = page.locator("section", { has: page.getByRole("heading", { name: "Branch comparison" }) });
  await expect(comparison.getByRole("cell", { name: "Vijayawada" })).toHaveCount(0);
  await shot(page, "branch-manager");

  await queues.getByRole("link", { name: /Unassigned leads/ }).click();
  await expect(page).toHaveURL(/\/leads\?assigned_to=unassigned/);

  await page.goto("/admin");
  await expect(page.getByText("You don't have access to this screen")).toBeVisible();
});

test("staff dashboard (accounts) shows KPI tiles only", async ({ page }) => {
  await login(page, USERS.accountsGnt);
  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { name: "Dashboard", exact: true })).toBeVisible();
  await expect(page.getByText("Verified Collections")).toBeVisible();
  await expect(page.getByText("AI Management Brief")).toHaveCount(0);
});

test("accounts runs reports with filters and exports CSV", async ({ page }) => {
  await login(page, USERS.accountsGnt);
  await page.goto("/reports");
  await expect(page.getByRole("heading", { name: "Reports" })).toBeVisible();
  await expect(page.getByText("Verified collections · net")).toBeVisible();
  await expect(page.getByRole("cell", { name: "Guntur" }).first()).toBeVisible();
  await expect(page.getByRole("figure", { name: "Lead funnel by stage" })).toBeVisible();
  await expect(page.getByText("Within SLA")).toBeVisible();

  await page.getByLabel("Performance by").selectOption("staff");
  await expect(page.getByRole("cell", { name: "Counsellor A (GNT)" })).toBeVisible();
  await page.getByLabel("Staff (lead owner)").selectOption({ label: "Counsellor A (GNT)" });
  await expect(page.getByRole("cell", { name: "Front Office B (GNT)" })).toHaveCount(0);
  await page.getByRole("button", { name: "Last Month", exact: true }).click();
  await expect(page.getByText(/Period 2026-08-01/)).toBeVisible();
  await page.getByRole("button", { name: "This Month", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Scheduled reports" })).toHaveCount(0);
  await shot(page, "reports");

  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Export management CSV" }).click()]);
  expect(download.suggestedFilename()).toBe("management-report.csv");
});

test("admin creates and pauses a scheduled report", async ({ page }) => {
  const email = `e2e.reports.${stamp()}@nipuna.test`;
  await login(page, USERS.admin);
  await page.goto("/reports");
  await page.getByRole("button", { name: "New schedule" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Frequency").selectOption("Weekly");
  await dialog.getByLabel("Schedule day").fill("1");
  await dialog.getByLabel("Recipients").fill(email);
  await dialog.getByRole("button", { name: "Save schedule" }).click();
  await expect(page.getByText("Scheduled report saved")).toBeVisible();
  const row = page.getByRole("row", { name: new RegExp(email.replace(/\./g, "\\.")) });
  await expect(row).toBeVisible();
  await row.getByRole("switch").click();
  await expect(page.getByText(/report paused/)).toBeVisible();
});

test("target master: admin drafts a version, founder approves, BM is read-only", async ({ page }) => {
  const year = 2200 + (Date.now() % 700);
  await login(page, USERS.admin);
  await page.goto("/target-master");
  await expect(page.getByText("Current achievement")).toBeVisible();
  await expect(page.getByRole("cell", { name: "TM-2026-09-v1" }).first()).toBeVisible();
  await page.getByRole("button", { name: "New target version" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Period start").fill(`${year}-01-01`);
  await dialog.getByLabel("Period end").fill(`${year}-01-31`);
  await dialog.getByLabel("Company collections target").fill("500000");
  await dialog.getByLabel("Company admissions target").fill("20");
  await dialog.getByLabel("Guntur collections target").fill("300000");
  await dialog.getByLabel("Guntur admissions target").fill("12");
  await dialog.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByText(`TM-${year}-01-v1 saved as Draft`)).toBeVisible();
  await shot(page, "targets");

  await relogin(page, USERS.founder);
  await page.goto("/target-master");
  const row = page.getByRole("row", { name: new RegExp(`TM-${year}-01-v1`) });
  await expect(row.getByText("Draft")).toBeVisible();
  await row.getByRole("button", { name: `Approve TM-${year}-01-v1` }).click();
  await confirmDialog(page, "Approve");
  await expect(row.getByText("Approved")).toBeVisible();

  await relogin(page, USERS.bmGnt);
  await page.goto("/target-master");
  await expect(page.getByText("Current achievement")).toBeVisible();
  await expect(page.getByRole("button", { name: "New target version" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Approve/ })).toHaveCount(0);
});

test("offer master: create, scope, complimentary course, activate, new version, deactivate; BM read-only", async ({ page }) => {
  const code = `OM-E2E-${stamp()}`;
  await login(page, USERS.admin);
  await page.goto("/offer-master");
  await page.getByRole("button", { name: "New offer" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Offer code").fill(code);
  await dialog.getByLabel("Offer name").fill("E2E festival offer");
  await dialog.getByLabel("Discount amount (₹)").fill("500");
  await dialog.getByLabel("Valid from").fill("2026-09-01");
  await dialog.getByLabel("Valid to").fill("2030-12-31");
  await dialog.getByRole("button", { name: "Create offer" }).click();
  await expect(page.getByText(`${code} v1 created`)).toBeVisible();
  const detail = page.locator("section", { has: page.getByRole("heading", { name: new RegExp(`${code} · v1`) }) });
  await expect(detail).toBeVisible();

  // Narrow scope to Vijayawada + one course
  await detail.getByRole("button", { name: "Scope" }).click();
  await dialog.getByLabel("All branches").uncheck();
  await dialog.getByLabel("Vijayawada").check();
  await dialog.getByLabel("All courses").uncheck();
  await dialog.getByLabel(/AWS with DevOps/).check();
  await dialog.getByRole("button", { name: "Save scope" }).click();
  await expect(page.getByText("Scope saved")).toBeVisible();
  await expect(detail.getByText("Vijayawada")).toBeVisible();

  await detail.getByRole("button", { name: "Complimentary courses" }).click();
  await dialog.getByRole("button", { name: "Add course" }).click();
  await dialog.getByLabel("Course", { exact: true }).selectOption({ index: 1 });
  await dialog.getByLabel("Min final fee (₹)").fill("15000");
  await dialog.getByRole("button", { name: "Save courses" }).click();
  await expect(page.getByText("Complimentary courses saved")).toBeVisible();
  await expect(detail.getByText("Final agreed paid fee ≥ ₹15,000")).toBeVisible();

  await detail.getByRole("button", { name: "Activate" }).click();
  await confirmDialog(page, "Activate");
  await expect(page.getByText(`${code} v1 is active`)).toBeVisible();
  await shot(page, "offers");

  await detail.getByRole("button", { name: "New version" }).click();
  await expect(page.getByText("Draft v2 created")).toBeVisible();
  await expect(page.getByRole("heading", { name: new RegExp(`${code} · v2`) })).toBeVisible();

  // Back to v1 and deactivate it (keeps other flows free of this test offer)
  await page.getByRole("button", { name: new RegExp(`${code} · v1`) }).click();
  const v1 = page.locator("section", { has: page.getByRole("heading", { name: new RegExp(`${code} · v1`) }) });
  await v1.getByRole("button", { name: "Deactivate" }).click();
  await confirmDialog(page, "Deactivate");
  await expect(page.getByText(`${code} v1 deactivated`)).toBeVisible();

  await relogin(page, USERS.bmGnt);
  await page.goto("/offer-master");
  await expect(page.getByRole("button", { name: new RegExp(`${code} · v1`) })).toBeVisible();
  await expect(page.getByRole("button", { name: "New offer" })).toHaveCount(0);
  await page.getByRole("button", { name: new RegExp(`${code} · v1`) }).click();
  await expect(page.getByRole("button", { name: "New version" })).toHaveCount(0);
});

test("admin users & access: create with one-time password, grant/revoke scope, reset password, deactivate", async ({ page }) => {
  const id = stamp();
  const email = `e2e.user.${id}@nipuna.test`;
  await login(page, USERS.admin);
  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "Admin / Settings" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Counsellor A \(GNT\)/ })).toBeVisible();
  await shot(page, "admin-users");

  await page.getByRole("button", { name: "New user" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Full name").fill(`E2E Trainer ${id}`);
  await dialog.getByLabel("Email").fill(email);
  await dialog.getByLabel("Role").selectOption({ label: "Trainer" });
  await dialog.getByLabel("Branch scope").selectOption({ label: "Guntur" });
  await dialog.getByRole("button", { name: "Create user" }).click();
  await expect(page.getByRole("heading", { name: "User created" })).toBeVisible();
  await expect(page.getByLabel("Temporary password")).not.toBeEmpty();
  await page.getByRole("button", { name: "Done" }).click();

  const detail = page.locator("section", { has: page.getByRole("heading", { name: `E2E Trainer ${id}` }) });
  await expect(detail.getByRole("cell", { name: "Trainer", exact: true })).toBeVisible();

  await detail.getByRole("button", { name: "Grant access" }).click();
  await dialog.getByLabel("Role").selectOption({ label: "Placement Team" });
  await dialog.getByLabel("Branch scope").selectOption({ label: "Guntur" });
  await dialog.getByLabel(/Expires/).fill("2030-01-01T10:00");
  await dialog.getByRole("button", { name: "Grant" }).click();
  await expect(page.getByText("Placement Team access granted")).toBeVisible();

  await detail.getByRole("button", { name: /Revoke Placement Team/ }).click();
  await confirmDialog(page, "Revoke");
  await expect(page.getByText("Access revoked")).toBeVisible();
  await expect(detail.getByText("revoked")).toBeVisible();

  await detail.getByRole("button", { name: "Reset password" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Reset password", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Password reset" })).toBeVisible();
  await page.getByRole("button", { name: "Done" }).click();

  await detail.getByRole("button", { name: "Deactivate" }).click();
  await confirmDialog(page, "Deactivate");
  await expect(page.getByText(`E2E Trainer ${id} deactivated`)).toBeVisible();
  await expect(detail.getByRole("button", { name: "Reactivate" })).toBeVisible();
});

test("admin settings, lookups and holidays (restored after the test)", async ({ page }) => {
  const id = stamp();
  await login(page, USERS.admin);
  await page.goto("/admin?tab=settings");
  const input = page.getByLabel("alumni_support_months", { exact: true });
  const original = await input.inputValue();
  await input.fill(String(Number(original) + 1));
  await page.getByRole("button", { name: "Save alumni_support_months" }).click();
  await expect(page.getByText("Setting saved")).toBeVisible();
  await input.fill(original);
  await page.getByRole("button", { name: "Save alumni_support_months" }).click();
  await expect(page.getByRole("button", { name: "Save alumni_support_months" })).toBeDisabled();
  await shot(page, "admin-settings");

  await page.getByRole("tab", { name: "Lookups" }).click();
  await page.getByLabel("Lookup type").selectOption("support-case-types");
  await page.getByLabel("Code").fill(`E2E_${id}`);
  await page.getByLabel("Label", { exact: true }).fill(`E2E case ${id}`);
  await page.getByRole("button", { name: "Add value" }).click();
  await expect(page.getByText(`E2E case ${id} added`)).toBeVisible();
  await page.getByRole("switch", { name: `is_active E2E_${id}` }).click();
  await expect(page.getByRole("switch", { name: `is_active E2E_${id}` })).not.toBeChecked();

  await page.getByRole("tab", { name: "Branches, shifts & holidays" }).click();
  await expect(page.getByLabel("Monday opens")).toBeVisible();
  await page.getByLabel("Year").selectOption(String(new Date().getFullYear() + 1));
  const day = String(1 + (Date.now() % 28)).padStart(2, "0");
  const month = String(1 + (Math.floor(Date.now() / 28) % 12)).padStart(2, "0");
  await page.getByLabel("Holiday date").fill(`${new Date().getFullYear() + 1}-${month}-${day}`);
  await page.getByLabel("Holiday name").fill(`E2E holiday ${id}`);
  await page.getByRole("button", { name: "Add holiday" }).click();
  await expect(page.getByRole("cell", { name: `E2E holiday ${id}`, exact: true })).toBeVisible();
  await page.getByRole("button", { name: `Remove holiday E2E holiday ${id}` }).click();
  await confirmDialog(page, "Remove");
  await expect(page.getByRole("cell", { name: `E2E holiday ${id}`, exact: true })).toHaveCount(0);

  for (const tab of ["Concession limits", "Notifications & channels", "Integrations & incidents"]) {
    await page.getByRole("tab", { name: tab }).click();
  }
  await expect(page.getByText("Branch email delivery")).toBeVisible();
  await expect(page.getByText("IR-00001")).toBeVisible();
});

test("deletion request needs an independent approver; sessions and audit log load", async ({ page }) => {
  const id = stamp();
  await login(page, USERS.admin);
  const token = await apiToken(page);
  const res = await page.request.post("/api/v1/saved-views", {
    headers: { Authorization: `Bearer ${token}` },
    data: { module: "leads", name: `E2E view ${id}`, filters: { stage: "Counselling" } },
  });
  expect(res.ok()).toBeTruthy();
  const viewId = (await res.json()).data.saved_view_id as number;

  await page.goto("/admin?tab=security");
  await expect(page.getByRole("heading", { name: "Active sessions" })).toBeVisible();
  await expect(page.getByRole("cell", { name: /admin@nipuna\.test/ }).first()).toBeVisible();
  await page.getByLabel("Record ID").fill(String(viewId));
  await page.getByLabel("Deletion reason").fill(`E2E cleanup ${id}`);
  await page.getByRole("button", { name: "Request deletion" }).click();
  await expect(page.getByText(/Deletion requested/)).toBeVisible();
  const mine = page.getByRole("row", { name: new RegExp(`E2E cleanup ${id}`) });
  await expect(mine.getByText("Awaiting another admin")).toBeVisible();
  await shot(page, "admin-security");

  await relogin(page, USERS.founder);
  await page.goto("/admin?tab=security");
  const row = page.getByRole("row", { name: new RegExp(`E2E cleanup ${id}`) });
  await row.getByRole("button", { name: /Approve deletion/ }).click();
  await confirmDialog(page, "Approve");
  await expect(row.getByText("Approved")).toBeVisible();
  await row.getByRole("button", { name: /Execute deletion/ }).click();
  await confirmDialog(page, "Delete permanently");
  await expect(row.getByText("Executed")).toBeVisible();

  await page.getByRole("tab", { name: "Audit log" }).click();
  await page.getByLabel("Action").fill("DELETION_APPROVED");
  await page.getByRole("button", { name: "Filter" }).click();
  await expect(page.getByRole("cell", { name: "DELETION_APPROVED" }).first()).toBeVisible();
});

test("AI Copilot: counsellor gets next best actions, a before-call brief and gives feedback", async ({ page }) => {
  test.setTimeout(90_000);
  await login(page, USERS.salesGnt);
  await page.goto("/ai-copilot");
  await expect(page.getByText("Advisory sales assistance", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Suggest next actions" }).click();
  await expect(page.getByText("CRM facts")).toBeVisible();
  await page.getByRole("button", { name: "Generate before-call brief" }).click();
  await expect(page.getByText(/AI Before-call Brief/)).toBeVisible();
  await expect(page.getByText("Why this priority", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Missing Context" }).click();
  await expect(page.getByText("Feedback recorded: Missing Context")).toBeVisible();
  await shot(page, "ai-copilot");
});

test("Ask Nipuna: branch manager asks a question and sees recorded facts", async ({ page }) => {
  await login(page, USERS.bmGnt);
  await page.goto("/ask-nipuna");
  await page.getByRole("button", { name: "Which counsellors have overdue follow-ups?" }).click();
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await expect(page.getByText("Recorded facts:")).toBeVisible();
  await expect(page.getByText("Missing evidence:")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Supporting table" })).toBeVisible();
  await page.getByRole("button", { name: "Helpful" }).click();
  await expect(page.getByText("Feedback recorded: Helpful")).toBeVisible();
  await shot(page, "ask-nipuna");
});

test("More hub is role-filtered and dashboard fits phone width @mobile", async ({ page }) => {
  await login(page, USERS.bmGnt);
  await page.goto("/more");
  const main = page.getByRole("main");
  await expect(main.getByRole("link", { name: "Branch Manager" })).toBeVisible();
  await expect(main.getByRole("link", { name: "Offer Master" })).toBeVisible();
  await expect(main.getByRole("link", { name: "Admin / Settings" })).toHaveCount(0);
  await shot(page, "more");

  await page.goto("/branch-manager");
  await expect(page.getByRole("heading", { name: "Branch Manager Dashboard" })).toBeVisible();
  await expect(page.getByText("Team queues")).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await shot(page, "branch-manager-mobile");

  await page.goto("/reports");
  await expect(page.getByText("Verified collections · net")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
  await shot(page, "reports-mobile");
});
