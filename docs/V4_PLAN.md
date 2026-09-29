# V4 handoff — implementation plan

Plan for bringing the app in line with [Nipuna-CRM-UI-V4-Developer-Handoff-2026-09-29.pdf](Nipuna-CRM-UI-V4-Developer-Handoff-2026-09-29.pdf).
Status: **built on `nipunacrm-dev` (29 Sep 2026) — Phases 1–9 done, Phase 10 done except the AWS review deploy**
(waiting for the go-ahead; see [DEPLOYMENT.md](DEPLOYMENT.md)). Migrations 019–022; nothing committed. The main `nipunacrm`
database, commits and AWS deploys happen only when asked. Results against the handoff checklist: [V4_REVIEW.md](V4_REVIEW.md).

| Phase | Status | Where |
|---|---|---|
| 1. Look and shell | ✅ | FRONTEND_PLAN §3a |
| 2. Qualify and convert | ✅ db 019 | API step 21 · DB_PHASES 019 |
| 3. Pipeline screen | ✅ | API step 21 · FRONTEND_PLAN §3b |
| 4. Delivery plan per course | ✅ db 020 | DB_PHASES 020 |
| 5. Multi-course invoice, per-course payments | ✅ db 021 | DB_PHASES 021 |
| 6. Payments and receipts | ✅ db 022 | DB_PHASES 022 |
| 7. Automatic admission | ✅ (service, on verification; db 021 per-line rule) | API step 21 |
| 8. Branch invoice templates | ✅ print / PDF checked | FRONTEND_PLAN §3b |
| 9. New screens | ✅ | FRONTEND_PLAN §3a |
| 10. Acceptance and handover | ✅ tests, seed, docs, review · ⏳ AWS deploy | V4_REVIEW.md |

## What we take from V4, and where we differ on purpose

**Taken from V4:** multi-course invoices with per-course payment allocation, the per-course delivery plan, receipt
numbers issued only at verification, the full visual redesign, and the Open Sans font.

**Kept as our own design** (intentional deviations — tell the V4 reviewer):

| Area | V4 | Ours |
|---|---|---|
| Pipeline | One deal per course | One **person card per branch** with a shared stage (db 017), now gated by V4's qualification checklist and Convert |
| Instalments | Fixed payment plans | Our **flexible 1–3 instalment schedule**: free dates and amounts, ₹1,000 token, due-soon and long-gap alerts (db 018) |
| Admission | Created on any verified payment | Created automatically once **₹1,000 is verified** on a course line (or its whole amount, if smaller) |
| Fees | No fee step | Fee discussions, versions, special closing and the 70% floor stay; the course's approved version becomes the invoice line price |

**Left out:** the "SAMPLE DATA" banner (demo only) and anything V4 simulates (contact actions, AI, LMS provisioning).

## Phases

Each phase ends with a working app, backend tests, e2e tests and updated docs.
Sizes are relative: S ≈ a day, M ≈ 2–3 days, L ≈ a week.

### 1. Look and shell (L)

- **Theme:** Open Sans; `#6251DA` accent and `#F8F9FC` page background as theme tokens; V4's cards, buttons and chips.
- **Sidebar:** V4's groups and names —
  - Workspace: Overview, My work, AI assistant
  - Sales: Leads, Deal pipeline, Demos & counselling
  - Learning: Students, Admissions, Batches, LMS access
  - Finance: Invoices, Payments & receipts, Collections, Refunds
  - Operations: Tasks, Communications, Placement & alumni, Reports
  - plus a Workflow guide
- **Mobile:** bottom nav bar (Home / Leads / Pipeline / Payments / AI); layouts checked at 360 and 390 px.
- **Lead colours:** chips with a dot and a text label —
  Hot / New `#E8F8EE` / `#167341` / dot `#1A9B52`; Warm `#FFF2D6` / `#925600` / `#D89314`;
  Cold `#EAF2FF` / `#2459A6` / `#3476CC`; Future joining `#F0EAFA` / `#7445A4` / `#9562C7`.
- **WhatsApp:** buttons in `#25D366` with text `#083E20`.
- **Overview dashboard:** four KPI cards, collections chart, admission pipeline bars, "Your attention" tabs and branch
  pulse. Existing KPIs stay, including Long-gap plans.

### 2. Qualify and convert (M · DB 019)

- **Qualification checklist:** a table of the six checks (genuine intent; reachable contact; intended course(s)
  understood; branch and delivery mode discussed; exact next action agreed; possible identity match reviewed — never
  auto-merged), with who reviewed each and when. "Mark Qualified" needs all six ticked. It never changes the stage.
- **Convert to deal:** `POST /leads/{id}/convert` with courses (several allowed), branch, owner and expected close date;
  only for a qualified lead.
  - Reuses the person. Creates a lead for each extra course; a course that is already open is returned, not duplicated.
  - Moves the courses to Counselling, so the person's card opens or they join it.
  - Creates no admission, receipt or LMS access.
