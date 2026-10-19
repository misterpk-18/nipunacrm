import { test, expect, type Page } from "@playwright/test";
import { USERS, verifyPayment } from "../helpers";
import { Guide } from "./guide";
import { lead, deal, personName, mobile, signIn, PROOF, as } from "./demo";

/** Hide toasts with CSS (removing the nodes crashes React); pass false to show them again. */
async function toasts(page: Page, hide: boolean) {
  await page.evaluate((h) => {
    document.getElementById("__hide_toasts")?.remove();
    if (h) {
      const st = document.createElement("style");
      st.id = "__hide_toasts";
      st.textContent = "[data-sonner-toaster]{display:none!important}";
      document.head.append(st);
    }
  }, hide);
}
const dismissToasts = (page: Page) => toasts(page, true);
const tiles = (page: Page) => page.locator("div").filter({ has: page.getByText("Billed", { exact: true }), hasText: "Outstanding" }).last();

async function top(page: Page) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
}

type Marks = Parameters<Guide["shot"]>[1];
type Focus = NonNullable<Parameters<Guide["shot"]>[2]>["focus"];

/** Shot of an area taller than the normal window: enlarge the window for the capture. */
async function tall(g: Guide, page: Page, caption: string, marks: Marks, focus: Focus, height = 1700) {
  await page.setViewportSize({ width: 1440, height });
  await page.waitForTimeout(500);
  await g.shot(caption, marks, { focus });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(300);
}
async function tallFull(g: Guide, page: Page, caption: string, marks: Marks, height = 1350) {
  await page.setViewportSize({ width: 1440, height });
  await page.waitForTimeout(500);
  await top(page);
  await g.shot(caption, marks);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(300);
}
/** A normal full-window shot from the top of the page, toasts hidden. */
async function view(g: Guide, page: Page, caption: string, marks: Marks = []) {
  await dismissToasts(page);
  await top(page);
  await g.shot(caption, marks);
}

