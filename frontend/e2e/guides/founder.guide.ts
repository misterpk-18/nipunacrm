import { expect, test, type Locator, type Page } from "@playwright/test";
import { PASSWORD, USERS } from "../helpers";
import { Guide } from "./guide";
import { as, deal, fee, freshAuth, invoiced, mobile, paid, claim, signIn } from "./demo";

/** Hide toasts with CSS (removing sonner's nodes crashes React). */
async function hideToasts(page: Page) {
  await page.addStyleTag({ content: "[data-sonner-toaster]{visibility:hidden !important}" }).catch(() => undefined);
}
async function showToasts(page: Page) {
  await page.evaluate(() => document.querySelectorAll("style").forEach((s) => s.textContent?.includes("data-sonner-toaster]{visibility") && s.remove()));
}

const SURN = ["Pasupuleti", "Gudivada", "Tadepalli", "Kondaveeti", "Mandava", "Vemuri", "Chintala", "Yarlagadda", "Gummadi", "Penmetsa"];
const FORE = ["Harini", "Lokesh", "Anusha", "Venkatesh", "Swathi", "Bhargav", "Jyothi", "Praneeth"];
let nameSeq = 0;
function uniqueName() {
  const n = Date.now() + nameSeq++ * 7919;
  return `${FORE[n % FORE.length]} ${SURN[Math.floor(n / 10) % SURN.length]}`;
}
async function admitted(request: import("@playwright/test").APIRequestContext) {
  const l = await deal(request, { name: uniqueName() });
  const inv = await invoiced(request, l, [5000, 30]);
  const p = await paid(request, l, inv.invoice_id, "5000");
  return { l, inv, payment: p, admission: p.admissions_created[0]! };
}

async function pick(select: Locator, text: string) {
  const value = await select.locator("option", { hasText: text }).first().getAttribute("value");
  await select.selectOption(value!);
}