- **Pipeline rule change:** a lead joins the pipeline **only through Convert**, no longer on its first stage change
  (replaces 017's rule). The expected close date is stored on the card.
- **Lead 360 action row:** phone number, Call, WhatsApp, Email and Convert to deal, wrapping on mobile; the checklist
  panel sits on the right.
- **Existing cards and leads** are treated as already converted.

### 3. Pipeline screen (M)

- **Seven stage chips:** Counselling, Demo scheduled, Demo attended, Fee discussion, Payment review, Admitted, Closed
  lost. Counts are for the selected branch; clicking a chip filters the board; "Show all stages" clears it.
- **Board columns:** Counselling | Demo | Fee discussion | Payment review, plus Admitted and Lost columns when those
  chips are chosen. List view as well.
- **Cards:** person, courses, value (sum of approved or standard fees), delivery-plan status, owner, expected close.
- **Header:** open opportunities, open value, number admitted.
- **Next actions** (`GET /pipeline/next-actions`, per branch), each with a "Review deal" link: review payment evidence,
  record demo outcome, confirm delivery plan, prepare invoice, follow up balance.

### 4. Delivery plan per course (M · DB)

- **Fields:** `DP-00001` code, service branch, mode, seat type (Confirmed Seat / Future Plan, kept from today), planned
  start date, capacity review (checked / waiting), "student acceptance captured" tick, accepted by and when.
- **Replaces** today's accept-plan on the fee discussion; existing data is migrated.

### 5. Multi-course invoice with per-course payments (L+ · DB — biggest and riskiest phase)

- **Invoice lines:** one row per course with its lead, fee version and amount. The invoice holds the person, branch,
  total and schedule.
- **Create invoice dialog** (from the card or the course):
  - Issuer preview: issuing branch and its address.
  - Courses: only eligible ones can be ticked — same person and branch, approved version, accepted delivery plan, not
    yet invoiced, not lost.
  - Schedule: the flexible 1–3 instalments move here from the fee version and apply to the invoice total.
  - After creating, the invoice opens and each included course shows "View invoice".
- **Branch details:** address, phone and email columns on branches (admin-editable, seeded with the two addresses in
  the PDF). Each invoice keeps a snapshot, so later branch edits never change an issued invoice.
- **Payments:** a payment can be split across course lines; a split checkout creates one pending transaction per
  tender; no line can be paid beyond what is left on it.
- **Balances:** each course line has its own balance. Instalment dues stay at invoice level; money covers the oldest
  instalment first.
- **Also reworked for lines:** fee changes, refunds, corrections, advances, collections and reports.

### 6. Payments and receipts (M · DB)

- **Record payment:** gets a `TXN-GNT-00001` number; Payments opens with the invoice preselected (`/payments?invoice=`).
- **Verify:** the receipt number `GNT-R-2627-00001` is issued only here. Two confirmations: evidence reviewed, and an
  independent check for cash.
- **Receipt:** printable document. A pending payment shows as a "Payment claim" with no receipt number.

### 7. Automatic admission (M · DB)

- **When:** on verification, each course line with an accepted delivery plan and at least ₹1,000 verified (or its
  whole amount, if smaller) gets its admission — once, reusing the person / student.
- **New Admission** becomes an eligibility review screen. Complimentary courses stay manual.

### 8. Branch invoice templates (M)

- **Colours:** Guntur violet `#6251DA`, Vijayawada teal `#137E89`.
- **Contents:** issuer block, bill-to, course lines, payment terms, totals, verified paid, balance, instalment cards,
  verified receipts.
- **Print:** print preview that saves to PDF; real PDF output is checked.
- **Mobile:** tables become stacked cards.
- **Tax and bank details:** only once approved values are provided.

### 9. New screens (S–M)

- **LMS access:** admissions with their LMS status, read-only.
- **My work:** the counsellor's queue plus their tasks.
- **Workflow guide:** static page.

### 10. Acceptance and handover (M)

- Backend tests, e2e tests and seed update; every item in the PDF's acceptance checklist, including the sample case:
  ₹22,000 invoice → ₹5,000 pending shows ₹0 paid and ₹22,000 balance → after verification one receipt, ₹5,000 paid,
  ₹17,000 balance.
- Docs updated, deployment to the AWS test server as the review URL, and a gap report.

## Build order

1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10. Phase 1 is independent and can run alongside Phases 2 and 3.

## Decisions made while building (confirm — also in [BACKLOG.md](BACKLOG.md) D8–D11)

- A new enquiry for a person who already has an open card **stays in Leads** until it is converted (017 used to put it on the card straight away).
- Converting onto an existing card **keeps that card's owner**; the dialog's owner applies to a new card.
- **Re-issue:** an invoice no longer supersedes an earlier one automatically; cancel the unpaid invoice first (its courses become invoiceable again).
- **Promises to pay** belong to the invoice (all its courses), and work before admission.
- The **receipt numbers** that pending / failed payments had been given at recording were cleared by 022 (they were never receipts); verified ones kept theirs.
- An automatic admission the database refuses (e.g. offer already used) is **skipped with a Branch Manager task** and stays on the eligibility review.

## Open questions (recommended default used unless decided otherwise)

1. **Before conversion:** can a lead get a demo or fee discussion before it is converted? Default: **no** — booking a
   demo or starting fees on an unconverted lead asks to qualify and convert first, matching V4's order.
2. **Admitted / Closed-lost chip counts:** all-time per branch, or this period only? Default: **all-time**, as in V4.
3. **LMS access:** default **read-only list**; V4's provisioning and recovery flow waits for a real LMS.
4. **Tax, GSTIN and bank details on invoices:** default **left off** until approved.
