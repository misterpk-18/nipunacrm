import { expect, test } from "@playwright/test";
import { USERS } from "../helpers";
import { Guide, settle } from "./guide";

/** Hide toasts with CSS (removing their nodes crashes React when sonner next re-renders). */
async function dismissToasts(page: import("@playwright/test").Page) {
  await page.evaluate(() => {
    if (!document.getElementById("__hide_toasts")) {
      const st = document.createElement("style");
      st.id = "__hide_toasts";
      st.textContent = "[data-sonner-toaster]{display:none!important}";
      document.head.append(st);
    }
  });
}
/** Scroll every horizontally scrollable ancestor of `loc` fully right, so the last column shows. */
async function scrollRight(loc: import("@playwright/test").Locator) {
  await loc.first().evaluate((el) => {
    for (let n: HTMLElement | null = el as HTMLElement; n; n = n.parentElement) if (n.scrollWidth > n.clientWidth + 4) n.scrollLeft = n.scrollWidth;
  });
}
async function showToasts(page: import("@playwright/test").Page) {
  await page.evaluate(() => document.getElementById("__hide_toasts")?.remove());
}
import { as, claim, day, deal, freshAuth, invoiced, paid, signIn } from "./demo";

/** Accounts (Guntur): verifying payments, corrections, invoices, collections, refund payouts, reports. */
test("accounts guide", async ({ page, request }) => {
  test.setTimeout(900_000);
  const g = new Guide(page, {
    role: "accounts",
    title: "Accounts",
    subtitle: "Verify payments, keep the ledger right, chase dues and pay out refunds",
    account: USERS.accountsGnt,
  });

  // ------------------------------------------------------------ sample records (built through the API)
  // Claims waiting for Accounts
  const mk = async (split?: [number, number]) => {
    const l = await deal(request);
    const inv = await invoiced(request, l, split);
    return { l, inv };
  };
  const upi = await mk();
  const upiClaim = await claim(request, upi.l, upi.inv.invoice_id, "5000");
  const cash = await mk();
  const cashClaim = await claim(request, cash.l, cash.inv.invoice_id, "3000", "Cash");
  const bad = await mk();
  const badClaim = await claim(request, bad.l, bad.inv.invoice_id, "2500");
  const note = await mk(); // stays pending for the notification screenshot
  const noteClaim = await claim(request, note.l, note.inv.invoice_id, "4000");
  // A verified payment to correct
  const corr = await mk();
  const corrPaid = await paid(request, corr.l, corr.inv.invoice_id, "6000");
  // Invoice with two instalments, the first paid; also drives the dues screens
  const two = await mk([6000, 12]);
  await paid(request, two.l, two.inv.invoice_id, "6000");
  // Overdue instalment for Collections: token due today and the balance already due (pay token only)
  const dues = await mk([5000, 6]);
  await paid(request, dues.l, dues.inv.invoice_id, "5000");

  await signIn(page, USERS.accountsGnt);
  await settle(page);

  // ============================================================ PART 1
  g.overview("What Accounts is responsible for")
    .p(
      "Accounts is the gatekeeper for money. Counsellors and the front office record **payment claims**; nothing counts as collected, no receipt number exists and no course is admitted until **you** verify the claim. You also keep invoices and instalment dates right, chase dues, request corrections when a verified payment was wrong, and pay out refunds that an admin has approved.",
    )
    .bullets(
      "**Verify or fail every payment claim**, with a 30-minute target from the moment it is recorded.",
      "**Request corrections** on verified payments; a different person approves them.",
      "**Invoices**: open, print, and change an instalment due date; cancel an unpaid invoice.",
      "**Collections**: dues today, overdue and upcoming, with ageing bands and promises to pay.",
      "**Refunds**: pay out and reconcile cases an admin has approved. You never decide a refund.",
      "**Reports** and the Target Master are available to you to read.",
    )
    .rule("You work for one branch. A Guntur Accounts user sees Guntur invoices, payments and collections only.");

  g.overview("Signing in and the home screen").p(
    "Sign in with your work email and password. You land on the **Overview** dashboard for your branch: verified collections this month, the outstanding balance with the number of payments awaiting verification, a seven-day collections chart and the items that need attention.",
  );
  await page.goto("/dashboard");
  await settle(page);
  await g.shot("The Overview dashboard", [page.getByRole("link", { name: "Payments & receipts" }).first(), page.locator('a[href="/notifications"][aria-label^="Notifications"]')]);
  g.steps(
    "Use the **Payments & receipts** menu item (1) for the ledger where claims are verified.",
    "Watch the bell (2). Each new claim sends you an action-required notification straight away.",
  );

  g.overview("The menu: what each screen is for").table(
    ["Screen", "What you use it for"],
    ["Overview", "Branch dashboard: verified collections, outstanding balance, awaiting verification."],
    ["My work", "Your open tasks, oldest first. Roles without leads access see tasks only."],
    ["Students and Admissions", "Look up a learner or an admission created by a verified payment."],
    ["Invoices", "Every invoice with paid, balance and completion; open one to print it or change an instalment date."],
    ["Payments & receipts", "The ledger. Verify or fail pending claims, request corrections, allocate advances."],
    ["Collections", "Instalments due today, overdue and upcoming; ageing bands; promises to pay."],
    ["Refunds", "Refund cases and support cases. You do payout and reconciliation."],
    ["Tasks and WhatsApp messages", "Your tasks, and the WhatsApp messages the system sends to learners."],
    ["Reports and Target Master", "Management reports with CSV export, and targets (read only)."],
  );

  g.overview("Rules and limits the system enforces")
    .rule("Verification is **once and final**: a claim ends as Verified or Failed and cannot be undone. The receipt number (for example `GNT-R-2627-00001`) is issued only at that moment.")
    .rule("Verifying needs two confirmations: **evidence reviewed** and, for cash, an **independent cash check**. A pending claim carries only its transaction number (`TXN-GNT-…`).")
    .rule("Payments can never be edited or deleted. A mistake is fixed by a **correction request** with a reason; a different person (Founder / CEO or Super Admin) must approve it, and the system adds a linked reversal.")
    .rule("A course is admitted automatically on the verification that brings its paid amount to the ₹1,000 token.")
    .rule("You pay out refunds but never decide them, and you can never pay out a case you decided.")
    .rule("Fee changes after admission are approved by Founder / CEO or Super Admin; Accounts (or an admin) then applies them. A fee can never go below what is already paid; use a refund case instead.")
    .p("Lead 360 opens **read-only** for you, from the claim review, an invoice or a notification. Leads is not in your menu.");

  g.overview("A typical day").table(
    ["When", "What you do"],
    ["Start of day", "Open the Overview and the bell. Clear anything marked action required, oldest first."],
    ["All day", "Verify claims as they arrive. Target: under 30 minutes. At 25 minutes you get a warning; at 30 the Branch Manager is alerted."],
    ["Mid-morning", "Open Collections. Check what is due today and overdue; log promises to pay."],
    ["As needed", "Change an instalment date the learner agreed; request a correction for a wrong entry."],
    ["End of day", "Check that nothing is still pending, and pay out or reconcile any approved refunds."],
  );

  // ============================================================ PART 2
  // ---- 1. Notifications and My work
  g.workflow("Start your day: notifications and My work").p(
    "Each new payment claim sends Accounts an action-required notification. The notification centre is the quickest way to the claim; **My work** lists your own tasks, such as chasing an instalment.",
  );
  await page.goto("/notifications");
  await settle(page);
  const noteRow = page.getByRole("row").filter({ hasText: noteClaim.transaction_number }).first();
  await expect(noteRow).toBeVisible();
  await dismissToasts(page);
  await noteRow.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await g.shot("Notifications with a claim waiting for verification", [noteRow.getByRole("button", { name: /Review/ }), noteRow.getByRole("link", { name: "Open claim" })], {});
  g.steps(
    "Click the bell (top right) or open **Notifications** from the menu.",
    "Find the notification for the claim. **Review & verify** (1) opens the claim in place; **Open claim** (2) goes to Payments & receipts with the same dialog.",
    "Use **Mark read** or **Acknowledge** on information items so the list stays short.",
  );
  await page.goto("/my-work");
  await settle(page);
  g.tip("Tasks are created for you automatically, for example to verify a payment or chase an instalment. Their original deadline never changes; moving one needs a reason.");

  // ---- 2. Verify a UPI claim
  g.workflow("Verify a UPI or bank-transfer claim").p(
    "A counsellor has recorded a payment with proof. Check the proof against the bank statement, then verify. Verification issues the receipt number and, from ₹1,000, admits the course.",
  );
  await page.goto(`/payments?status=Pending+Verification&q=${encodeURIComponent(upi.l.name)}`);
  await settle(page);
  const upiRow = page.getByRole("row").filter({ hasText: upiClaim.transaction_number });
  await expect(upiRow).toBeVisible();
  await dismissToasts(page);
  await scrollRight(upiRow);
  await g.shot("The pending claim in the ledger: no receipt number yet", [page.getByLabel("Search payments"), upiRow.getByRole("button", { name: `Verify ${upiClaim.transaction_number}` })], { focus: page.getByRole("tabpanel").first(), pad: 6 });
  await upiRow.getByRole("button", { name: `Verify ${upiClaim.transaction_number}` }).click();
  const dlg = page.getByRole("dialog");
  await expect(dlg.getByAltText("Payment proof")).toBeVisible();
  await expect(dlg.getByRole("button", { name: "Verify payment" })).toBeDisabled();
  await settle(page);
  await page.waitForTimeout(800);
  await g.shot(
    "The claim review: amount, proof and the two actions",
    [dlg.getByAltText("Payment proof"), dlg.getByRole("checkbox", { name: "Evidence reviewed" }), dlg.getByRole("button", { name: `Fail ${upiClaim.transaction_number}` }), dlg.getByRole("button", { name: "Verify payment" })],
    { focus: dlg, pad: 8 },
  );
  await dlg.getByRole("checkbox", { name: "Evidence reviewed" }).click();
  await dlg.getByRole("button", { name: "Verify payment" }).click();
  await freshAuth(page);
  await showToasts(page);
  const toast = page.getByText(/GNT-R-2627-\d+ issued/).first();
  await expect(toast).toBeVisible();
  await g.shot("The receipt number and the admission created are confirmed in the toast", [toast], { focus: toast, pad: 40 });
  g.steps(
    "Open **Payments & receipts** and filter to **Pending Verification**, or search by learner name or transaction number (1).",
    "Click **Verify** on the claim (2). The review shows the amount, mode, reference, the courses it pays for and the proof image (1 on the next screenshot).",
    "Compare the proof and reference with the bank or UPI statement. If it matches, tick **Evidence reviewed** (2).",
    "Click **Verify payment** (4); it stays greyed out until the box is ticked. If asked, enter your password again. **Mark failed** (3) is covered in section 2.4.",
    "A message such as **GNT-R-2627-00012 issued · admitted: NIT-GNT-2026-000031** confirms the receipt number and the admission.",
  );
  g.rule("Verification cannot be undone. Never tick **Evidence reviewed** before the money is visible in the statement.");
  await page.goto(`/invoices/${upi.inv.invoice_id}`);
  await settle(page);
  await dismissToasts(page);
  const receiptCell = page.getByRole("cell", { name: /Receipt GNT-R-/ }).first();
  await expect(receiptCell).toBeVisible();
  await g.shot("The invoice now shows the receipt, money paid and the admission", [receiptCell, page.getByRole("cell", { name: /NIT-GNT-\d{4}-\d+/ }).first()]);
  g.p("The invoice page shows the verified receipt (1) and, beside the course, the admission it created (2). Balance due falls by the verified amount only.");

  // ---- 3. Verify a cash claim
  g.workflow("Verify a cash claim").p(
    "Cash needs no proof image, but it needs a second confirmation: someone other than the collector has counted the cash. Verify cash only after that count.",
  );
  await page.goto(`/payments?status=Pending+Verification&q=${encodeURIComponent(cash.l.name)}`);
  await settle(page);
  await page.getByRole("button", { name: `Verify ${cashClaim.transaction_number}` }).click();
  const cdlg = page.getByRole("dialog");
  await expect(cdlg.getByText(/No proof attached/)).toBeVisible();
  await cdlg.getByRole("checkbox", { name: "Evidence reviewed" }).click();
  await expect(cdlg.getByRole("button", { name: "Verify payment" })).toBeDisabled();
  await settle(page);
  await g.shot(
    "For cash there is a second tick, and Verify stays off until both are ticked",
    [cdlg.getByRole("checkbox", { name: "Evidence reviewed" }), cdlg.getByRole("checkbox", { name: "Independent cash check completed" }), cdlg.getByRole("button", { name: "Verify payment" })],
    { focus: cdlg, pad: 8 },
  );
  await cdlg.getByRole("checkbox", { name: "Independent cash check completed" }).click();
  await cdlg.getByRole("button", { name: "Verify payment" }).click();
  await freshAuth(page);
  await showToasts(page);
  await expect(page.getByText(/GNT-R-2627-\d+ issued/).first()).toBeVisible();
  g.steps(
    "Open the cash claim from the ledger or from its notification.",
    "The review says **No proof attached** (cash needs none).",
    "Tick **Evidence reviewed** (1) once the cash is on record, and **Independent cash check completed** (2) once a second person has counted it.",
    "**Verify payment** (3) is enabled only with both ticks. Click it, and confirm your password if asked.",
  );
  g.tip("The cash check is the safeguard against one person collecting and approving the same money. Do not tick it on someone else's word.");

  // ---- 4. Fail a claim
  g.workflow("Mark a claim as failed").p(
    "If the money never arrived (a bounced cheque, a reference that is not in the statement), fail the claim. It stays in the ledger as Failed, never gets a receipt, and the counsellor is told the reason.",
  );
  await page.goto(`/payments?status=Pending+Verification&q=${encodeURIComponent(bad.l.name)}`);
  await settle(page);
  await page.getByRole("button", { name: `Verify ${badClaim.transaction_number}` }).click();
  const fdlg = page.getByRole("dialog");
  await expect(fdlg.getByAltText("Payment proof")).toBeVisible();
  await fdlg.getByRole("button", { name: `Fail ${badClaim.transaction_number}` }).click();
  const confirm = page.getByRole("alertdialog").or(page.getByRole("dialog").last());
  const reason = confirm.getByLabel("Failure reason");
  await reason.fill("Reference not found in the bank statement");
  await settle(page);
  await g.shot("Failing a claim needs a reason", [reason, confirm.getByRole("button", { name: "Mark failed" })], { focus: confirm, pad: 8 });
  await confirm.getByRole("button", { name: "Mark failed" }).click();
  await freshAuth(page);
  await showToasts(page);
  await expect(page.getByText(`${badClaim.transaction_number} marked Failed`)).toBeVisible();
  await page.goto(`/invoices/${bad.inv.invoice_id}`);
  await settle(page);
  await dismissToasts(page);
  const failedRow = page.getByRole("row").filter({ hasText: badClaim.transaction_number });
  await expect(failedRow.getByText("Failed — no receipt")).toBeVisible();
  await g.shot("The invoice ledger shows the claim as Failed, with no receipt", [failedRow.getByText("Failed — no receipt")], { focus: page.locator("section.panel").filter({ has: page.getByRole("heading", { name: "Linked payment history" }) }), pad: 10 });
  g.steps(
    "Open the claim as for any verification.",
    "Click **Mark failed**. A confirmation asks for a **Failure reason**; type a clear one (1).",
    "Click **Mark failed** in the confirmation (2).",
    "The ledger row now reads **Failed — no receipt**. The owner counsellor gets a notification with your reason.",
  );
  g.rule("Failed is final too. If the learner pays again, the counsellor records a new claim.");

  // ---- 5. Request a correction
  g.workflow("Request a correction on a verified payment").p(
    "A verified payment cannot be edited or deleted. If it was wrong (wrong amount, wrong invoice, duplicate), request a correction. A different person approves it, then the system adds a reversal entry linked to the original.",
  );
  await page.goto(`/invoices/${corr.inv.invoice_id}`);
  await settle(page);
  await dismissToasts(page);
  const corrBtn = page.getByRole("button", { name: `Request correction for ${corrPaid.receipt_number}` });
  await expect(corrBtn).toBeVisible();
  await g.shot("Request correction sits on the verified receipt row", [corrBtn], { focus: page.locator("section.panel").filter({ has: page.getByRole("heading", { name: "Linked payment history" }) }), pad: 6 });
  await corrBtn.click();
  const kdlg = page.getByRole("dialog");
  await kdlg.getByLabel("Reason (required)").fill("Wrong amount keyed in: the learner paid 5,000, not 6,000");
  await settle(page);
  await g.shot("The correction request dialog", [kdlg.getByLabel("Reason (required)"), kdlg.getByRole("button", { name: "Submit for approval" })], { focus: kdlg, pad: 8 });
  await kdlg.getByRole("button", { name: "Submit for approval" }).click();
  await freshAuth(page);
  await showToasts(page);
  await expect(page.getByText(/submitted for approval/)).toBeVisible();
  await dismissToasts(page);
  const pendingRow = page.getByRole("row").filter({ hasText: "Wrong amount keyed in" });
  await expect(pendingRow.getByText(/Awaiting Founder/)).toBeVisible();
  await g.shot("The request waits for a Founder / CEO or Super Admin", [pendingRow.getByText(/Awaiting Founder/)], { focus: page.locator("section.panel").filter({ has: page.getByRole("heading", { name: "Correction requests" }) }), pad: 6 });
  g.steps(
    "Open the invoice and find the verified receipt in the payment ledger.",
    "Click **Request correction** (1) on that receipt's row.",
    "Type a specific **Reason (required)** (1) and click **Submit for approval** (2). Confirm your password if asked.",
    "The row now shows **Awaiting Founder / CEO or Super Admin**. You can also follow requests under the **Correction requests** tab of Payments & receipts.",
  );
  g.rule("You cannot approve your own request, and no one can approve a request they raised themselves. When it is approved, the original receipt stays visible and a Reversal row is added beside it.");

  // ---- 6. Invoices
  g.workflow("Open an invoice and change an instalment due date").p(
    "The invoice page is the branch's official document and the working view of one learner's account. Use it to check the schedule and ledger, print a copy, or move a due date that the learner has agreed.",
  );
  await page.goto("/invoices");
  await settle(page);
  await dismissToasts(page);
  await page.goto(`/invoices/${two.inv.invoice_id}`);
  await settle(page);
  await dismissToasts(page);
  await showToasts(page);
  await expect(page.getByText("Instalment schedule")).toBeVisible();
  await g.shot("The top of an invoice: totals and the Print / Save PDF button", [page.getByRole("button", { name: "Print / Save PDF" })]);
  await g.shot("The instalment schedule, with the change-date button on each unpaid instalment", [page.getByRole("button", { name: "Change due date of instalment 2" })], { focus: page.locator("section.panel").filter({ has: page.getByRole("heading", { name: "Instalment schedule" }) }), pad: 6 });
  await page.getByRole("button", { name: "Change due date of instalment 2" }).click();
  const ddlg = page.getByRole("dialog");
  await ddlg.getByLabel("New due date").fill(day(20));
  await settle(page);
  await g.shot("Change the due date of one instalment", [ddlg.getByLabel("New due date"), ddlg.getByRole("button", { name: "Save" })], { focus: ddlg, pad: 8 });
  await ddlg.getByRole("button", { name: "Save" }).click();
  await freshAuth(page);
  await showToasts(page);
  await expect(page.getByText(/Instalment 2 now due/)).toBeVisible();
  g.steps(
    "Open **Invoices**, then use the search box or the **Payment completion** filter on the register to find the invoice. Click its number.",
    "Check the money tiles, the **Instalment schedule** and the payment ledger. A pending claim shows **No receipt until verified** and never counts as paid.",
    "To print or save a PDF, click **Print / Save PDF** (1 in the second figure). The invoice prints on its own, A4.",
    "To move a date, click the pencil next to the instalment (1 in the third figure). Pick the **New due date** (1) and click **Save** (2). Reminders follow the new date.",
  );
  g.tip("Instalments already paid cannot be moved. Invoices cannot be edited; an unpaid invoice can be cancelled with **Cancel invoice** (a reason is required).");

  // ---- 7. Collections
  g.workflow("Chase dues in Collections and record a promise to pay").p(
    "Collections lists every instalment still unpaid. Use it each morning to see what is due today, what is overdue and how old it is, and to log what the learner promises.",
  );
  await page.goto("/collections?tab=Overdue");
  await settle(page);
  await dismissToasts(page);
  await g.shot("Collections: tabs for Due today, Overdue and Upcoming, plus the filters", [page.getByRole("tab", { name: "Ageing" }), page.getByLabel("Payment plan")]);
  await page.getByRole("tab", { name: "Ageing" }).click();
  await settle(page);
  await g.shot("The Ageing tab groups overdue money into bands", [page.getByRole("row", { name: /^4–7/ }).first()]);
  await page.getByRole("tab", { name: "Upcoming" }).click();
  await settle(page);
  const drow = page.getByRole("row", { name: new RegExp(dues.l.name) });
  await expect(drow).toBeVisible();
  await g.shot("Find the learner and open Promises", [drow.getByRole("button", { name: `Promises for ${dues.l.name}` })], {});
  await drow.getByRole("button", { name: `Promises for ${dues.l.name}` }).click();
  const pdlg = page.getByRole("dialog");
  await pdlg.getByLabel("Promised amount (₹)").fill("2000");
  await pdlg.getByLabel("Promised date").fill(day(2));
  await settle(page);
  await g.shot("Record what the learner promised", [pdlg.getByLabel("Promised amount (₹)"), pdlg.getByLabel("Promised date"), pdlg.getByRole("button", { name: "Add promise" })], { focus: pdlg, pad: 8 });
  await pdlg.getByRole("button", { name: "Add promise" }).click();
  await showToasts(page);
  await expect(page.getByText(/Promise of ₹2,000 .* recorded/)).toBeVisible();
  await dismissToasts(page);
  await settle(page);
  await g.shot("The promise is logged; mark it Kept or Broken later", [pdlg.getByRole("button", { name: "Kept" }), pdlg.getByRole("button", { name: "Broken" })], { focus: pdlg, pad: 8 });
  g.steps(
    "Open **Collections**. Use the tabs for **Due today**, **Overdue** and **Upcoming**, and **Ageing** for the bands (1–3, 4–7, 8–15, 16–30, 31–60, 61–90, 91+ days). Filter by **Payment plan** (2).",
    "Find the learner and click **Promises** on their row.",
    "Enter the **Promised amount (₹)** (1) and **Promised date** (2), then click **Add promise** (3).",
    "When the date passes, open Promises again and mark it **Kept** (1) or **Broken** (2). Broken promises escalate.",
  );
  g.tip("Reminders are automatic: 3 days before the due date, on it, and 3 days after (day 4 to the owner, day 7 to the Branch Manager). A learner with a claim awaiting verification is on contact hold and is not chased.");

  // ---- 8. Refunds
  const rf = await mk();
  const rfPaid = await paid(request, rf.l, rf.inv.invoice_id, "8000");
  const bm = await as(request, USERS.bmGnt);
  const admin = await as(request, USERS.admin);
  const admissionId = rfPaid.admissions_created[0]!.admission_id;
  const post = async (h: Record<string, string>, path: string, method: "POST" | "PATCH", data: object) => {
    const res = await request.fetch(`/api/v1${path}`, { method, headers: h, data });
    expect(res.ok(), `${path} → ${res.status()} ${await res.text()}`).toBeTruthy();
    return (await res.json()).data;
  };
  const rcase = await post(bm, "/refund-cases", "POST", {
    admission_id: admissionId,
    request_reason: "Relocating to Hyderabad for a job; asked to withdraw before the batch starts",
    payment_ids: [rfPaid.payment_id],
  });
  await post(bm, `/refund-cases/${rcase.refund_case_id}`, "PATCH", { assessment_date: day(0), assessment_notes: "Before batch start; full refund eligible", evidence_status: "Evidence Complete" });
  await post(admin, `/refund-cases/${rcase.refund_case_id}/decide`, "POST", { decision: "Refund Approved", amount: "8000", reason: "Within the refund window" });

  g.workflow("Pay out and reconcile an approved refund").p(
    "The Branch Manager registers a refund case and assesses it, and a Founder / CEO or Super Admin decides it. When it is approved, the money is yours to pay and reconcile. You cannot decide a refund, and the person who decided it cannot pay it out.",
  );
  await page.goto("/refunds");
  await settle(page);
  await dismissToasts(page);
  const crow = page.getByRole("row").filter({ hasText: rcase.case_code });
  await expect(crow).toBeVisible();
  await g.shot("Refund cases: status, decision and payout at a glance", [page.getByLabel("Payout status"), crow.getByText("Decided")]);
  await page.goto(`/refunds?case=${rcase.refund_case_id}`);
  await settle(page);
  await expect(page.getByLabel("Payout reference")).toBeVisible();
  await page.getByLabel("Payout mode").selectOption({ label: "UPI / Bank Transfer" });
  await page.getByLabel("Payout reference").fill(`RFND${String(Date.now()).slice(-9)}`);
  const form = page.locator("form").filter({ has: page.getByLabel("Payout reference") });
  await settle(page);
  await page.locator("div.rounded-md.border").filter({ has: page.getByRole("heading", { name: "Payout (Accounts)" }) }).evaluate((el) => el.scrollIntoView({ block: "center" }));
  await g.shot("The approved case: payout details", [page.getByLabel("Payout mode"), page.getByLabel("Payout reference"), page.getByRole("button", { name: "Start payout" })], { focus: page.locator("div.rounded-md.border").filter({ has: page.getByRole("heading", { name: "Payout (Accounts)" }) }), pad: 14 });
  await page.getByRole("button", { name: "Start payout" }).click();
  await showToasts(page);
  await expect(page.getByText("Payout started (Processing)")).toBeVisible();
  await dismissToasts(page);
  await settle(page);
  const reconcileBtn = page.getByRole("button", { name: "Reconcile payout" });
  await page.locator("div.rounded-md.border").filter({ has: page.getByRole("heading", { name: "Payout (Accounts)" }) }).evaluate((el) => el.scrollIntoView({ block: "center" }));
  await g.shot("After the payout is sent: reconcile it against the bank", [reconcileBtn], { focus: page.locator("div.rounded-md.border").filter({ has: page.getByRole("heading", { name: "Payout (Accounts)" }) }), pad: 14 });
  await reconcileBtn.click();
  const completeBtn = page.getByRole("button", { name: "Mark payout completed" });
  await expect(completeBtn).toBeVisible();
  await dismissToasts(page);
  await page.locator("div.rounded-md.border").filter({ has: page.getByRole("heading", { name: "Payout (Accounts)" }) }).evaluate((el) => el.scrollIntoView({ block: "center" }));
  await g.shot("Then mark the payout completed", [completeBtn], { focus: page.locator("div.rounded-md.border").filter({ has: page.getByRole("heading", { name: "Payout (Accounts)" }) }), pad: 14 });
  await completeBtn.click();
  await showToasts(page);
  await expect(page.getByText(/NIT-RF-\d+ completed/)).toBeVisible();
  await dismissToasts(page);
  await settle(page);
  await g.shot("The case is completed", [page.getByText("Payout Completed").first()], { focus: page.locator("section.panel").filter({ has: page.getByRole("heading", { name: "Refund case" }) }).last(), pad: 6 });
  g.steps(
    "Open **Refunds**. Filter by **Payout status** (1) to see approved cases waiting for you.",
    "Open the case. Check the approved amount, the receipts it covers and the decision reason.",
    "Choose the **Payout mode** (1), type the **Payout reference** (2) from your bank transfer and click **Start payout** (3). The case moves to Processing.",
    "When the bank shows the transfer, click **Reconcile payout** (1).",
    "Click **Mark payout completed** (1). If the transfer fails, use **Payout failed** and give a reason; the case returns for another attempt.",
  );
  g.rule("Targets: a decision within 7 working days of registration and the payout within 18 working days of approval. A refund can never exceed what was verified as paid.");

  // ---- 9. Reports and Lead 360
  g.workflow("Reports with filters and CSV export").p(
    "Reports gives the same figures as the dashboards, with filters. Use it for month-end checks and to hand figures to management.",
  );
  await page.goto("/reports");
  await settle(page);
  await dismissToasts(page);
  const exportBtn = page.getByRole("button", { name: "Export management CSV" });
  await expect(exportBtn).toBeVisible();
  await g.shot("Reports: filters on top, CSV export on each report", [page.getByLabel("Course"), exportBtn]);
  const download = page.waitForEvent("download").catch(() => null);
  await exportBtn.click();
  await download;
  await showToasts(page);
  await expect(page.getByText("Export downloaded")).toBeVisible();
  await dismissToasts(page);
  g.steps(
    "Open **Reports** and set the date range, **Course** (1) or other filters at the top.",
    "Read the figures on screen, then click **CSV** (2) beside a report to download the filtered rows.",
  );
  g.p(
    "**Lead 360 for Accounts.** From a claim review (**Open lead**), an invoice or a notification you can open the learner's Lead 360. It is read-only: you see the next-step bar, delivery plan, demos, timeline and invoices, but you act only on what the bar assigns to you, which is verifying a payment.",
  );
  await page.goto(`/leads/${upi.l.lead_id}`);
  await settle(page);
  await dismissToasts(page);
  await g.shot("Lead 360 opens read-only for Accounts", []);

  g.save();
});
