import { expect, test } from "@playwright/test";
import { USERS, login } from "./helpers";

/** V4 look and shell (Phase 1) and the new screens (Phase 9): sidebar groups, phone bar, Overview, LMS access, My work, Workflow guide. */

test("founder sees V4 sidebar groups, names and the More group", async ({ page }) => {
  await login(page, USERS.founder);
  const nav = page.getByRole("navigation", { name: "Main" });
  const groups: Record<string, string[]> = {
    Workspace: ["Overview", "My work", "AI assistant"],
    Sales: ["Leads", "Deal pipeline", "Demos & counselling"],
    Learning: ["Students", "Admissions", "Batches", "LMS access"],
    Finance: ["Invoices", "Payments & receipts", "Collections", "Refunds"],
    Operations: ["Tasks", "Communications", "Placement & alumni", "Reports"],
  };
  for (const [group, items] of Object.entries(groups)) {
    const g = nav.getByRole("group", { name: group });
    for (const item of items) await expect(g.getByRole("link", { name: new RegExp(`^${item.replace(/[&]/g, "\\$&")}`) })).toBeAttached();
  }
  // Screens outside V4's groups stay reachable
  const more = nav.getByRole("group", { name: "More" });
  for (const item of ["Persons", "Counsellor Workspace", "Discount Approvals", "Course Master", "Admin / Settings"]) await expect(more.getByRole("link", { name: item })).toBeAttached();
  await expect(page.getByRole("link", { name: "Workflow guide" })).toBeVisible();
  await expect(page.getByText("SAMPLE DATA")).toHaveCount(0);
});

test("counsellor's sidebar is role-gated", async ({ page }) => {
  await login(page, USERS.salesGnt);
  const nav = page.getByRole("navigation", { name: "Main" });
  await expect(nav.getByRole("link", { name: /^Deal pipeline/ })).toBeVisible();
  await expect(nav.getByRole("link", { name: /^Refunds/ })).toHaveCount(0);
  await expect(nav.getByRole("link", { name: "Admin / Settings" })).toHaveCount(0);
  await expect(nav.getByRole("group", { name: "Finance" })).toBeVisible(); // invoices / payments / collections
});

test("overview dashboard renders the four KPI cards, charts, attention and branch pulse", async ({ page }) => {
  await login(page, USERS.founder);
  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { name: "Workspace overview" })).toBeVisible();
  const kpis = page.getByLabel("Key figures");
  for (const label of ["Open enquiries", "Admissions", "Verified collections", "Outstanding balance"]) await expect(kpis.getByText(label, { exact: true })).toBeVisible();
  await expect(kpis.getByText(/ready for first contact/)).toBeVisible();
  await expect(kpis.getByText(/awaiting verification/)).toBeVisible();
  await expect(page.getByRole("figure", { name: /Verified collections per day/ })).toBeVisible();
  const pipeline = page.getByRole("list", { name: "Pipeline cards by stage" });
  for (const bar of ["Counselling", "Demo", "Fee discussion", "Verification", "Admitted"]) await expect(pipeline.getByText(bar, { exact: true })).toBeVisible();
  const attention = page.getByRole("tablist", { name: "Attention queues" });
  await expect(attention.getByRole("tab", { name: /Follow-ups/ })).toBeVisible();
  await attention.getByRole("tab", { name: /Payments/ }).click();
  await attention.getByRole("tab", { name: /Admissions/ }).click();
  const pulse = page.locator("section", { has: page.getByRole("heading", { name: "Branch pulse" }) });
  await expect(pulse.getByText("Guntur")).toBeVisible();
  await expect(pulse.getByText("Vijayawada")).toBeVisible();

  // Existing KPIs (incl. Long-gap plans) live under Performance
  await page.getByRole("tab", { name: "Performance" }).click();
  await expect(page).toHaveURL(/tab=performance/);
  await expect(page.getByRole("link", { name: /Genuine Enquiries/ })).toBeVisible();
  await expect(page.getByText(/Long-gap/i).first()).toBeVisible();
});

