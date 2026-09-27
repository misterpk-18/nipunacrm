import { expect, test } from "@playwright/test";
import { USERS, login, uniquePhone } from "./helpers";

test("wrong password shows a generic error", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill(USERS.salesGnt);
  await page.getByLabel("Password").fill("wrong-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page).toHaveURL(/\/login/);
});

test("roles land on their home screen and see only their menus", async ({ page }) => {
  await login(page, USERS.salesGnt);
  await expect(page).toHaveURL(/\/counsellor/);
  const nav = page.getByRole("navigation", { name: "Main" });
  await expect(nav.getByRole("link", { name: "Leads" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Refunds" })).toHaveCount(0);
  await expect(page.getByLabel("Branch scope")).toBeDisabled();

  await page.goto("/refunds");
  await expect(page.getByText("You don't have access to this screen")).toBeVisible();
});

test("counsellor sees only own-branch leads, opens Lead 360 and logs a follow-up", async ({ page }) => {
  await login(page, USERS.salesGnt);
  await page.goto("/leads?q=Ananya");
  await expect(page.getByRole("link", { name: /Ananya Rao/ })).toBeVisible();
  await page.goto("/leads?q=Karthik");
  await expect(page.getByText("No leads match").filter({ visible: true })).toBeVisible(); // Vijayawada lead is out of scope

  await page.goto("/leads?q=Meghana");
  await page.getByRole("link", { name: /Meghana Varma/ }).click();
  await expect(page.getByRole("heading", { name: "Meghana Varma" })).toBeVisible();
  await expect(page.getByText("New Enquiry → Counselling")).toBeVisible();

  await page.getByLabel("Next follow-up").fill("2030-01-15T11:00");
  await page.getByRole("button", { name: "Log follow-up" }).click();
  await expect(page.getByText("Follow-up logged")).toBeVisible();
  await expect(page.getByText("Counselling call · Interested").first()).toBeVisible();
});

test("create a lead, see it in Lead 360, and a duplicate phone goes to review", async ({ page }) => {
  const phone = uniquePhone();
  await login(page, USERS.salesGnt);
  await page.goto("/leads");
  await page.getByRole("button", { name: "New lead" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name").fill("Playwright Learner");
  await dialog.getByLabel("Primary mobile", { exact: true }).fill(phone);
  await dialog.getByLabel("Course").selectOption({ label: "AWS with DevOps (NIT-CRS-007)" });
  await dialog.getByLabel("Original source").selectOption({ label: "Website" });
  await dialog.getByLabel("Contact channel").selectOption({ label: "Web form" });
  await dialog.getByLabel("Entry method").selectOption({ label: "Website" });
  await dialog.getByRole("button", { name: "Save lead" }).click();
  await expect(page.getByRole("heading", { name: "Playwright Learner" })).toBeVisible();
  await expect(page.getByText("Counsellor A (GNT)").first()).toBeVisible();

  // Same phone again → the API flags it for duplicate review (never merged)
  await page.goto("/leads");
  await page.getByRole("button", { name: "New lead" }).click();
  await dialog.getByLabel("Name").fill("Playwright Duplicate");
  await dialog.getByLabel("Primary mobile", { exact: true }).fill(phone);
  await dialog.getByLabel("Original source").selectOption({ label: "Walk-in" });
  await dialog.getByLabel("Contact channel").selectOption({ label: "In person" });
  await dialog.getByLabel("Entry method").selectOption({ label: "Walk-in desk" });
  await dialog.getByRole("button", { name: "Save lead" }).click();
  await expect(page.getByText(/Duplicate|already/i).first()).toBeVisible();
});

test("branch manager creates an unassigned lead and bulk-assigns it", async ({ page }) => {
  const phone = uniquePhone();
  await login(page, USERS.bmGnt);
  await expect(page).toHaveURL(/\/branch-manager/);
  await page.goto("/leads");
  await page.getByRole("button", { name: "New lead" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name").fill("Walk-in Unassigned");
  await dialog.getByLabel("Primary mobile", { exact: true }).fill(phone);
  await dialog.getByLabel("Original source").selectOption({ label: "Walk-in" });
  await dialog.getByLabel("Contact channel").selectOption({ label: "In person" });
  await dialog.getByLabel("Entry method").selectOption({ label: "Walk-in desk" });
  await dialog.getByRole("button", { name: "Save lead" }).click();
  await expect(page.getByRole("heading", { name: "Walk-in Unassigned" })).toBeVisible();

  await page.goto(`/leads?assigned_to=unassigned&q=${phone}`);
  const row = page.getByRole("row", { name: /Walk-in Unassigned/ });
  await row.getByRole("checkbox").check();
  await page.getByLabel("New owner").selectOption({ label: "Front Office B (GNT) · Front Office" });
  await page.getByRole("button", { name: "Assign", exact: true }).click();
  await expect(page.getByText("Assigned 1 lead(s)")).toBeVisible();
});

test("founder can switch branch scope @mobile", async ({ page }) => {
  await login(page, USERS.founder);
  await page.goto("/leads?q=Karthik");
  await expect(page.getByText("Karthik Reddy").filter({ visible: true }).first()).toBeVisible();
  await page.getByLabel("Branch scope").selectOption({ label: "Guntur" });
  await expect(page.getByText("Karthik Reddy")).toHaveCount(0);
  await page.goto("/leads?q=Ananya");
  await expect(page.getByText("Ananya Rao").filter({ visible: true }).first()).toBeVisible();
});