test.use({ actionTimeout: 20_000 });
test("founder guide", async ({ page, request }) => {
  test.setTimeout(900_000);
  const stamp = String(Date.now()).slice(-6);
  const main = page.locator("main");
  const dialog = page.getByRole("dialog");
  const founderApi = await as(request, USERS.founder);

  // ---- records the workflows need
  const above = await fee(request, await deal(request), 4000, "Final-year student; the family wants a large concession to join this week");
  const corr = await admitted(request);
  const corrAccounts = await as(request, USERS.accountsGnt);
  const corrReason = "Wrong amount keyed in";
  {
    const r = await request.post(`/api/v1/payments/${corr.payment.payment_id}/correction-requests`, { headers: corrAccounts, data: { reason: corrReason } });
    expect(r.ok(), await r.text()).toBeTruthy();
  }
  const refundAdm = await admitted(request);

  // BM registers and assesses the refund case (setup, no screenshots)
  await signIn(page, USERS.bmGnt);
  await page.goto("/refunds");
  await page.getByRole("button", { name: "Register refund case" }).click();
  await dialog.getByLabel("Find admission").fill(refundAdm.l.name);
  const admSel = dialog.getByLabel("Admission", { exact: true });
  await expect(admSel.locator("option", { hasText: refundAdm.l.name }).first()).toBeAttached();
  await pick(admSel, refundAdm.l.name);
  await dialog.getByRole("checkbox", { name: new RegExp(refundAdm.payment.receipt_number) }).check();
  await dialog.getByLabel("Request reason").fill("Learner has taken a job in another city and cannot attend the course");
  await dialog.getByRole("button", { name: "Register case" }).click();
  await expect(page.getByText(/NIT-RF-\d+ registered/)).toBeVisible();
  await page.getByLabel("Assessment notes").fill("Cancelled before the batch started; the full amount paid so far is eligible");
  await page.getByRole("button", { name: "Save assessment" }).click();
  await expect(page.getByText("Assessment saved")).toBeVisible();
  const refundUrl = page.url().replace(/^https?:\/\/[^/]+/, "");

  const g = new Guide(page, {
    role: "founder",
    title: "Founder / CEO & Super Admin",
    subtitle: "Final approvals, company-wide visibility and the settings that run the CRM",
    account: `${USERS.founder} · ${USERS.admin}`,
  });
  await signIn(page, USERS.founder);
  await hideToasts(page);

  // =============================================================== PART 1
  g.overview("What a Founder / CEO and Super Admin does")
    .p("You have the same permissions as a Branch Manager, at every branch, plus the final say on money and the keys to the configuration. The Founder / CEO and the Super Admin can do exactly the same things, with one difference: only a Founder / CEO can grant Founder / CEO access or create a recovery account.")
    .bullets(
      "**Final approvals**: special closing requests with no limit, prices below the 70% floor (with a second approver), payment corrections, fee changes after admission, refund decisions, targets and deletion requests.",
      "**Visibility**: the Founder / CEO dashboard with company totals and a branch comparison, Reports, Target Master and Offer Master.",
      "**Configuration**: users and their access, settings, branch hours and holidays, dropdown lists, concession limits and notification rules.",
      "**Control**: active sessions (force sign-out), integrations and incidents, scheduled reports and the audit log.",
    )
    .rule("Admins are exempt from the usual self-approval and separation blocks (for example, you may approve a fee change you requested and pay out a refund you decided). Your own requests are still recorded in the audit log.");

  g.overview("Signing in and your home screen")
    .p("After signing in you land on the **Workspace overview**, whose **Performance** tab is the Founder / CEO Dashboard. Sign in with your work email and password; this guide uses two accounts, the Founder for approvals and dashboards and the Super Admin for the Admin / Settings screens, which behave the same for both roles.")
    .steps(
      "Open the CRM, type your work email (1) and password (2) and click **Sign in** (3).",
      "You arrive on the **Workspace overview**. The **Overview** tab (1) shows your next actions; the **Performance** tab (2) is the Founder / CEO Dashboard with company KPIs, a branch comparison, the lead funnel and progress against target.",
      "Sensitive actions later ask for your password once more if you last typed it more than 15 minutes ago.",
    );
  await page.goto("/login");
  await page.evaluate(() => window.sessionStorage.clear());
  await page.reload();
  await page.getByLabel("Email").fill(USERS.founder);
  await page.getByLabel("Password").fill(PASSWORD);
  await g.shot("The sign-in screen", [page.getByLabel("Email"), page.getByLabel("Password"), page.getByRole("button", { name: "Sign in" })]);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/);
  await hideToasts(page);
  await expect(page.getByRole("heading", { name: "Workspace overview" })).toBeVisible();
  await page.waitForTimeout(1500);
  await g.shot("The Workspace overview after sign-in", [page.getByRole("tab", { name: "Overview" }), page.getByRole("tab", { name: "Performance" })]);

  g.overview("The menu: what each screen is for")
    .p("The left menu is grouped by area. You see every screen a Branch Manager sees, plus **Admin / Settings** at the bottom of the **More** group. Screens that are not used yet (batches, waiting for batch, LMS access and placement) are hidden.")
    .table(
      ["Menu group / screen", "What you use it for"],
      ["**Workspace**: **Overview**, **My work**", "The Founder / CEO Dashboard and your own to-do list, including approvals waiting for you."],
      ["**Sales**: **Leads**, **Deal pipeline**, **Demos & counselling**", "Look at any branch's leads and deals; step in when a branch needs help."],
      ["**Learning**: **Students**, **Admissions**", "Student 360 and admissions across both branches."],
      ["**Finance**: **Invoices**, **Payments & receipts**, **Collections**, **Refunds**", "The money. Payment corrections are approved in **Payments & receipts**; refund decisions are made in **Refunds**."],
      ["**Operations**: **Tasks**, **Communications**, **WhatsApp messages**, **Reports**", "Team tasks, the inbox, outgoing messages and management reports with scheduled delivery."],
      ["**More**: **Discount Approvals**, **Offer Master**, **Target Master**, **Course Master**, **Admin / Settings**", "Approvals above the Branch Manager's limit, the masters and every system setting."],
    );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.waitForTimeout(500);
  await g.shot("The left menu, grouped by area", [page.getByRole("link", { name: "Refunds" })], { focus: page.locator("aside").first(), pad: 6 });
  await page.setViewportSize({ width: 1440, height: 900 });

  g.overview("Rules and limits the system enforces")
    .table(
      ["Rule", "What it means for you"],
      ["No approval limit", "You can approve any extra concession. Below **70% of the standard fee** the system also needs a second independent approver."],
      ["Two-person rule", "Nobody approves their own request. As an admin you are exempt from self-approval and separation blocks, so you may approve a fee change you requested or pay out a refund you decided."],
      ["Fresh password", "Approving special closing, payment corrections, refunds and targets, activating offers, changing settings and creating or resetting users all ask for your password if you last typed it more than **15 minutes** ago."],
      ["Original records are never edited", "A payment correction adds a linked reversal entry; the original payment stays. Lookup values are deactivated, never deleted."],
      ["Decision time", "A special closing request waits 5 staffed minutes with the Branch Manager, then escalates to you. A timeout never approves."],
      ["Targets", "Only approved targets count. A new approved version replaces the overlapping one and keeps the history."],
    );

  g.overview("A typical day")
    .steps(
      "Open **Overview** and its **Performance** tab, the Founder / CEO Dashboard: collections, admissions, the branch comparison and the AI management brief.",
      "Open **My work** and **Discount Approvals** for anything escalated to you.",
      "In **Payments & receipts**, approve or reject payment corrections raised by Accounts.",
      "In **Refunds**, decide the cases that managers have assessed.",
      "Look at **Reports** for the week and let scheduled reports reach you by email.",
      "When the business changes, adjust **Target Master**, **Offer Master** or a user's access in **Admin / Settings**.",
    );

  // =============================================================== PART 2
  // ---- 1. Your day
  g.workflow("Start your day: Overview and the Founder / CEO Dashboard")
    .p("Do this first. It shows how the whole company is doing and how the two branches compare, before you open any approval queue.")
    .steps(
      "Open **Overview** (1) from the menu and click the **Performance** tab (2). The **Branch scope** selector (3) at the top is set to **All Branches**; choose one branch to narrow the page.",
      "Choose a period with the buttons (4), for example **This Month** or **Last Month**. Every figure refetches for that period.",
      "Click a KPI tile such as **Genuine Enquiries** to open the matching list.",
      "Scroll to **Branch comparison**, the lead funnel and progress against target.",
    );
  await page.goto("/dashboard");
  await page.waitForTimeout(1500);
  await hideToasts(page);
  await page.getByRole("tab", { name: "Performance" }).click();
  await expect(page.getByRole("heading", { name: "Founder / CEO Dashboard" })).toBeVisible();
  await expect(page.getByRole("link", { name: /Genuine Enquiries/ })).toBeVisible();
  const comparison = page.locator("section", { has: page.getByRole("heading", { name: "Branch comparison" }) });
  await expect(comparison.getByRole("cell", { name: "Guntur" })).toBeVisible();
  await hideToasts(page);
  await page.waitForTimeout(800);
  await g.shot("Company KPIs and the period buttons", [page.getByRole("link", { name: /^Overview/ }), page.getByRole("tab", { name: "Performance" }), page.getByLabel("Branch scope"), page.getByRole("button", { name: "This Month", exact: true })]);
  await comparison.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await page.waitForTimeout(400);
  await g.shot("Branch comparison: both branches side by side", [comparison.getByRole("cell", { name: "Guntur" }), comparison.getByRole("cell", { name: "Vijayawada" })], { focus: comparison });
  const funnel = page.getByRole("figure", { name: "Lead funnel by stage" });
  await funnel.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await page.waitForTimeout(400);
  await g.shot("The lead funnel by stage", [funnel], { focus: funnel });
  g.tip("The **AI Management Brief** on the dashboard is advisory: it summarises recorded facts and lists what evidence is missing. Use the **Helpful** or **Missing Context** buttons to tell the team how useful it was.");

  // ---- 2. Special closing above the BM limit
  g.workflow("Approve a special closing request above the Branch Manager's limit")
    .p("A counsellor asks for an extra concession to close a sale. Branch Managers decide requests up to the lower of 5% or ₹1,000; anything above that, or anything a Branch Manager has not decided within 5 staffed minutes, comes to you.")
    .steps(
      "Open **Discount Approvals** (1) under **More**. The **I can approve** tab lists what you may decide.",
      "Click the request (2) to read its terms: standard fee, requested extra concession, final payable and the counsellor's reason.",
      "Check the **Floor (70%)** marker. Below the floor a second independent approver is needed as well.",
      "Click **Approve** (3). In the dialog, add a decision reason (1) and confirm with **Approve** (2).",
      "Type your password when asked. The request becomes **Approved** and the fee version is approved, so the counsellor can issue the invoice.",
    );
  // other guides leave many requests pending: find the page that holds ours
  for (let pg = 1; pg <= 8; pg++) {
    await page.goto(`/discount-approval?id=${above.scr!.scr_id}&page=${pg}`);
    await page.waitForTimeout(1200);
    if (await page.getByRole("row", { name: new RegExp(above.scr!.scr_code) }).count()) break;
  }
  await expect(page.getByRole("row", { name: new RegExp(above.scr!.scr_code) })).toBeVisible();
  await hideToasts(page);
  await page.waitForTimeout(500);
  await g.shot("Discount Approvals with the request open", [
    page.getByRole("link", { name: /^Discount Approvals/ }),
    main.getByRole("row", { name: new RegExp(above.scr!.scr_code) }),
    page.getByRole("button", { name: "Approve", exact: true }),
  ]);
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(dialog).toBeVisible();
  const decisionReason = dialog.getByLabel("Decision reason (optional)");
  await decisionReason.fill("Final-year student paying in full this week; approved above the branch limit");
  await g.shot("The approve dialog", [decisionReason, dialog.getByRole("button", { name: "Approve" })], { focus: dialog });
  await dialog.getByRole("button", { name: "Approve" }).click();
  await freshAuth(page);
  await showToasts(page);
  await expect(page.getByText(/SCR-\S+ approved · version approved/)).toBeVisible();
  await hideToasts(page);
  g.rule("**Counteroffer** lets you offer a smaller extra concession instead of a flat yes or no. **Reject** needs a reason that the counsellor sees.");

  // ---- 3. Payment correction
  g.workflow("Approve a payment correction requested by Accounts")
    .p("Accounts finds a mistake in a verified payment and asks for a correction. The original payment is never edited: when you approve, the system adds a linked reversal entry. Accounts cannot approve its own request, so it comes to you.")
    .steps(
      "Open **Payments & receipts** (1) and click the **Correction requests** tab (2).",
      "Find the request by its receipt and reason. Read who asked and why.",
      "Click **Approve** (3) on the row. The dialog explains that a reversal entry will be added.",
      "Click **Approve & reverse** (1) and type your password if asked. The request shows **Approved** and the invoice gains a **Reversal** row (1), as in the last screenshot.",
    );
  await page.goto("/payments?tab=corrections&cstatus=Pending+Approval");
  const corrRow = page.getByRole("row", { name: new RegExp(corr.payment.receipt_number) });
  await expect(corrRow).toBeVisible();
  await hideToasts(page);
  await page.setViewportSize({ width: 1700, height: 900 });
  await page.waitForTimeout(600);
  await g.shot("Correction requests waiting for approval", [page.getByRole("link", { name: /^Payments & receipts/ }), page.getByRole("tab", { name: "Correction requests" }), corrRow.getByRole("button", { name: "Approve" })]);
  await corrRow.getByRole("button", { name: "Approve" }).click();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(dialog).toBeVisible();
  await g.shot("Confirming the approval", [dialog.getByRole("button", { name: "Approve & reverse" })], { focus: dialog });
  await dialog.getByRole("button", { name: "Approve & reverse" }).click();
  await freshAuth(page);
  await showToasts(page);
  await expect(page.getByText(/approved · reversal/)).toBeVisible();
  await hideToasts(page);
  await page.goto(`/invoices/${corr.inv.invoice_id}`);
  const reversalRow = page.getByRole("row", { name: /Reversal/ }).first();
  await expect(reversalRow).toBeVisible();
  await page.waitForTimeout(500);
  await g.shot("The invoice now shows a linked reversal entry", [reversalRow]);
  g.tip("Collections figures use verified payments minus corrections, so an approved correction changes the dashboard and reports straight away.");

  // ---- 4. Refund decision
  g.workflow("Decide a refund case opened by a Branch Manager")
    .p("A Branch Manager registers a refund case and writes an assessment. You decide how much is refunded; Accounts then pays it out. A refund can never be more than what was verified as paid.")
    .steps(
      "Open **Refunds** (1). The case appears under **Registered** with the manager's assessment.",
      "Open the case. Read the **Request reason**, the linked receipts and the assessment notes.",
      "Type the **Refund amount (₹)** (2) you approve, up to the verified amount.",
      "Click **Record decision** (3) and type your password if asked. The case moves to **Refund Approved** and waits for payout by Accounts.",
    );
  await page.goto(refundUrl);
  const amount = page.getByLabel("Refund amount (₹)");
  await expect(amount).toBeVisible();
  await hideToasts(page);
  await page.waitForTimeout(600);
  await amount.fill("5000");
  await amount.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await page.waitForTimeout(500);
  await g.shot("The refund case with the manager's assessment", [page.getByRole("link", { name: /^Refunds/ }), amount, page.getByRole("button", { name: "Record decision" })]);
  await page.getByRole("button", { name: "Record decision" }).click();
  await freshAuth(page);
  await showToasts(page);
  await expect(page.getByText(/: Refund Approved/)).toBeVisible();
  await g.shot("Decision recorded: awaiting payout by Accounts", []);
  await hideToasts(page);
  g.rule("Decision target: 7 working days from registration. Payout target: 18 working days. Accounts, not you, starts the payout and reconciles it.");

  // ---- 5. Targets
  const year = 2028; // month 05 below
  g.workflow("Set and approve targets in Target Master")
    .p("Targets are monthly goals for verified collections and paid admissions, per branch and for the company. A new version is drafted first and only counts once approved. Approving replaces the overlapping version and keeps the history.")
    .steps(
      "Open **Target Master** (1) under **More**. The top panel shows achievement against the approved target for the current month, and the list below holds every version.",
      "Click **New target version** (2). Never edit an approved version: always draft a new one.",
      "Enter the period, then the company and branch targets (3). Leave a measure blank to keep it **Not Set**.",
      "Click **Save draft** (4). The version appears as **Draft**.",
      "Click **Approve** (5) on its row and confirm. It turns **Approved** and replaces any overlapping version.",
    );
  await page.goto("/target-master");
  await expect(page.getByText("Current achievement")).toBeVisible();
  await hideToasts(page);
  await page.waitForTimeout(600);
  await g.shot("Target Master with current achievement", [page.getByRole("link", { name: /^Target Master/ }), page.getByRole("button", { name: "New target version" })]);
  await page.getByRole("button", { name: "New target version" }).click();
  await dialog.getByLabel("Period start").fill(`${year}-05-01`);
  await dialog.getByLabel("Period end").fill(`${year}-05-31`);
  await dialog.getByLabel("Company collections target").fill("4500000");
  await dialog.getByLabel("Company admissions target").fill("140");
  await dialog.getByLabel("Guntur collections target").fill("2500000");
  await dialog.getByLabel("Guntur admissions target").fill("80");
  await dialog.getByLabel("Vijayawada collections target").fill("2000000");
  await dialog.getByLabel("Vijayawada admissions target").fill("60");
  await g.shot("Drafting a new target version for May " + year, [dialog.getByLabel("Period start"), dialog.getByLabel("Company collections target"), dialog.getByLabel("Guntur collections target"), dialog.getByRole("button", { name: "Save draft" })], { focus: dialog });
  await dialog.getByRole("button", { name: "Save draft" }).click();
  await showToasts(page);
  const saved = page.getByText(new RegExp(`TM-${year}-05-v\\d+ saved as Draft`));
  await expect(saved).toBeVisible();
  const vcode = ((await saved.first().textContent()) ?? "").match(/TM-\d+-05-v\d+/)![0];
  await hideToasts(page);
  const tRow = page.getByRole("row", { name: new RegExp(vcode) });
  await expect(tRow.getByText("Draft")).toBeVisible();
  await tRow.getByRole("button", { name: `Approve ${vcode}` }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Approve", exact: true }).click();
  await freshAuth(page);
  await expect(tRow.getByText("Approved")).toBeVisible();
  await hideToasts(page);
  await page.waitForTimeout(500);
  await tRow.scrollIntoViewIfNeeded();
  await g.shot("The version is now Approved", [tRow], {});
  g.tip("Every approved version stays in the list, so you can always see which target applied in which month.");

  // ---- 6. Offer Master
  const code = `DIWALI-${stamp.slice(-4)}`;
  g.workflow("Create and activate an offer in Offer Master")
    .p("An offer is a discount or a complimentary course that counsellors can attach to a fee version without asking for approval. An active offer cannot be edited: to change it, make a new version.")
    .steps(
      "Open **Offer Master** (1) and click **New offer** (2).",
      "Enter an **Offer code** (1), **Offer name**, **Discount amount (₹)** (2) and the **Valid from** (3) and **Valid to** dates. Click **Create offer** (4).",
      "While it is a draft, use **Scope** to limit the offer to some branches or courses, and **Complimentary courses** to add a free course with a minimum final fee.",
      "Click **Activate** and confirm with your password. Activating a version deactivates any other active version of the same code.",
      "An active offer shows **New version** (1) and **Deactivate** (2) instead of **Edit**. When the offer should stop, click **Deactivate** and confirm.",
    );
  await page.goto("/offer-master");
  await expect(page.getByRole("button", { name: "New offer" })).toBeVisible();
  await hideToasts(page);
  await page.waitForTimeout(600);
  await g.shot("Offer Master", [page.getByRole("link", { name: /^Offer Master/ }), page.getByRole("button", { name: "New offer" })]);
  await page.getByRole("button", { name: "New offer" }).click();
  await dialog.getByLabel("Offer code").fill(code);
  await dialog.getByLabel("Offer name").fill("Diwali early-bird offer");
  await dialog.getByLabel("Discount amount (₹)").fill("500");
  await dialog.getByLabel("Valid from").fill("2026-10-01");
  await dialog.getByLabel("Valid to").fill("2026-11-30");
  await g.shot("The New offer dialog", [dialog.getByLabel("Offer code"), dialog.getByLabel("Discount amount (₹)"), dialog.getByLabel("Valid from"), dialog.getByRole("button", { name: "Create offer" })], { focus: dialog });
  await dialog.getByRole("button", { name: "Create offer" }).click();
  const detail = page.locator("section", { has: page.getByRole("heading", { name: new RegExp(`${code} · v1`) }) });
  await expect(detail).toBeVisible();
  await detail.getByRole("button", { name: "Scope" }).click();
  await dialog.getByLabel("All branches").uncheck();
  await dialog.getByLabel("Vijayawada").check();
  await dialog.getByLabel("All courses").uncheck();
  await dialog.getByLabel(/AWS with DevOps/).check();
  await dialog.getByRole("button", { name: "Save scope" }).click();
  await expect(detail.getByText("Vijayawada")).toBeVisible();
  await page.waitForTimeout(600);
  await detail.getByRole("button", { name: "Activate" }).click();
  await dialog.getByRole("button", { name: "Activate" }).click();
  await freshAuth(page);
  await showToasts(page);
  await expect(page.getByText(`${code} v1 is active`)).toBeVisible();
  await hideToasts(page);
  await page.waitForTimeout(500);
  await g.shot("The offer is active: it can no longer be edited", [detail.getByRole("button", { name: "New version" }), detail.getByRole("button", { name: "Deactivate" })], { focus: detail });
  // deactivate again so other guides' fee screens are unaffected
  await detail.getByRole("button", { name: "Deactivate" }).click();
  await dialog.getByRole("button", { name: "Deactivate" }).click();
  await freshAuth(page);
  await expect(page.getByText(`${code} v1 deactivated`)).toBeAttached();
  g.rule("The offer here is limited to one course at the Vijayawada branch and has been deactivated again after the screenshots. Deactivated offers stay in the list for history.");

  // ---- 7. Users & access (Super Admin)
  await signIn(page, USERS.admin);
  await hideToasts(page);
  const newName = "Sandeep Varma";
  const newEmail = `sandeep.varma.${stamp}@nipuna.test`;
  g.workflow("Create a user, grant access and reset a password")
    .p("Admin / Settings is where you decide who can use the CRM and what they can do. Every account has a role and a branch scope. Passwords are shown only once, when you create or reset an account.")
    .steps(
      "Open **Admin / Settings** (1). The **Users & Access** tab lists every account. Click **New user** (2).",
      "Fill in **Full name** (1), **Email**, **Mobile** (2; required, one active account per number, used for the forgot-password code) and **Role** (3). Branch roles also need a **Branch**; company-wide roles get every branch.",
      "Click **Generate** for a random password, or type one, then click **Create user** (4).",
      "The one-time credentials appear. Click **Copy credentials** (1) or **Download CSV** (2) and give them to the person. They must change the password at first sign-in. Click **Done**.",
      "Open the user and click **Grant access**. Pick the **Role** (1) and **Branch scope** (2), optionally set an expiry date (3) and click **Grant** (4). **Revoke** removes a scope again.",
      "On the user's page, **Grant access** (1) adds scopes and **Reset password** (2) issues a new temporary password; every session of that user is signed out.",
    );
  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "Admin / Settings" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Counsellor A \(GNT\)/ })).toBeVisible();
  await page.waitForTimeout(600);
  await g.shot("Admin / Settings: Users & Access", [page.getByRole("link", { name: "Admin / Settings" }), page.getByRole("button", { name: "New user" })]);
  await page.getByRole("button", { name: "New user" }).click();
  await dialog.getByLabel("Full name").fill(newName);
  await dialog.getByLabel("Email").fill(newEmail);
  await dialog.getByLabel("Mobile").fill(mobile());
  await dialog.getByLabel("Role").selectOption({ label: "Placement Team" });
  await dialog.getByLabel("Branch", { exact: true }).selectOption({ label: "Guntur" });
  await dialog.getByRole("button", { name: "Generate" }).click();
  await g.shot("The New user dialog", [dialog.getByLabel("Full name"), dialog.getByLabel("Mobile"), dialog.getByLabel("Role"), dialog.getByRole("button", { name: "Create user" })], { focus: dialog });
  await dialog.getByRole("button", { name: "Create user" }).click();
  await expect(page.getByRole("heading", { name: "User created" })).toBeVisible();
  await page.waitForTimeout(500);
  await g.shot("The credentials are shown once", [page.getByRole("button", { name: /Copy credentials/ }), page.getByRole("button", { name: "Download CSV" })], { focus: page.getByRole("dialog") });
  await page.getByRole("button", { name: "Done" }).click();
  const detailU = page.locator("section", { has: page.getByRole("heading", { name: newName }) });
  await expect(detailU.getByRole("cell", { name: "Placement Team", exact: true })).toBeVisible();
  await detailU.getByRole("button", { name: "Grant access" }).click();
  const roleSel = dialog.getByLabel("Role");
  await roleSel.selectOption({ label: "Branch Manager" }).catch(async () => roleSel.selectOption({ index: 1 }));
  await dialog.getByLabel("Branch scope").selectOption({ label: "Guntur" });
  await dialog.getByLabel(/Expires/).fill("2027-03-31T18:00");
  await g.shot("Granting a second role with an expiry date", [dialog.getByLabel("Role"), dialog.getByLabel("Branch scope"), dialog.getByLabel(/Expires/), dialog.getByRole("button", { name: "Grant" })], { focus: dialog });
  await dialog.getByRole("button", { name: "Grant" }).click();
  await freshAuth(page);
  await expect(detailU.getByRole("row", { name: /Branch Manager/ })).toBeVisible();
  await hideToasts(page);
  await page.waitForTimeout(500);
  await g.shot("The user's role scopes", [detailU.getByRole("button", { name: "Grant access" }), detailU.getByRole("button", { name: "Reset password" })], { focus: detailU });
  await detailU.getByRole("button", { name: "Reset password" }).click();
  await dialog.getByRole("button", { name: "Reset password", exact: true }).click();
  await freshAuth(page);
  await expect(page.getByRole("heading", { name: "Password reset" })).toBeVisible();
  const resetPassword = (await page.getByLabel("Temporary password").textContent())!.trim();
  await page.getByRole("button", { name: "Done" }).click();
  // the user signs in with the new password, so that force sign-out has a live session to end
  {
    const r = await request.post("/api/v1/auth/login", { data: { email: newEmail, password: resetPassword } });
    expect(r.ok(), await r.text()).toBeTruthy();
  }
  g.rule("You cannot deactivate yourself or change your own access, and only a Founder / CEO can grant Founder / CEO access. Revoke a role scope rather than deleting anything: access history stays in the audit log.");

  // ---- 8. Settings tour (view only)
  g.workflow("Settings, concession limits, notifications and branch hours (view only)")
    .p("These tabs control how the whole CRM behaves. Change them rarely and with care: other roles' deadlines, limits and alerts depend on the current values. This tour only looks; it changes nothing. Saving a setting asks for your password and is recorded in the audit log.")
    .steps(
      "Open **Admin / Settings** and click the **Settings** tab (1). Each row is one setting with its own **Save** button.",
      "Click **Concession limits** (2): the extra concession each role may approve on its own, as the lower of a percentage and a rupee amount. Both blank means unlimited.",
      "Click **Notifications & channels** (3): when each alert warns and escalates, and the WhatsApp, email and phone channels of each branch.",
      "Click **Branches, shifts & holidays** (4): staffed hours and holidays. Every SLA, escalation and working day is counted in these hours only.",
    )
    .table(
      ["Area", "What it controls"],
      ["**Settings**", "Sign-in security (idle timeout 30 min, 12 h maximum session, lock after 5 failed attempts, 10-character passwords), the 15-minute fresh-password window, follow-up and first-contact deadlines, refund targets, report cut-off time and more."],
      ["**Concession limits**", "A Branch Manager may approve up to the lower of 5% or ₹1,000. Founder / CEO and Super Admin are unlimited. Below 70% of the standard fee always needs you plus a second approver."],
      ["**Notifications & channels**", "Payment verification warns Accounts at 25 minutes and escalates to the Branch Manager at 30. Special closing warns the Branch Manager at 4 minutes and escalates to you at 5."],
      ["**Branches, shifts & holidays**", "Currently Monday to Saturday, 9 am to 7 pm at both branches. Holidays are excluded from staffed time."],
      ["**Lookups**", "Dropdown values (lead sources, lost reasons, payment modes). You can add, rename and deactivate; values are never deleted."],
    );
  await page.goto("/admin?tab=settings");
  await expect(page.getByLabel("alumni_support_months", { exact: true })).toBeVisible();
  await hideToasts(page);
  await page.waitForTimeout(800);
  await g.shot("The Settings tab", [page.getByRole("tab", { name: "Settings" }), page.getByRole("tab", { name: "Concession limits" }), page.getByRole("tab", { name: "Notifications & channels" }), page.getByRole("tab", { name: "Branches, shifts & holidays" })]);
  await page.getByRole("tab", { name: "Concession limits" }).click();
  await page.waitForTimeout(1000);
  await g.shot("Concession limits by role", [page.getByRole("tab", { name: "Concession limits" })]);
  await page.getByRole("tab", { name: "Notifications & channels" }).click();
  await page.waitForTimeout(1000);
  await g.shot("Notification and escalation rules", [page.getByRole("tab", { name: "Notifications & channels" })]);
  await page.getByRole("tab", { name: "Branches, shifts & holidays" }).click();
  await expect(page.getByLabel("Monday opens")).toBeVisible();
  await page.waitForTimeout(800);
  await g.shot("Branch hours and holidays", [page.getByLabel("Monday opens")]);
  g.warn("Look, do not change: other roles' screens, deadlines and approval limits follow these values immediately.");

  // ---- 9. Sessions, deletion requests, audit log
  g.workflow("Force sign-out, deletion requests and the audit log")
    .p("Use these tabs to see who is signed in, to end a session that should not continue, to approve sensitive deletions and to find out who did what.")
    .steps(
      "Open **Sessions & deletions** (1). **Active sessions** lists who is signed in, from where and until when. Your own row says **This session**.",
      "To end someone else's session (for example after a lost laptop), click **Sign out** (2) on their row and confirm. They are signed out immediately.",
      "Further down, **Deletion requests** are listed. One admin requests a deletion with a **Record ID** and **Deletion reason**; a **different** admin approves it and then executes it.",
      "Open **Audit log** (3). Every sensitive event is recorded: approvals, password resets, setting changes. Type an **Action** such as `DELETION_APPROVED` (4) and click **Filter** to narrow it down.",
    );
  await page.goto("/admin?tab=security");
  await expect(page.getByRole("heading", { name: "Active sessions" })).toBeVisible();
  const sessRow = page.getByRole("row", { name: new RegExp(newEmail.replace(/\./g, "\\.")) });
  await expect(sessRow).toBeVisible();
  await hideToasts(page);
  await page.waitForTimeout(600);
  await g.shot("Active sessions", [page.getByRole("tab", { name: "Sessions & deletions" }), sessRow.getByRole("button", { name: /Sign out/ })]);
  await sessRow.getByRole("button", { name: /Sign out/ }).click();
  await dialog.getByRole("button", { name: "Sign out", exact: true }).click();
  await freshAuth(page);
  await showToasts(page);
  await expect(page.getByText("Session signed out")).toBeVisible();
  await hideToasts(page);
  const delReq = page.getByLabel("Record ID");
  const delSec = page.locator("section", { has: page.getByRole("heading", { name: "Deletion requests" }) });
  await delSec.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await page.waitForTimeout(400);
  await g.shot("Deletion requests: one admin asks, a different admin approves", [delReq, page.getByLabel("Deletion reason"), page.getByRole("button", { name: "Request deletion" })], { focus: delSec });
  await page.getByRole("tab", { name: "Audit log" }).click();
  await expect(page.getByRole("row").nth(1)).toBeVisible();
  await page.waitForTimeout(1000);
  await g.shot("The audit log", [page.getByRole("tab", { name: "Audit log" }), page.getByLabel("Action")]);
  // tidy up: deactivate the sample account
  await page.goto("/admin");
  await page.getByPlaceholder("Name or email").fill(newEmail);
  await page.getByRole("button", { name: new RegExp(newEmail.replace(/\./g, "\\.")) }).click();
  const d2 = page.locator("section", { has: page.getByRole("heading", { name: newName }) });
  await d2.getByRole("button", { name: "Deactivate" }).click();
  await dialog.getByRole("button", { name: "Deactivate" }).click();
  await freshAuth(page);
  await expect(d2.getByRole("button", { name: "Reactivate" })).toBeVisible();
  g.tip("When someone leaves, use **Deactivate** on their user: they are signed out at once and their records stay.");

  // ---- 10. Reports and scheduled reports
  g.workflow("Reports and scheduled reports")
    .p("Reports answer how the business is doing: collections, the lead funnel, performance by course, source and staff, and response-time compliance. A scheduled report sends the same figures by email on a fixed day.")
    .steps(
      "Open **Reports** (1). Pick the period with the buttons (2) and narrow with the filters.",
      "Use **Performance by** to switch between course, source and staff. Click **Export management CSV** (3) to download the figures.",
      "Scroll to **Scheduled reports** and click **New schedule** (1). Choose **Frequency**, **Schedule day** and **Recipients**, then click **Save schedule**.",
      "Each schedule has a switch. Turn it off to pause delivery without deleting it.",
    );
  g.tip("Reports count verified payments minus corrections, by payment date and collecting branch. Pending payments are never counted.");
  await page.goto("/reports");
  await expect(page.getByText("Verified collections · net")).toBeVisible();
  await hideToasts(page);
  await page.waitForTimeout(800);
  await g.shot("Reports", [page.getByRole("link", { name: /^Reports/ }), page.getByRole("button", { name: "This Month", exact: true }), page.getByRole("button", { name: "Export management CSV" })]);
  const newSched = page.getByRole("button", { name: "New schedule" });
  await newSched.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await page.waitForTimeout(400);
  await g.shot("Scheduled reports", [newSched], { focus: page.locator("section", { has: page.getByRole("heading", { name: "Scheduled reports" }) }) });
  await newSched.click();
  await dialog.getByLabel("Frequency").selectOption("Weekly");
  await dialog.getByLabel("Schedule day").fill("1");
  const rcpt = `leadership.${stamp}@nipuna.in`;
  await dialog.getByLabel("Recipients").fill(rcpt);
  await g.shot("The New scheduled report dialog", [dialog.getByLabel("Frequency"), dialog.getByLabel("Recipients"), dialog.getByRole("button", { name: "Save schedule" })], { focus: dialog });
  await dialog.getByRole("button", { name: "Save schedule" }).click();
  const srow = page.getByRole("row", { name: new RegExp(rcpt.replace(/\./g, "\\.")) });
  await expect(srow).toBeVisible();
  await srow.getByRole("switch").click();
  await showToasts(page);
  await expect(page.getByText(/report paused/)).toBeVisible();
  await hideToasts(page);
  await srow.scrollIntoViewIfNeeded();
  await g.shot("The schedule, switched off (paused)", [srow.getByRole("switch")]);

  g.save();
});
