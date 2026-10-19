import { expect, test, type Locator } from "@playwright/test";
import { PASSWORD, USERS } from "../helpers";
import { Guide, dismissToasts } from "./guide";
import { as, deal, fee, freshAuth, invoiced, lead, paid, signIn } from "./demo";

/** Choose the option whose text contains `text` (option labels carry the role after the name). */
async function pick(select: Locator, text: string) {
  const value = await select.locator("option", { hasText: text }).first().getAttribute("value");
  await select.selectOption(value!);
}

async function admitted(request: import("@playwright/test").APIRequestContext) {
  const l = await deal(request);
  const inv = await invoiced(request, l, [5000, 30]);
  const p = await paid(request, l, inv.invoice_id, "5000");
  return { l, inv, payment: p, admission: p.admissions_created[0]! };
}

test("branch manager guide", async ({ page, request }) => {
  test.setTimeout(420_000);
  page.setDefaultTimeout(20_000);
  const bm = await as(request, USERS.bmGnt);

  // ---- records the workflows need (built before the first screenshot so every list is already loaded)
  const unassigned = [await lead(request, { by: USERS.bmGnt, source: "Website", channel: "Web form", entry: "Staff entered" })];
  for (const source of ["Google Ads", "Meta Ads"] as const)
    unassigned.push(await lead(request, { by: USERS.bmGnt, source, channel: "Web form", entry: source === "Google Ads" ? "Google Ads form" : "Staff entered" }));
  const within = await fee(request, await deal(request), 500, "Two friends joining together; asked for a small concession to close today");
  const rejectMe = await fee(request, await deal(request), 700, "Asked for a better price after comparing with another institute");
  const above = await fee(request, await deal(request), 4000, "Final-year student; the family wants a large concession to join this week");
  const moveCard = await deal(request);
  const lostLead = await lead(request);
  const lostReasons = (await (await request.get("/api/v1/lookups", { headers: bm })).json()).data.lost_reasons as { id: number; label: string }[];
  const lostRes = await request.post(`/api/v1/leads/${lostLead.lead_id}/lost`, {
    headers: lostLead.headers,
    data: { lost_reason_id: lostReasons.find((r) => r.label === "Batch timing not suitable")!.id, lost_notes: "Wanted weekend batches only" },
  });
  expect(lostRes.ok(), await lostRes.text()).toBeTruthy();
  const stopLead = await lead(request);
  const stopRes = await request.post(`/api/v1/leads/${stopLead.lead_id}/outcome`, {
    headers: stopLead.headers,
    data: { channel: "Call", outcome: "Stop contact", note: "Asked us not to call again; will message us when ready" },
  });
  expect(stopRes.ok(), await stopRes.text()).toBeTruthy();
  const cancelAdm = await admitted(request);
  const transferAdm = await admitted(request);
  const refundAdm = await admitted(request);

  const g = new Guide(page, {
    role: "branch-manager",
    title: "Branch Manager",
    subtitle: "Run your branch: assign leads, approve concessions, watch the pipeline, manage admissions and follow the money",
    account: USERS.bmGnt,
  });
  await signIn(page, USERS.bmGnt);
  const main = page.locator("main");
  const dialog = page.getByRole("dialog");

  // =============================================================== PART 1
  g.overview("What a Branch Manager does")
    .p("The Branch Manager (BM) runs one branch day to day. You keep leads moving by giving every enquiry an owner, you decide discount requests that fall within your limit, you watch the pipeline and the money coming in, and you handle changes to admissions such as cancellations and transfers.")
    .p("You can do everything a counsellor can do on leads and deals, and on top of that you have manager tools: assigning leads, changing a pipeline card's owner, approving special closing requests, reactivating lost leads and clearing a stop-contact flag.")
    .bullets(
      "**Team and leads**: assign and bulk-assign leads, reactivate lost leads, clear a stop-contact flag.",
      "**Approvals**: special closing requests up to your concession limit; fee versions; third demos; next-course paths.",
      "**Admissions**: cancel an admission or transfer it to the other branch; pause and resume an enrolment.",
      "**Money**: see payments, collections and promises; open and withdraw refund cases.",
      "**Visibility**: Reports, and read-only Target Master and Offer Master.",
    )
    .rule("Your scope is your own branch (Guntur here). You do not see the other branch's leads, deals or money.");

  g.overview("Signing in and your home screen")
    .p("After signing in you land on the **Branch Manager** view. It is built for the start of the day: how your branch is doing and which queues need you.")
    .steps(
      "Open the CRM and sign in with your work email and password.",
      "You arrive on **Branch Manager**. Check the **Team queues** (1) first: approvals pending, unassigned leads, overdue tasks and payments waiting for verification.",
      "Each queue is a link. Click one to open the matching list, already filtered. The **Leads** menu item (2) also shows how many leads are waiting.",
    );
  await page.goto("/login");
  await page.evaluate(() => window.sessionStorage.clear());
  await page.reload();
  await page.getByLabel("Email").fill(USERS.bmGnt);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/branch-manager/);
  await expect(page.getByRole("heading", { name: "Branch Manager Dashboard" })).toBeVisible();
  const queues = page.locator("section", { has: page.getByRole("heading", { name: "Team queues" }) });
  await expect(queues.getByText("Unassigned leads")).toBeVisible();
  await dismissToasts(page);
  await g.shot("The Branch Manager view after sign-in", [queues, page.getByRole("link", { name: /^Leads/ }).first()], {});

  g.overview("The menu: what each screen is for")
    .p("The left menu is grouped by area. Screens that are not used in this branch yet are hidden. Academic scheduling (batches and waiting-for-batch lists) is run in the LMS for now, so you will not see those screens here.")
    .table(
      ["Menu group / screen", "What you use it for"],
      ["**Overview**, **My work**", "Your dashboard and your own to-do list (tasks, follow-ups, approvals waiting for you)."],
      ["**Leads**, **Deal pipeline**", "Assign leads, follow up, watch every deal by stage and change a card's owner."],
      ["**Demos & counselling**", "Demo classes booked for your branch."],
      ["**Students**, **Admissions**", "Student 360 and admissions; cancel or transfer from the admission sheet."],
      ["**Invoices**, **Payments & receipts**, **Collections**, **Refunds**", "See the money. Accounts verifies payments; you open refund cases."],
      ["**Tasks**, **Communications**, **Reports**", "Team tasks (reassign, cancel), the inbox and branch reports."],
      ["**More**: **Branch Manager**, **Discount Approvals**, **Offer Master**, **Target Master**, **Sales playbook**, **Ask Nipuna**", "Manager tools. Offer Master and Target Master are read-only for you."],
    );
  await g.shot("The left menu, grouped by area", [page.getByRole("link", { name: "Deal pipeline" }), page.getByRole("link", { name: "Refunds" })], {});

  g.overview("Rules and limits the system enforces")
    .table(
      ["Rule", "What it means for you"],
      ["Concession limit", "You can approve an extra concession up to the **lower of 5% or ₹1,000** of the standard fee. Anything above goes to the Founder / CEO or Super Admin."],
      ["Two-person rule", "Nobody approves their own request. A counsellor raises, you decide. If you raise something yourself, someone else must decide it."],
      ["Fresh password", "Sensitive decisions ask you to type your password again, even though you are signed in."],
      ["70% floor", "A price below 70% of the standard fee always needs the Founder / Super Admin plus a second independent approver."],
      ["Decision time", "Special closing requests should be decided within 5 staffed minutes: a warning at 4, escalation to the Founder / Super Admin at 5. A timeout never approves."],
      ["You cannot", "Verify payments, decide refunds, approve fee changes after admission, create or activate offers, or open Admin / Settings."],
    )
    .tip("The system creates a task for you for every unassigned lead (due in 60 staffed minutes), and you are the escalation point for payments waiting longer than 30 minutes and enquiries nobody has attempted within 10 staffed minutes.");

  g.overview("A typical day")
    .steps(
      "Start on **Branch Manager**: check **Team queues** and **My work**.",
      "Assign every unassigned lead to a counsellor or front-office colleague.",
      "Open **Discount Approvals** and decide what is waiting; keep an eye on the 5-minute target.",
      "Look at the **Deal pipeline** for stuck cards and rebalance owners if a counsellor is away.",
      "Check **Payments & receipts** and **Collections** for anything late; ask Accounts about unverified claims.",
      "Handle admission changes (cancellations, transfers) and refund cases as they come in.",
      "End the day on **Reports** to see how the branch is doing against target.",
    );

  // =============================================================== PART 2
  // ---- 1. Your day
  g.workflow("Start your day: Branch Manager view and My work")
    .p("Do this first thing. It tells you where the branch needs you before you open any list.")
    .steps(
      "Open the **Branch Manager** view (it is also where you land after sign-in).",
      "Read the **Team queues** (1): each line is a count, and clicking it opens the matching list.",
      "Open **My work** (1 in the second screen) to see what is yours personally: follow-ups, callbacks and tasks due today.",
    );
  await page.goto("/branch-manager");
  await expect(page.getByRole("heading", { name: "Team queues" })).toBeVisible();
  await expect(page.getByText("Top staff")).toBeVisible();
  await dismissToasts(page);
  await g.shot("Branch KPIs and team queues", [queues], { focus: queues, pad: 12 });
  await page.goto("/my-work");
  await expect(page.getByRole("heading", { name: /My work/i }).first()).toBeVisible();
  await dismissToasts(page);
  await g.shot("My work: your personal to-do list", [page.getByRole("heading", { name: /My work/i }).first()]);
  g.tip("Click **Unassigned leads** in the team queues to jump straight to the leads that still need an owner.");

  // ---- 2. Assign leads
  g.workflow("Assign an unassigned lead, and bulk-assign several")
    .p("An enquiry nobody owns is not being worked. Give each one to a counsellor as soon as it arrives. You can assign one lead from its page, or several at once from the list.")
    .steps(
      "Open **Leads** and set **Assigned** to **Unassigned**, or click **Unassigned leads** in the team queues.",
      "Tick the leads you want to give out (1). A bar appears showing how many are selected.",
      "Choose the **New owner** (2) and click **Assign** (3). All selected leads move to that person and a message confirms it.",
      "For a single lead, open it and click **Reassign** (1 in the next screen). Choose the **New owner** (1) and click **Reassign** (2).",
    );
  await page.goto("/leads?assigned_to=unassigned");
  await expect(main.getByRole("row", { name: new RegExp(unassigned[0]!.name) })).toBeVisible();
  await dismissToasts(page);
  const assignedFilter = main.getByLabel("Assigned", { exact: true });
  const bulkFirst = page.locator("tr").filter({ hasText: unassigned[1]!.name }).getByRole("checkbox").first();
  await bulkFirst.check();
  await page.locator("tr").filter({ hasText: unassigned[2]!.name }).getByRole("checkbox").first().check();
  const owner = page.getByLabel("New owner");
  await expect(owner).toBeVisible();
  await pick(owner, "Counsellor A (GNT)");
  await owner.evaluate((e) => e.scrollIntoView({ block: "center" }));
  await g.shot("Leads filtered to Unassigned, two selected, owner chosen", [bulkFirst, owner, page.getByRole("button", { name: "Assign", exact: true })], {});
  await page.getByRole("button", { name: "Assign", exact: true }).click();
  await expect(page.getByText(/Assigned 2 lead\(s\)/)).toBeVisible();
  void assignedFilter;
  await dismissToasts(page);
  await page.goto(`/leads/${unassigned[0]!.lead_id}`);
  await expect(page.getByRole("heading", { name: unassigned[0]!.name })).toBeVisible();
  const reassign = page.getByRole("button", { name: "Reassign" });
  await g.shot("Lead 360 of an unassigned lead, with the Reassign button", [reassign]);
  await reassign.click();
  await expect(dialog.getByText("Reassign lead")).toBeVisible();
  const newOwner = dialog.locator("select").first();
  await pick(newOwner, "Front Office B (GNT)");
  await g.shot("Choosing the new owner", [newOwner, dialog.getByRole("button", { name: "Reassign" })], { focus: dialog });
  await dialog.getByRole("button", { name: "Reassign" }).click();
  await expect(page.getByText("Lead reassigned")).toBeVisible();
  g.rule("Owners are branch-scoped: you can only select leads from one branch at a time and assign them to people in that branch.")
    .tip("Ownership history is kept in the lead's timeline, so you can always see who had the lead before.");

  // ---- 3. Approve a special closing request
  g.workflow("Approve a special closing request within your limit")
    .p("When a counsellor needs to give an extra concession to close a sale, they raise a special closing request. You decide it. Within your limit you can approve it yourself.")
    .steps(
      "Open **Discount Approvals** (under **More**). The **I can approve** tab (1) lists requests you may decide.",
      "Click a request to read its terms on the right: standard fee, requested extra, final payable and the counsellor's reason.",
      "Check that the extra is within your limit and that **Floor (70%)** is not marked below.",
      "Click **Approve** (2). In the dialog add a **Decision reason** (1) and click **Approve** (2).",
      "Type your password when asked. A message confirms the request is **Approved**, and the fee version is approved so the counsellor can invoice.",
    );
  await page.goto(`/discount-approval?id=${within.scr!.scr_id}`);
  await expect(page.getByRole("heading", { name: new RegExp(`${within.scr!.scr_code} ·`) })).toBeVisible();
  await dismissToasts(page);
  await g.shot("Discount Approvals with a request selected", [
    page.getByRole("tab", { name: "I can approve" }),
    page.getByRole("button", { name: "Approve", exact: true }),
  ]);
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Decision reason (optional)").fill("Within my limit; student is ready to pay this week");
  await g.shot("The approve dialog with a reason", [dialog.getByLabel("Decision reason (optional)"), dialog.getByRole("button", { name: "Approve" })], { focus: dialog });
  await dialog.getByRole("button", { name: "Approve" }).click();
  await freshAuth(page);
  await expect(page.getByText(/SCR-\S+ approved · version approved/)).toBeVisible();
  g.rule("Approving needs a fresh password confirmation, and you can never approve a request you raised yourself.")
    .tip("**Counteroffer** lets you offer a lower extra concession instead of a flat yes or no. The counsellor then saves a new version at your amount.");

  // ---- 4. Reject, and above limit
  g.workflow("Reject a request, and what happens above your limit")
    .p("If the concession is not justified, reject it with a reason. If it is above your limit it is not yours to approve: it goes to the Founder / CEO or Super Admin.")
    .steps(
      "Select the request in **Discount Approvals** and click **Reject**.",
      "Type a **Reason** (1). It is required and the counsellor sees it. Click **Reject** (2) and confirm with your password.",
      "Open the **Needs higher approval** tab (1). Requests above your limit sit here for the Founder / Super Admin; you can read them but the system will not let you approve them.",
    );
  await page.goto(`/discount-approval?id=${rejectMe.scr!.scr_id}`);
  await expect(page.getByRole("heading", { name: new RegExp(`${rejectMe.scr!.scr_code} ·`) })).toBeVisible();
  await page.getByRole("button", { name: "Reject" }).click();
  await expect(dialog).toBeVisible();
  const reason = dialog.getByLabel("Reason");
  await reason.fill("Concession is not justified; the standard fee already has a seasonal offer");
  await g.shot("Rejecting with a reason", [reason, dialog.getByRole("button", { name: "Reject" })], { focus: dialog });
  await dialog.getByRole("button", { name: "Reject" }).click();
  await freshAuth(page);
  await expect(page.getByText(`${rejectMe.scr!.scr_code} rejected`)).toBeVisible();
  await dismissToasts(page);
  await page.goto(`/discount-approval?queue=higher_approval&id=${above.scr!.scr_id}`);
  await expect(page.getByRole("heading", { name: new RegExp(`${above.scr!.scr_code} ·`) })).toBeVisible();
  await dismissToasts(page);
  await g.shot("A request above your limit: Needs higher approval", [
    page.getByRole("tab", { name: "Needs higher approval" }),
  ]);
  g.rule("Your limit is the **lower of 5% or ₹1,000** of the standard fee. A request that is bigger than this, or that is not decided within 5 staffed minutes, escalates to the Founder / CEO or Super Admin automatically.")
    .tip("A price below 70% of the standard fee always needs the Founder / Super Admin plus a second independent approver, whatever the amount.");

  // ---- 5. Pipeline
  g.workflow("Watch the pipeline and change a card's owner")
    .p("The **Deal pipeline** shows every deal in your branch by stage. Only managers can change who owns a card, for example when a counsellor is away or overloaded.")
    .steps(
      "Open **Deal pipeline**. The stage chips (1) show how many deals are at each stage. Use **Owner**, **Priority** or the search box to narrow the board.",
      "Find the card and click the small **Manage** icon (1 in the next screen).",
      "Choose the **Owner** (1) and, if needed, set the **Next follow-up**. Click **Save** (2).",
      "The card now shows its new owner at the bottom.",
    );
  await page.goto("/pipeline");
  await expect(page.getByRole("heading", { name: "Deal pipeline" })).toBeVisible();
  await expect(page.getByRole("article").first()).toBeVisible();
  await dismissToasts(page);
  await g.shot("The Deal pipeline board for your branch", [page.getByRole("group", { name: "Stage filter" })]);
  await page.goto(`/pipeline?q=${moveCard.phone}`);
  const card = page.getByRole("article", { name: moveCard.name });
  await expect(card).toBeVisible();
  const manage = page.getByRole("button", { name: `Manage ${moveCard.name}` });
  await g.shot("Searching for a card and its Manage icon", [manage], { focus: card, pad: 40 });
  await manage.click();
  await expect(dialog).toBeVisible();
  const cardOwner = dialog.getByLabel("Card owner");
  await pick(cardOwner, "Front Office B (GNT)");
  await g.shot("Changing the card owner", [cardOwner, dialog.getByRole("button", { name: "Save" })], { focus: dialog });
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Card updated")).toBeVisible();
  await dismissToasts(page);
  g.rule("A counsellor can move a card's follow-up but not its owner: the dialog tells them \"only a branch manager can change it\".");

  // ---- 6. Reactivate lost lead & clear stop contact
  g.workflow("Reactivate a lost lead and clear a stop-contact flag")
    .p("Two things only a manager can undo. A lost lead can come back if the learner is interested again. A stop-contact flag blocks all outreach until the learner asks to be contacted.")
    .steps(
      "Open the lost lead (find it in **Leads** with **Lead status** set to **Inactive** or **All**). Its stage shows **Lost - closed**.",
      "Click **Reactivate** (1). Choose the stage to **Return to** (1 in the next screen) and an optional next follow-up. Click **Reactivate** (2).",
      "For a stop-contact flag, open the lead. A warning (1) tells you since when and why. Click **Clear** (2), type the reason (1) and click **Clear stop contact** (2).",
    );
  await page.goto(`/leads/${lostLead.lead_id}`);
  await expect(page.getByRole("heading", { name: lostLead.name })).toBeVisible();
  const reactivate = page.getByRole("button", { name: "Reactivate", exact: true });
  await expect(reactivate).toBeVisible();
  await dismissToasts(page);
  await g.shot("A lost lead, with the Reactivate button", [reactivate]);
  await reactivate.click();
  await expect(dialog.getByText("Reactivate lead")).toBeVisible();
  await dialog.locator("select").first().selectOption("New Enquiry");
  await g.shot("Choosing the stage to return to", [dialog.locator("select").first(), dialog.getByRole("button", { name: "Reactivate" })], { focus: dialog });
  await dialog.getByRole("button", { name: "Reactivate" }).click();
  await expect(page.getByText("Lead reactivated")).toBeVisible();
  await dismissToasts(page);

  await page.goto(`/leads/${stopLead.lead_id}`);
  await expect(page.getByRole("heading", { name: stopLead.name })).toBeVisible();
  const warning = page.getByText(/Stop contact since/);
  const clear = page.getByRole("button", { name: "Clear", exact: true });
  await expect(clear).toBeVisible();
  await dismissToasts(page);
  await g.shot("A lead with a stop-contact flag", [warning, clear]);
  await clear.click();
  await expect(dialog.getByText("Clear stop contact").first()).toBeVisible();
  const clearReason = dialog.locator("textarea");
  await clearReason.fill("Learner called the front desk and asked us to share batch details again");
  await g.shot("Clearing the flag with a reason", [clearReason, dialog.getByRole("button", { name: "Clear stop contact" })], { focus: dialog });
  await dialog.getByRole("button", { name: "Clear stop contact" }).click();
  await expect(page.getByText("Stop contact cleared")).toBeVisible();
  g.rule("Clear a stop-contact flag only when the learner has asked to be contacted again. The reason is kept in the audit trail.");

  // ---- 7. Admissions
  g.workflow("Cancel or transfer an admission")
    .p("After a learner is admitted, a manager may have to cancel the admission (for example the learner relocates) or move it to the other branch. Both are manager-only actions and both need a reason.")
    .steps(
      "Open **Admissions** and click the admission. The **Admission detail** sheet opens.",
      "To cancel, click **Cancel admission** (1). Type the **Cancellation reason** (1) and click **Cancel admission** (2).",
      "To move it to another branch, click **Transfer** on the same sheet. Choose **To branch** (1), write the **Transfer reason** (2) and click **Save** (3).",
    );
  await page.goto(`/admissions?admission=${cancelAdm.admission.admission_id}`);
  const sheet = page.getByRole("dialog", { name: "Admission detail" });
  await expect(sheet.getByText(cancelAdm.admission.admission_code).first()).toBeVisible();
  await dismissToasts(page);
  const cancelBtn = sheet.getByRole("button", { name: "Cancel admission" });
  await g.shot("The admission sheet with Cancel admission", [cancelBtn]);
  await cancelBtn.click();
  const cancelDlg = page.getByRole("dialog", { name: `Cancel ${cancelAdm.admission.admission_code}?` });
  const cancelReason = cancelDlg.getByLabel("Cancellation reason");
  await cancelReason.fill("Learner relocated to another city before the course started");
  await g.shot("Cancelling with a reason", [cancelReason, cancelDlg.getByRole("button", { name: "Cancel admission" })], { focus: cancelDlg });
  await cancelDlg.getByRole("button", { name: "Cancel admission" }).click();
  await expect(sheet.getByText(/Cancelled .* Learner relocated/)).toBeVisible();
  await dismissToasts(page);
  await g.shot("The admission now shows as Cancelled", [], { focus: sheet, pad: 0 });

  await page.goto(`/admissions?admission=${transferAdm.admission.admission_id}`);
  await expect(sheet.getByText(transferAdm.admission.admission_code).first()).toBeVisible();
  const transferBtn = sheet.getByRole("button", { name: "Transfer" });
  await transferBtn.click();
  const tDlg = page.getByRole("dialog", { name: "Transfer service branch" });
  await expect(tDlg).toBeVisible();
  await tDlg.getByLabel("To branch").selectOption({ label: "Vijayawada" });
  await tDlg.getByLabel("Transfer reason").fill("Learner moved to Vijayawada for work and will attend there");
  await g.shot("Transferring to the other branch", [tDlg.getByLabel("To branch"), tDlg.getByLabel("Transfer reason"), tDlg.getByRole("button", { name: "Save" })], { focus: tDlg });
  await tDlg.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(/Service branch transferred/)).toBeVisible();
  await dismissToasts(page);
  g.tip("A transfer keeps the original branch on record. **Pause** and **Resume** on the same sheet are for a learner who has to wait (exams, health, travel).")
    .rule("Academic work (batches, allocations, joining) is run in the LMS for now.");

  // ---- 8. Money
  g.workflow("Follow the money: payments, collections and refunds")
    .p("Accounts verifies payments, but as the Branch Manager you need to see what is coming in, what is overdue, and you can open a refund case when a learner asks for money back.")
    .steps(
      "Open **Payments & receipts** (1 in the first screen). You see the branch ledger with receipts and status; verification buttons belong to Accounts.",
      "Open **Collections** (1 in the second screen) to see what is due, overdue or promised, and follow up with the counsellor.",
      "Open **Refunds** and click **Register refund case**. Find the admission (1), tick the receipts (2), give a reason (3) and click **Register case** (4).",
      "Add your **Assessment notes** (1) and click **Save assessment** (2). The Founder / Super Admin decides and Accounts pays out.",
    );
  await page.goto("/payments");
  await expect(page.getByRole("heading", { name: "Payments & receipts" })).toBeVisible();
  await expect(main.getByRole("row").nth(1)).toBeVisible();
  await dismissToasts(page);
  await g.shot("Payments & receipts: the branch ledger", [page.getByRole("link", { name: /^Payments & receipts/ })]);
  await page.goto("/collections");
  await expect(main.getByRole("heading", { name: /Collections/ }).first()).toBeVisible();
  await expect(main.getByRole("row").nth(1)).toBeVisible();
  await dismissToasts(page);
  await g.shot("Collections: what is due and overdue", [page.getByRole("link", { name: "Collections" })]);
  await page.goto("/refunds");
  await page.getByRole("button", { name: "Register refund case" }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Find admission").fill(refundAdm.admission.admission_code);
  const admSel = dialog.getByLabel("Admission", { exact: true });
  const opt = admSel.locator("option", { hasText: refundAdm.admission.admission_code });
  await expect(opt).toHaveCount(1);
  await admSel.selectOption((await opt.getAttribute("value"))!);
  const receipt = dialog.getByRole("checkbox", { name: new RegExp(refundAdm.payment.receipt_number) });
  await receipt.check();
  const reqReason = dialog.getByLabel("Request reason");
  await reqReason.fill("Learner has taken a job offer and can no longer attend the course");
  await g.shot("Registering a refund case", [dialog.getByLabel("Find admission"), receipt, reqReason, dialog.getByRole("button", { name: "Register case" })], { focus: dialog });
  await dialog.getByRole("button", { name: "Register case" }).click();
  await expect(page.getByText(/NIT-RF-\d+ registered/)).toBeVisible();
  const notes = page.getByLabel("Assessment notes");
  await notes.fill("Cancelled before the batch started; full amount paid so far is eligible");
  await page.getByRole("button", { name: "Save assessment" }).click();
  await expect(page.getByText("Assessment saved")).toBeVisible();
  await dismissToasts(page);
  await g.shot("The case after assessment: waiting for the Founder / Super Admin", [notes, page.getByRole("button", { name: "Save assessment" })]);
  g.rule("You open and assess refund cases but you cannot decide them: the Founder / CEO or Super Admin decides, then Accounts pays out. A refund is never more than what was verified as paid.");

  // ---- 9. Reports and masters
  g.workflow("Reports, Target Master and Offer Master")
    .p("Use these to see how the branch is doing against its targets and which offers are running. For you, Target Master and Offer Master are read-only.")
    .steps(
      "Open **Reports**. Use the period buttons (1, 2) such as **This Month** and **Last Month**, and the filters to narrow down.",
      "Open **Target Master** from **More** to see the targets set for your branch and your current achievement.",
      "Open **Offer Master** from **More** to read offers, their scope and complimentary courses. There is no **New offer** button for you: offers are created and activated by the Founder / CEO or Super Admin.",
    );
  await page.goto("/reports");
  await expect(page.getByRole("heading", { name: "Reports" })).toBeVisible();
  await expect(page.getByText("Verified collections · net")).toBeVisible();
  await dismissToasts(page);
  await g.shot("Reports for your branch", [page.getByRole("button", { name: "This Month", exact: true }), page.getByRole("button", { name: "Last Month", exact: true })]);
  await page.goto("/target-master");
  await expect(page.getByText("Current achievement")).toBeVisible();
  await dismissToasts(page);
  const versions = page.locator("section", { has: page.getByRole("heading", { name: "Target versions" }) });
  await expect(versions.getByRole("row").nth(1)).toBeVisible();
  await g.shot("Target Master (read-only): the approved target versions", [versions], { focus: versions, pad: 8 });
  await page.goto("/offer-master");
  await expect(page.getByRole("heading", { name: /Offer Master/ }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "New offer" })).toHaveCount(0);
  g.tip("Targets and offers are created and approved by the Founder / CEO or Super Admin. If you think one needs changing, ask them.");

  g.save();
});