test("LMS access lists admissions with their LMS status", async ({ page }) => {
  await login(page, USERS.founder);
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "LMS access" }).click();
  await expect(page.getByRole("heading", { name: "LMS access" })).toBeVisible();
  for (const header of ["Learner", "Admission / course", "Curriculum", "LMS status", "Enrolment"]) await expect(page.getByRole("columnheader", { name: header })).toBeVisible();
  await expect(page.getByRole("cell", { name: /NIT-GNT-2026-/ }).first()).toBeVisible();
  await page.getByRole("button", { name: /^Not Created/ }).click();
  await expect(page).toHaveURL(/lms_status=Not\+Created|lms_status=Not%20Created/);
  await expect(page.getByRole("cell", { name: "Not Created" }).first()).toBeVisible();
});

test("My work shows the counsellor's queue and open tasks", async ({ page }) => {
  await login(page, USERS.salesGnt);
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "My work" }).click();
  await expect(page.getByRole("heading", { name: "My work" })).toBeVisible();
  const queues = page.getByRole("tablist", { name: "Queues" });
  await expect(queues.getByRole("tab", { name: /^New/ })).toHaveAttribute("aria-selected", "true");
  await queues.getByRole("tab", { name: /^Fee Discussion/ }).click();
  await expect(page).toHaveURL(/queue=fee_discussion/);
  await expect(page.getByRole("heading", { name: "My open tasks" })).toBeVisible();
  await expect(page.getByText(/open · oldest due first/)).toBeVisible();

  // Roles without leads access get their tasks only
  await page.evaluate(() => window.sessionStorage.clear());
  await login(page, USERS.trainerG1);
  await page.goto("/my-work");
  await expect(page.getByRole("heading", { name: "My open tasks" })).toBeVisible();
  await expect(page.getByRole("tablist", { name: "Queues" })).toHaveCount(0);
});

test("Workflow guide is open to every role", async ({ page }) => {
  await login(page, USERS.trainerG1);
  await page.getByRole("link", { name: "Workflow guide" }).click();
  await expect(page.getByRole("heading", { name: "Workflow guide" })).toBeVisible();
  const steps = page.getByRole("list", { name: "Workflow steps" });
  for (const step of ["Capture", "Qualify", "Convert to deal", "Accept delivery plan", "Invoice", "Record payment claim", "Verify", "Admission", "Batch", "LMS review"])
    await expect(steps.getByText(step, { exact: true })).toBeVisible();
  await expect(page.getByText(/pending claim is neither a receipt nor a collection/)).toBeVisible();
});

test("phone bottom bar has five role-aware items and no horizontal scroll @mobile", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile", "phone layout only");
  await login(page, USERS.salesGnt);
  const bar = page.getByRole("navigation", { name: "Quick" });
  await expect(bar.getByRole("link")).toHaveCount(5);
  for (const item of ["Home", "Leads", "Pipeline", "Payments", "AI"]) await expect(bar.getByRole("link", { name: item, exact: true })).toBeVisible();
  for (const path of ["/dashboard", "/leads", "/my-work", "/lms-access", "/workflow-guide"]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
  }
  await bar.getByRole("link", { name: "Pipeline", exact: true }).click();
  await expect(page).toHaveURL(/\/pipeline/);

  // Accounts has no leads access: its own five items
  await page.evaluate(() => window.sessionStorage.clear());
  await login(page, USERS.accountsGnt);
  await expect(bar.getByRole("link")).toHaveCount(5);
  for (const item of ["Home", "Invoices", "Payments", "Collections"]) await expect(bar.getByRole("link", { name: item, exact: true })).toBeVisible();
  await expect(bar.getByRole("link", { name: "Leads", exact: true })).toHaveCount(0);

  // The sidebar opens from the header on phones
  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Payments & receipts" })).toBeVisible();
});