test("sales guide", async ({ page, request }) => {
  test.setTimeout(600_000);
  page.setDefaultTimeout(20_000);
  const g = new Guide(page, {
    role: "sales",
    title: "Sales Counsellor & Front Office",
    subtitle: "From a new enquiry to a verified payment and an admission, step by step",
    account: USERS.salesGnt,
  });
  const existing = await lead(request, { by: USERS.salesGnt });

  // =================================================================== PART 1
  g.overview("What a counsellor is responsible for")
    .p("As a **Sales Counsellor** you take an enquiry from the first call to a paid admission. You own the leads you create, keep each one moving with a recorded outcome and a dated next step, and close the sale: demo, fee, delivery plan, invoice and payment claim.")
    .bullets(
      "**Capture and follow up:** add leads, call or message them, and record every contact on the lead with a next action and date.",
      "**Qualify and convert:** tick six checks, mark the lead qualified and convert it into a deal on the person's pipeline card.",
      "**Demo and fee:** book the demo, discuss the fee, ask for a special closing approval if you need to give an extra concession.",
      "**Invoice and payment:** confirm the delivery plan, create the invoice with its instalments and record the payment claim with proof.",
      "**Not yours:** assigning leads, approving discounts, verifying payments, cancelling admissions and settings. Those belong to the Branch Manager, Accounts and admins.",
    )
    .p("**Front Office** staff do the same lead work at the front desk and on the phone. The last section of Part 1 explains the differences.");

  // login screen
  await page.goto("/login");
  await page.getByLabel("Email").fill(USERS.salesGnt);
  await page.getByLabel("Password").fill("Nipuna-staging-1");
  g.overview("Signing in and your home screen")
    .steps(
      "Open the CRM address your branch manager gave you and enter your work **Email** (1) and **Password** (2).",
      "Press **Sign in** (3). Some sensitive actions later ask for your password again; that is normal.",
    );
  await g.shot("The sign-in screen", [page.getByLabel("Email"), page.getByLabel("Password"), page.getByRole("button", { name: "Sign in" })]);
  await signIn(page, USERS.salesGnt);
  await expect(page).toHaveURL(/\/counsellor/);
  await page.getByRole("tab", { name: /^New/ }).click();
  await page.waitForTimeout(800);
  g.p("You land on the **Counsellor Workspace**. It shows your own queue only. At the top are live tiles (1): demos today, tasks due, payments waiting for Accounts and special closing requests. Under them are the queue tabs (2): New, Untouched, Due Today, Overdue, Hot, Demos, Fee Discussion, Payment Pending Verification, Cold / Reactivation and Future Joining. **Add Lead** (3) is always at the top right.");
  await view(g, page, "Counsellor Workspace: the home screen of a counsellor", [page.getByText("Demos today").first(), page.getByRole("tablist", { name: "Queues" }), page.getByRole("button", { name: /Add Lead/i })]);
  g.tip("Everything you see is limited to your branch (Guntur here). The branch box at the top is locked for counsellors.");

  g.overview("The menu: what each screen is for");
  await page.getByRole("link", { name: "My work" }).first().waitFor();
  const nav = page.getByRole("navigation", { name: "Main" });
  await tall(g, page, "The left menu", [nav.getByRole("link", { name: "My work" }), nav.getByRole("link", { name: "Leads" }), nav.getByRole("link", { name: "Deal pipeline" })], nav, 1100);
  g.p("You work mostly from **My work** (1), **Leads** (2) and **Deal pipeline** (3). The other screens, grouped as in the menu:")
    .table(
      ["Screen", "What you use it for"],
      ["Overview", "Your branch numbers and targets at a glance."],
      ["My work", "Today (your prioritised queue), Queues, and Handover to a cover colleague."],
      ["AI assistant", "Advisory suggestions and drafts. You always review before acting."],
      ["Leads", "New enquiries. Add a lead, open Lead 360, record outcomes, qualify and convert."],
      ["Deal pipeline", "Converted deals as cards by stage, with next steps and follow-ups."],
      ["Demos & counselling", "Your booked demos: confirm, reschedule, cancel, record the outcome."],
      ["Students and Admissions", "Students and admissions of your branch, with fees and balance."],
      ["Invoices, Payments & receipts, Collections", "Invoices of your branch, the payment claims you recorded and dues to chase."],
      ["Tasks", "Your own task list. Many tasks are created for you by the system."],
      ["Communications and WhatsApp messages", "Inbox of enquiries and the log of WhatsApp messages sent to learners."],
      ["Persons (under More)", "Search anyone who enquired or studied. Person 360 shows all their courses."],
      ["Counsellor Workspace and Notifications (under More)", "Your queue tabs, and the bell list of alerts."],
    )
    .p("Some screens exist for other roles only and are not in your menu: Refunds, Reports, Branch Manager, Discount Approvals, Offer Master, Target Master and Admin. If you open one by address, the CRM says you do not have access.");

  g.overview("Rules and limits the system enforces")
    .bullets(
      "**Ownership.** A counsellor who creates a lead owns it. Changing stage, follow-up, marking lost and editing need the owner (or a manager). While a lead is unassigned, any counsellor of the branch can work it.",
      "**Pipeline cards** follow the same rule: only the owner or a manager moves the card, marks it lost and sets its follow-up. Only a Branch Manager or admin changes the owner of a card.",
      "**Convert first.** Demos, fee discussions and stage moves need a converted lead: tick all six qualification checks, **Mark Qualified**, then **Convert to deal**.",
      "**You cannot** assign or bulk-assign leads, reactivate lost leads, approve discounts, verify payments, cancel admissions or change settings.",
      "**Contact limits.** After **Stop contact** nobody may contact the lead (only a Branch Manager or admin can clear it). While a learner has never been reached you may log at most 5 calls and 3 WhatsApp messages. Contact the learner starts can always be recorded.",
      "**Nothing counts until Accounts verifies.** A payment you record is a claim: it has a TXN number, no receipt, and does not count as paid.",
      "**Payments cannot be edited.** A mistake is fixed by Accounts through a correction that a second person approves.",
    );

  g.overview("A typical day")
    .steps(
      "Open **My work**, tab **Today**. Do the numbered items from the top: promised callbacks and overdue responses first, then new enquiries, demos, post-demo decisions and agreed follow-ups.",
      "Clear **Record demo outcome** for demos that finished, so the fee discussion can start.",
      "Call or message each lead and press **Save outcome** with the result, a note and the next action with a date.",
      "Qualify and convert the leads that are ready. Book demos.",
      "Move deals along: fee discussion, delivery plan, invoice, payment claim.",
      "Check **Notifications** and **Tasks**. Before you leave, use the **Handover** tab for anything a cover colleague must continue.",
    );
  await page.goto("/my-work");
  await page.waitForTimeout(1500);
  await view(g, page, "My work, tab Today. Tab (1) is your ordered queue, (2) Queues lists by status, (3) Handover.", [page.getByRole("tab", { name: "Today" }), page.getByRole("tab", { name: "Queues" }), page.getByRole("tab", { name: "Handover" })]);
  g.p("The ordering follows service urgency, not a guess about who will buy. The coloured counters above the list show how many items are in each urgency band.");

  // =================================================================== PART 2
  // ---- 1. Add a lead
  g.workflow("Add a new lead");
  g.p("Use this when someone walks in, phones or writes to you. A lead you create is yours. Only the basics are needed; the CRM fills the rest and you can change it under **More details**.");
  await page.goto("/counsellor");
  await page.getByRole("button", { name: /Add Lead/i }).click();
  const dialog = page.getByRole("dialog");
  const name = personName();
  await dialog.getByLabel("Name").fill(name);
  await dialog.getByLabel("Primary mobile", { exact: true }).fill(existing.phone);
  await expect(dialog.getByText(/Already a person/)).toBeVisible();
  g.p("**If the person already exists.** After the tenth digit of the mobile number the form checks it. If the number belongs to someone at your branches you see **Already a person** (1) with their name and number of courses. Use **Add course to this person** (2) to open another course for them instead of creating a second person. Nothing is ever merged automatically.");
  await g.shot("A mobile number that already exists", [dialog.getByLabel("Primary mobile", { exact: true }), dialog.getByRole("button", { name: "Add course to this person" })], { focus: dialog });
  const phone = mobile();
  await dialog.getByLabel("Primary mobile", { exact: true }).fill(phone);
  await dialog.getByLabel("Email", { exact: true }).fill(`${name.split(" ")[0]!.toLowerCase()}.${phone.slice(-4)}@gmail.com`);
  await dialog.getByLabel("Course").selectOption({ label: "Data Science with Python, SQL, Machine Learning & Applied AI (NIT-CRS-018)" }).catch(() => dialog.getByLabel("Course").selectOption({ index: 2 }));
  await dialog.getByLabel("Original source").selectOption({ label: "Walk-in" });
  g.steps(
    "On **Counsellor Workspace** or **Leads**, press **Add Lead** (top right).",
    "Type the learner's **Name** (1), **Primary mobile** (2) and **Email** (3). The email is required.",
    "Choose the **Course** (4) they asked about, or leave it as Not decided yet.",
    "Choose the **Original source** (5), for example Walk-in, Referral or Google Ads. This is how marketing results are measured.",
    "Press **Save lead**. You land on the new lead's page (Lead 360).",
  );
  await g.shot("The New lead form", [dialog.getByLabel("Name"), dialog.getByLabel("Primary mobile", { exact: true }), dialog.getByLabel("Email", { exact: true }), dialog.getByLabel("Course"), dialog.getByLabel("Original source")], { focus: dialog });
  g.tip("Under **More details** the CRM has already set the branch, you as owner, the contact channel and entry method as last used, status New and the next follow-up two staffed hours from now. Change them only when they are wrong.");
  await dialog.getByRole("button", { name: "Save lead" }).click();
  await expect(page.getByRole("heading", { name })).toBeVisible();
  const leadId = Number(/\/leads\/(\d+)/.exec(page.url())![1]);
  g.p("**Lead 360** is the full picture of one lead. The phone number sits beside **Call** (1), **WhatsApp** (2) and **Convert to deal** (3), which stays greyed out until the lead is qualified. The bar at the top (4) always shows the one next step.");
  await dismissToasts(page);
  await top(page);
  await g.shot("Lead 360 of the new lead", [
    page.getByRole("link", { name: "Call", exact: true }).or(page.getByRole("button", { name: "Call", exact: true })).first(),
    page.getByRole("link", { name: "WhatsApp", exact: true }).or(page.getByRole("button", { name: "WhatsApp", exact: true })).first(),
    page.getByRole("button", { name: "Convert to deal" }),
    page.getByRole("region", { name: "Next step" }),
  ]);
  g.rule("If a phone number already exists at your branch the system never merges records for you; use the match box shown above or ask your Branch Manager.");

  // ---- 2. Work the lead
  g.workflow("Work a lead: record the call and the next action");
  g.p("After every call or message, record what happened. This keeps your follow-ups honest: the lead shows up again in **My work** on the date you set, and managers see overdue work.");
  const outcome = page.getByRole("heading", { name: "Save outcome" }).locator("xpath=ancestor::section[1]");
  await outcome.getByRole("radio", { name: "Connected" }).click();
  await outcome.getByLabel("Note").fill("Spoke for 10 minutes. Final-year B.Tech student, wants a job-ready course.");
  await outcome.getByLabel("Agreed next action").fill("Share syllabus and discuss timings");
  await outcome.getByRole("button", { name: "Tomorrow 11am" }).click();
  g.steps(
    "Open the lead and find **Save outcome** on the right.",
    "Pick the actual result (1): Connected, No answer, Callback requested, Demo booked, Interested, Later, Not interested, Wrong number or Stop contact.",
    "Write what was actually said in **Note** (2).",
    "Type the **Agreed next action** (3) and pick when, with a time chip such as **Tomorrow 11am** (4), or choose a date and time by hand.",
    "Press **Save outcome** (5).",
  );
  await tall(g, page, "Save outcome on Lead 360", [outcome.getByRole("radio", { name: "Connected" }), outcome.getByLabel("Note"), outcome.getByLabel("Agreed next action"), outcome.getByRole("button", { name: "Tomorrow 11am" }), outcome.getByRole("button", { name: "Save outcome" })], outcome);
  await outcome.getByRole("button", { name: "Save outcome" }).click();
  await page.waitForTimeout(1200);
  await dismissToasts(page);
  await top(page);
  g.p("The contact is now on the **Timeline** of the lead, and the checks it proves are ticked for you in the qualification checklist. A contact saved with neither a next-action date nor a clear status (Awaiting reply, Not interested, Invalid contact, Stop contact) shows as **Next action missing** in My work, so nothing is silently dropped.");
  g.rule("Choose **Stop contact** when the learner asks not to be contacted. From then on nobody can log outbound contact; only a Branch Manager or admin can clear it. Open **Record an objection** under the form when the learner gives a reason such as fee or timing.");

  // ---- 3. Qualify and convert
  g.workflow("Qualify the lead and convert it to a deal");
  g.p("A lead becomes a deal only after the six qualification checks are reviewed. Demos, fee discussions and invoices all happen on the deal.");
  const checklist = page.getByRole("heading", { name: "Qualification checklist" }).locator("xpath=ancestor::section[1]");
  await page.waitForTimeout(800);
  for (let pass = 0; pass < 3; pass++)
    for (const c of ["Genuine intent confirmed", "Reachable contact confirmed", "Intended course(s) understood", "Branch and delivery mode discussed", "Exact next action agreed", "Possible identity match reviewed"]) {
      const box = checklist.getByRole("checkbox", { name: c });
      if ((await box.getAttribute("aria-checked")) !== "true") {
        await box.click();
        await page.waitForTimeout(500);
      }
    }
  await expect(checklist.getByText("6 of 6 reviewed")).toBeVisible();
  g.steps(
    "On Lead 360 find **Qualification checklist** on the right.",
    "Tick each check you have really confirmed with the learner (1). Some are ticked by the system when the saved data proves them, for example the course and the next action.",
    "When the counter says **6 of 6 reviewed**, press **Mark Qualified** (2).",
  );
  await tall(g, page, "The six qualification checks", [checklist.getByRole("checkbox", { name: "Genuine intent confirmed" }), checklist.getByRole("button", { name: "Mark Qualified" })], checklist);
  await checklist.getByRole("button", { name: "Mark Qualified" }).click();
  const cd = page.getByRole("dialog");
  await expect(cd.getByRole("button", { name: "Convert lead to deal" })).toBeVisible();
  await cd.getByLabel("Expected close").fill(new Date(Date.now() + 10 * 86400_000).toISOString().slice(0, 10));
  g.steps(
    "The **Convert to Deal** window opens straight away. Check the **Courses** (1): the lead's own course is always included, and you can add other courses the person wants.",
    "Confirm the **Deal branch** and **Owner**, and set **Expected close** (2), the date you expect the admission.",
    "Press **Convert lead to deal** (3).",
  );
  await g.shot("Convert a qualified lead", [cd.getByRole("checkbox").first(), cd.getByLabel("Expected close"), cd.getByRole("button", { name: "Convert lead to deal" })], { focus: cd });
  await cd.getByRole("button", { name: "Convert lead to deal" }).click();
  await expect(page.getByRole("heading", { name: "Pipeline card" })).toBeVisible();
  g.p("The step bar at the top of Lead 360 now moves on to **Demo**, and a **Confirm delivery plan** panel appears on the right.");
  g.tip("Conversion creates no student, admission, receipt or LMS access. It reuses the person if they already exist and never duplicates an open course.");

  // ---- 4. Pipeline
  g.workflow("Find the deal on the pipeline, move it and set the follow-up");
  g.p("The **Deal pipeline** shows every open deal as a card in the stage it is in. Use it to see what is stuck and to set your next follow-up.");
  await page.goto(`/pipeline?q=${phone}`);
  const card = page.getByRole("article", { name });
  await expect(card).toBeVisible();
  g.steps(
    "Open **Deal pipeline**. Type the learner's name or mobile number in the search box to find the card.",
    "The card (1) shows the person, course, value, delivery-plan status, owner and expected close. **Next:** says what to do and when; **Do it** opens that step on the lead.",
    "To change the stage use **Move to...** (2) and pick the stage. *Payment review* is set by the system when a payment is recorded, so you cannot pick it. **Mark lost...** closes the card with a reason.",
    "The settings button (3) opens the card's follow-up.",
  );
  await view(g, page, "The deal card on the Counselling column", [card, page.getByLabel(`Move ${name} to stage`), page.getByRole("button", { name: `Manage ${name}` })]);
  await page.getByLabel(`Move ${name} to stage`).selectOption("Demo Scheduled");
  await expect(page.getByRole("region", { name: "Demo" }).getByRole("article", { name })).toBeVisible();
  await dismissToasts(page);
  await page.getByRole("button", { name: `Manage ${name}` }).click();
  const manage = page.getByRole("dialog");
  const at = new Date(Date.now() + 2 * 86400_000).toISOString().slice(0, 11) + "11:00";
  await manage.getByLabel("Next follow-up").fill(at);
  g.steps(
    "In the settings window set **Next follow-up** (1) to the date and time you promised the learner.",
    "Press **Save** (2). The card now carries your follow-up.",
  );
  await g.shot("Set the follow-up of the card", [manage.getByLabel("Next follow-up"), manage.getByRole("button", { name: "Save" })], { focus: manage });
  await manage.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  g.rule("As a counsellor you can move the card and set its follow-up on your own deals, but the owner field is locked: only a Branch Manager or admin changes it. Days in stage turn red after 7 days, and a blocker badge says what is stuck, for example Waiting approval or Plan not accepted.");

  // ---- 5. Demo
  g.workflow("Book a demo, then confirm or reschedule it");
  g.p("A demo is a free class with a trainer. Learners get up to two; a third needs Branch Manager approval. You book it from Lead 360 and keep it confirmed.");
  await page.goto(`/leads/${leadId}`);
  await top(page);
  await page.getByRole("button", { name: /Book a demo|Book demo/ }).first().click();
  const bd = page.getByRole("dialog");
  await page.waitForTimeout(800);
  await bd.getByRole("tab").nth(1).click();
  await page.waitForTimeout(500);
  await bd.locator("button[aria-pressed]").nth(5).click();
  g.steps(
    "On Lead 360 press **Book a demo** in the next-step bar (or **Schedule demo** under the name).",
    "In the slot picker choose the **Type** (standard 45 minutes or practical 60) and the **Mode** (in-person or online).",
    "Pick a day (1), then a free time under a trainer (2). Trainers who teach the course are listed first. Slots already follow branch hours and holidays and leave out anything the trainer already has.",
    "Press **Book demo** (3). A taken slot is refused and the list refreshes.",
  );
  await g.shot("The demo slot picker", [bd.getByRole("tab").nth(1), bd.locator("button[aria-pressed]").nth(5), bd.getByRole("button", { name: "Book demo" })], { focus: bd, });
  await bd.getByRole("button", { name: "Book demo" }).click();
  await page.waitForTimeout(1200);
  await page.goto("/demos");
  const dcard = page.getByRole("article").filter({ hasText: name }).first();
  await expect(dcard).toBeVisible();
  await dcard.scrollIntoViewIfNeeded();
  g.steps(
    "Open **Demos & counselling**. Your booking is a card with its reminders, a **Confirm** button (1) and a **Reschedule** button (2).",
    "Press **Confirm** once the learner has agreed to attend. The status changes from Scheduled to Confirmed.",
    "If the time must change, press **Reschedule**, set the new date and time and give a reason.",
  );
  await dismissToasts(page);
  await g.shot("The demo card", [dcard.getByRole("button", { name: "Confirm" }), dcard.getByRole("button", { name: "Reschedule" })], { focus: dcard, pad: 24 });
  await dcard.getByRole("button", { name: "Confirm" }).click();
  await expect(dcard.getByText("Confirmed", { exact: true })).toBeVisible();
  await dismissToasts(page);
  await dcard.getByRole("button", { name: "Reschedule" }).click();
  const rs = page.getByRole("dialog");
  await rs.getByLabel("New date / time (IST)").fill(new Date(Date.now() + (3 + Math.floor(Math.random() * 3)) * 86400_000).toISOString().slice(0, 11) + `${10 + Math.floor(Math.random() * 8)}:30`);
  await rs.getByLabel("Reason (required)").selectOption("Student requested");
  g.p("In the reschedule window enter the **New date / time** (1), choose the **Reason** (2) and press **Confirm reschedule** (3). The old demo becomes Rescheduled and its reminders are replaced.");
  await g.shot("Reschedule a demo", [rs.getByLabel("New date / time (IST)"), rs.getByLabel("Reason (required)"), rs.getByRole("button", { name: "Confirm reschedule" })], { focus: rs });
  await rs.getByRole("button", { name: "Confirm reschedule" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  g.tip("The learner gets a booking confirmation, and reminders 24 hours and 1 hour before. After the class the trainer, or you, records whether the learner attended. Open My work, tab Today, and use **Record demo outcome**; that starts the fee discussion.");

  // ---- 6. Fee discussion at standard price
  g.workflow("Fee discussion at the standard price");
  g.p("The fee discussion is one screen with two steps: first agree the price, then the delivery plan and invoice. A price with no extra concession is approved by you directly.");
  await page.goto(`/fee-quote?leadId=${leadId}`);
  await page.getByRole("button", { name: "Start fee discussion" }).click();
  await expect(page).toHaveURL(/discussionId=/);
  await page.waitForTimeout(1500);
  await dismissToasts(page);
  g.steps(
    "Open the fee discussion from the deal (the **Fee discussion** button on Lead 360, or the next-step bar) and press **Start fee discussion**.",
    "Under **Offer and price** the best eligible offer is already applied; you can switch to another eligible offer or **No offer**. Leave **Extra concession** (1) at 0.",
    "With no concession the screen says **No approval needed**. Press **Save and approve price** (2).",
  );
  const offerSec = page.getByRole("heading", { name: "Offer and price" }).locator("xpath=ancestor::section[1]");
  await tall(g, page, "Offer and price, no extra concession", [page.getByLabel("Extra concession (₹)"), page.getByRole("button", { name: "Save and approve price" })], offerSec, 1300);
  await page.getByRole("button", { name: "Save and approve price" }).click();
  await expect(page.getByRole("button", { name: "Share approved fee" })).toBeVisible();
  await dismissToasts(page);
  await top(page);
  await g.shot("Price agreed. Press Share approved fee to mark it as shared with the learner", [page.getByRole("button", { name: "Share approved fee" })], { focus: page.getByRole("heading", { name: /Step 1/ }).locator("xpath=ancestor::section[1]") });
  g.p("Step 1 now reads **Price agreed** with the version (v1), the final payable amount, and **Valid 7 more days**. Each change creates a new version; earlier ones are kept. When a version expires use **Re-issue at same price**. Press **Share approved fee** (1) after you have told the learner the price.");
  await page.getByRole("button", { name: "Share approved fee" }).click();
  await page.waitForTimeout(800);

  // ---- 7. Special closing
  g.workflow("Fee discussion with an extra concession (special closing)");
  g.p("If the learner needs a lower price than the standard fee or offer, you ask for it. The Branch Manager decides; you cannot approve a concession yourself.");
  const sc = await deal(request, { by: USERS.salesGnt });
  await page.goto(`/fee-quote?leadId=${sc.lead_id}`);
  await page.getByRole("button", { name: "Start fee discussion" }).click();
  await expect(page).toHaveURL(/discussionId=/);
  await page.getByLabel("Extra concession (₹)").fill("500");
  await page.getByLabel("Why does the learner need this concession?").fill("Comparing with another institute; ready to join this week");
  await page.waitForTimeout(1500);
  await dismissToasts(page);
  g.steps(
    "Start the fee discussion as before and type the **Extra concession** (1). The screen says at once, in plain words, who must approve, for example *Needs approval from Branch Manager (your limit ₹0)*.",
    "Explain **Why does the learner need this concession?** (2). The approver reads this.",
    "Press **Request approval** (3). The version is saved and the special closing request is sent in one click.",
  );
  const offerSec2 = page.getByRole("heading", { name: "Offer and price" }).locator("xpath=ancestor::section[1]");
  await tall(g, page, "A concession needs approval", [page.getByLabel("Extra concession (₹)"), page.getByLabel("Why does the learner need this concession?"), page.getByRole("button", { name: "Request approval" })], offerSec2, 1300);
  await page.getByRole("button", { name: "Request approval" }).click();
  await expect(page.getByText(/Waiting for approval/i).first()).toBeVisible();
  await page.waitForTimeout(1200);
  g.p("While it waits, the price card shows **Waiting for approval** (1) with the request number and the decision target, and the version is **Pending Approval** (2). The page updates by itself. A timeout never approves. You cannot do anything else with this price until a decision comes; the next-step bar on Lead 360 tells you it is waiting for the Branch Manager.");
  await dismissToasts(page);
  await top(page);
  await g.shot("The request is waiting for a decision", [page.getByText(/Waiting for approval/i).first(), page.getByText("Version 1 · Pending Approval")], { focus: page.getByRole("heading", { name: /Step 1/ }).locator("xpath=ancestor::section[1]") });
  g.rule("The Branch Manager can approve up to the lower of 5% or ₹1,000; above that, or if the manager does not decide in 5 working minutes, it escalates to the Founder / CEO. Going below 70% of the standard fee needs the Founder or Super Admin plus a second, independent approver. The manager may approve, counteroffer or reject with a reason. If it comes back as a counteroffer, press **Accept and send for approval**.");

  // ---- 8. Plan and invoice
  g.workflow("Confirm the delivery plan and create the invoice");
  g.p("Once the price is approved, confirm how and when the learner will study (the delivery plan), then bill them. The invoice button stays locked until the plan is accepted.");
  await page.goto(`/leads/${leadId}`);
  await top(page);
  const plan = page.getByRole("heading", { name: "Confirm delivery plan" }).locator("xpath=ancestor::section[1]");
  await plan.getByLabel("Planned start date").fill(new Date(Date.now() + 14 * 86400_000).toISOString().slice(0, 10));
  await plan.getByLabel("Capacity review").selectOption("Checked");
  await plan.getByRole("checkbox").click();
  g.steps(
    "On Lead 360, in **Confirm delivery plan**, check the **Delivery mode** (1): classroom, online or hybrid, and the seat type (Confirmed Seat or Future Plan).",
    "Type the **Planned start date** (2). The course's upcoming batches, when there are any, are listed to pick from; this is only a preference, the Branch Manager still allocates the batch.",
    "Record the learner's acceptance. Either press **Send for confirmation** so the learner replies YES on WhatsApp, or, if they agreed in person or on a call, tick the acceptance box (3) and say how.",
    "Press **Confirm delivery plan** (4).",
  );
  await tall(g, page, "The delivery plan panel", [plan.getByLabel("Delivery mode"), plan.getByLabel("Planned start date"), plan.getByRole("checkbox"), plan.getByRole("button", { name: "Confirm delivery plan" })], plan);
  await plan.getByRole("button", { name: "Confirm delivery plan" }).click();
  await page.waitForTimeout(1500);
  await page.getByRole("button", { name: /Create invoice/ }).first().click();
  const inv = page.getByRole("dialog");
  await inv.getByRole("button", { name: "50/50" }).click();
  const total = Number(await inv.getByLabel("Instalment 1 amount").inputValue()) * 2;
  await inv.getByLabel("Instalment 1 amount").fill("10000");
  await inv.getByLabel("Instalment 2 due date").fill(new Date(Date.now() + 5.5 * 3600_000 + 30 * 86400_000).toISOString().slice(0, 10));
  await inv.getByLabel("Instalment 2 amount").fill(String(total - 10000));
  await page.waitForTimeout(500);
  g.steps(
    "Press **Create invoice** in the next-step bar. The window shows the issuing branch and address, the learner, and every course deal of that learner at that branch. Courses with an approved fee and an accepted plan are ticked for you, so one invoice can bill several courses.",
    "Choose the payment schedule of 1, 2 or 3 instalments. The quick buttons (1) fill **Full**, **50/50** or **50/25/25**; then edit any **amount** (2) and **due date** (3). The instalments must add up to the invoice total.",
    "Press **Create invoice** (4).",
  );
  await g.shot("Create invoice with an instalment split", [inv.getByRole("button", { name: "50/50" }), inv.getByLabel("Instalment 1 amount"), inv.getByLabel("Instalment 2 due date"), inv.getByRole("button", { name: "Create invoice" })], { focus: inv });
  await inv.getByRole("button", { name: "Create invoice" }).click();
  await expect(page).toHaveURL(/\/invoices\/\d+/);
  const invoiceId = Number(/\/invoices\/(\d+)/.exec(page.url())![1]);
  await page.waitForTimeout(1500);
  g.p("The invoice opens with a banner **Invoice issued. Continue: record payment** and a **Record payment** button at the top right. The invoice shows the issuing branch, the learner, the course lines, the instalment cards and the totals; **Verified paid** stays at ₹0 until Accounts verifies a payment.");
  g.rule("An invoice cannot be edited. The branch name and address are copied onto it when it is issued. An unpaid invoice can be cancelled by a manager; Print / Save PDF gives the learner a copy. Creating an invoice does not create an admission.");

  // ---- 9. Payment
  g.workflow("Record a payment claim with proof");
  g.p("When the learner pays, you record it as a **payment claim**. It is not a receipt: Accounts has to verify it first.");
  await page.goto(`/invoices/${invoiceId}`);
  await top(page);
  await page.getByRole("button", { name: "Record payment" }).or(page.getByRole("link", { name: "Record payment" })).first().click();
  const pay = page.getByRole("dialog");
  await pay.getByLabel("Amount received (₹)").fill("10000");
  await pay.getByLabel("Tender 1 mode").selectOption({ label: "UPI / Bank Transfer" });
  await pay.getByLabel("Tender 1 reference").fill(`UPI${String(Date.now()).slice(-10)}`);
  await pay.locator("#rp-proof").setInputFiles(PROOF);
  await page.waitForTimeout(500);
  g.steps(
    "Press **Record payment** on the invoice (or in the next-step bar of Lead 360).",
    "Type the **Amount received** (1). It is split over the courses token-first: each course not yet admitted first gets what it needs to reach the ₹1,000 admission token, then the rest goes to the oldest course. You can edit every course amount.",
    "Choose the **mode** (2): cash, UPI / bank transfer, payment link / card, or cheque as an approved exception. For several payments at once, tick **Split payment**.",
    "Enter the **reference** (3), such as the UPI transaction ID.",
    "Attach the **Proof** (4), a screenshot or PDF. It is required for every mode except cash.",
    "Press **Record payment** (5).",
  );
  await tall(g, page, "Record payment", [pay.getByLabel("Amount received (₹)"), pay.getByLabel("Tender 1 mode"), pay.getByLabel("Tender 1 reference"), pay.locator("#rp-proof"), pay.getByRole("button", { name: "Record payment" })], pay);
  await toasts(page, false);
  await pay.getByRole("button", { name: "Record payment" }).click();
  await expect(page.getByText(/TXN-GNT-\d+ recorded/)).toBeVisible();
  await page.waitForTimeout(600);
  await top(page);
  g.p("A toast shows the transaction number, for example **TXN-GNT-00095 recorded**, with *pending verification (no receipt yet)*. On the invoice, the amount sits under **Pending verification** (1) with the note *not counted*; **Verified paid** (2) and **Outstanding** are unchanged. Accounts is alerted at once and aims to act within 30 minutes.");
  await g.shot("A pending claim: not counted as paid", [page.getByText("Pending verification").first(), page.getByText("Verified paid").first()]);
  await dismissToasts(page);
  g.tip("While the claim is pending the next-step bar shows the amount still needed to admit. You cannot edit or delete a claim. If you made a mistake, tell Accounts.");

  // ---- 10. After verification
  g.workflow("After Accounts verifies: receipt, admission and Student 360");
  g.p("Accounts reviews the proof and verifies the claim. You do not do this step, but you see the result straight away. You also get a bell notification (and a WhatsApp alert, when staff alerts are on) saying it was verified, with the receipt, or failed, with the reason.");
  const accounts = await as(request, USERS.accountsGnt);
  const list = (await (await request.get(`/api/v1/payments?invoice_id=${invoiceId}&status=Pending Verification`, { headers: accounts })).json()).data as { payment_id: number }[];
  const res = await verifyPayment(request, accounts, list[0]!.payment_id);
  await page.goto(`/invoices/${invoiceId}`);
  await page.waitForTimeout(1200);
  g.p("On the invoice, **Verified paid** (1) now shows the amount, **Outstanding** (2) has dropped and the status reads **Part Paid**. A receipt number such as **" + res.receipt_number + "** is issued once, per branch and financial year, and is listed on the invoice.");
  await dismissToasts(page);
  await top(page);
  await g.shot("The invoice after verification", [page.getByText("Verified paid", { exact: true }).first(), page.getByText("Outstanding", { exact: true }).first()], { focus: tiles(page), pad: 12 });
  await page.goto(`/leads/${leadId}`);
  await page.waitForTimeout(1500);
  g.p("An admission is created automatically for every course whose verified money reaches the **₹1,000 admission token** (or its whole amount, if smaller) and whose delivery plan is accepted. On Lead 360 the bar changes to **Admitted** (1) with the admission code, then waits for the LMS login and the batch, which the Branch Manager handles.");
  await dismissToasts(page);
  await top(page);
  await g.shot("Lead 360 after the admission", [page.getByRole("list", { name: "After admission" })], { focus: page.getByRole("list", { name: "After admission" }), pad: 12 });
  await page.goto(`/admissions?q=${encodeURIComponent(name)}`);
  await page.waitForTimeout(1500);
  g.p("Open **Admissions** (or **Students** for the learner's full history, called Student 360) and search the name. The admission (1) shows the accepted plan, the fee and what is still outstanding. Remaining instalments are chased by you through **Collections** and the dates you set on the invoice.");
  await dismissToasts(page);
  await top(page);
  const arow = page.getByRole("row").filter({ hasText: /NIT-GNT-\d{4}-\d+/ }).first();
  await g.shot("The new admission", [arow], { focus: arow.locator("xpath=ancestor::table"), pad: 12 });
  g.rule("A counsellor cannot cancel an admission or change its fee. After the first verified payment, a fee change needs Founder / CEO or Super Admin approval plus an Accounts correction.");

  // ---- 11. Tasks and notifications
  g.workflow("Tasks and notifications");
  g.p("The system creates tasks for you automatically, for example follow up after a demo or chase an instalment, and alerts you when something needs action. Check both at least twice a day.");
  await page.goto("/tasks");
  await page.waitForTimeout(1500);
  g.p("**Tasks** lists your open tasks, oldest due first. Open a task to complete it. A task's original deadline never changes: moving it needs a reason and both dates stay visible; blocking or cancelling also needs a reason.");
  g.p("The bell at the top and **Notifications** list alerts such as a special closing decision, a verified or failed payment, or a demo outcome recorded by the trainer. Action-required alerts are tracked until someone acts.");

  // ---- Front Office (overview, last in Part 1 order is enforced by builder)
  g.overview("How Front Office differs")
    .p("**Front Office** staff use the same screens and the same steps as above: add leads, record outcomes, qualify, convert, demo, fee, invoice and payment. The differences are about cover and walk-ins:")
    .bullets(
      "**Walk-ins and first response.** New enquiries without a staff attempt alert Front Office after 2 minutes, then the Branch Manager at 10 minutes and the Founder at 30. Front Office is usually the first person to call back.",
      "**Cover on any branch lead.** Front Office can save outcomes and record payments on any lead of the branch, as cover for the owner. Helping never changes the owner.",
      "**Handover.** The **Handover** tab of My work lets you pass a lead to a cover colleague with a note of what was promised; the cover person helps without becoming the owner.",
      "**Same limits.** You cannot assign leads, approve discounts, verify payments or touch settings, and the contact rules (Stop contact, call and message limits) apply to you too.",
    );
  g.save();
});
