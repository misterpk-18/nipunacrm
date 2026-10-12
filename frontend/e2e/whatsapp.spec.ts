import { expect, test, type Page } from "@playwright/test";
import { PASSWORD, USERS, apiToken, login, uniquePhone } from "./helpers";

async function switchUser(page: Page, email: string) {
  await page.goto("/login");
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await login(page, email);
}

// WhatsApp (db 033/034): the message list, the Person 360 tab with consent, and sending a marketing template from Lead 360.
// Sending itself is switched off on the dev stack (WHATSAPP_ENABLED=0), so messages stay Queued; nothing leaves the machine.

test("WhatsApp: a new enquiry's message shows on the list and the person tab; consent unlocks a template", async ({ page, request }) => {
  const sales = await apiToken(request, USERS.salesGnt);
  const lookups = (await (await request.get("/api/v1/lookups", { headers: sales })).json()).data as Record<string, { id: number; code: string }[]>;
  const id = (list: string, code: string) => lookups[list]!.find((x) => x.code === code)!.id;
  const name = `Wa Learner ${Date.now().toString().slice(-6)}`;
  const created = await request.post("/api/v1/leads", {
    headers: sales,
    data: {
      branch_id: 1,
      person: { full_name: name, phone: uniquePhone() },
      course_id: 4,
      lead_source_id: id("lead_sources", "GOOGLE_ADS"),
      contact_channel_id: id("contact_channels", "WEB_FORM"),
      entry_method_id: id("entry_methods", "GOOGLE_ADS_FORM"),
    },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  const lead = (await created.json()).data as { lead_id: number; person: { person_id: number } };

  // The list: the acknowledgement was saved with the lead, and sending is off
  await login(page, USERS.bmGnt);
  await page.goto("/whatsapp");
  await expect(page.getByRole("heading", { name: "WhatsApp messages" })).toBeVisible();
  await expect(page.getByText(/switched off|not configured/i).first()).toBeVisible();
  await page.getByLabel("Search messages").fill(name);
  const row = page.getByRole("row", { name: new RegExp(name) });
  await expect(row).toBeVisible();
  await expect(row).toContainText("Queued");
  await row.click();
  await expect(page.getByRole("dialog")).toContainText("has received your enquiry");
  await page.keyboard.press("Escape");

  // Person 360 → WhatsApp: the conversation and the consent card
  await page.goto(`/persons/${lead.person.person_id}`);
  await page.getByRole("tab", { name: "WhatsApp" }).click();
  await expect(page.getByText("has received your enquiry").first()).toBeVisible();
  await expect(page.getByText("Not Recorded").first()).toBeVisible();

  // Lead 360: the template can't be sent without consent, then can be
  await switchUser(page, USERS.salesGnt);
  await page.goto(`/leads/${lead.lead_id}`);
  await page.getByRole("button", { name: "Send template" }).click();
  await page.locator("#tpl-key").selectOption({ label: "Course brochure" });
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  await page.getByRole("dialog").getByRole("button", { name: "Record consent" }).click();
  await page.getByLabel(/Where did they agree/).fill("E2E counsellor call");
  await page.getByRole("button", { name: "Record consent" }).last().click();
  await expect(page.getByRole("dialog").getByText("Explicit Consent")).toBeVisible();
  await page.locator("#tpl-key").selectOption({ label: "Course brochure" });
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeHidden();

  // The marketing message is on the list, as Marketing
  await switchUser(page, USERS.bmGnt);
  await page.goto("/whatsapp?category=Marketing");
  await page.getByLabel("Search messages").fill(name);
  await expect(page.getByRole("row", { name: new RegExp(name) })).toContainText("Queued");
  expect(PASSWORD).toBeTruthy();
});
