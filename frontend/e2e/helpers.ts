import { expect, type Page } from "@playwright/test";

export const PASSWORD = "Nipuna-staging-1";

/** Staging accounts created by `flask seed-dev` (all use PASSWORD). */
export const USERS = {
  founder: "founder@nipuna.test",
  admin: "admin@nipuna.test",
  bmGnt: "bm.gnt@nipuna.test",
  bmVij: "bm.vij@nipuna.test",
  salesGnt: "sales.gnt@nipuna.test",
  salesVij: "sales.vij@nipuna.test",
  foGnt: "fo.gnt@nipuna.test",
  accountsGnt: "accounts.gnt@nipuna.test",
  accountsVij: "accounts.vij@nipuna.test",
  coordGnt: "coordinator.gnt@nipuna.test",
  trainerG1: "trainer.g1@nipuna.test",
  placementGnt: "placement.gnt@nipuna.test",
} as const;

export async function login(page: Page, email: string, password = PASSWORD) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

/** A unique 10-digit mobile for records created by a test run. */
export function uniquePhone() {
  return `9${String(Date.now()).slice(-9)}`;
}
