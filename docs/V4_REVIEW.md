# UI V4 — developer response

Response to [Nipuna-CRM-UI-V4-Developer-Handoff-2026-09-29.pdf](Nipuna-CRM-UI-V4-Developer-Handoff-2026-09-29.pdf) ("Requested developer response": review URL, completed checks, backend gaps, delivery estimate). Build plan and phase status: [V4_PLAN.md](V4_PLAN.md).

| | |
|---|---|
| **Review URL** | Not deployed yet. The build runs on the development database (`nipunacrm-dev`); the AWS test server gets it on the go-ahead (migrations 017–022, see [DEPLOYMENT.md](DEPLOYMENT.md)). |
| **Built** | 29 Sep 2026 — live CRM (Flask API + PostgreSQL + React), not a demo: real permissions, branch scoping, persistence and document numbers |
| **Tests** | Backend 205 passed · end-to-end 83 passed (3 device-specific skips), 0 failed, on desktop (1440 px) and phone (Pixel 7; 360 px checks) against a freshly seeded database |

## Acceptance checklist (handoff page 4)

| Check | Result | How it was checked |
|---|---|---|
| **Visual consistency** — hierarchy, spacing, typography, cards, buttons, the four lead colours on desktop and mobile | ✅ | Open Sans, `#6251DA` accent, `#F8F9FC` background, V4 cards / chips / tabs; lead chips with dot + label (Hot / New `#E8F8EE`, Warm `#FFF2D6`, Cold `#EAF2FF`, Future joining `#F0EAFA`). Screens compared side by side with the published V4 site at 1440 / 390 / 360 px. e2e `v4-shell` |
| **Lead actions** — phone visible, WhatsApp green, conversion needs qualification, preserves person / course links, no admission at conversion | ✅ | Lead 360 action row (phone · Call · WhatsApp `#25D366`/`#083E20` · Email · Convert to deal, wraps on phones); Convert disabled until all six checks are reviewed and Mark Qualified; the person is reused and open courses are returned, not duplicated; conversion creates no admission, receipt or LMS access. Backend `test_qualify_convert.py`; e2e `sales` "a lead is qualified and converted…" |
| **Branch pipeline** — stage counts, filters and Next actions per branch; empty stages and filter reset | ✅ | Seven chips (Admitted / Closed lost all-time per branch), chip filters board and list, "Show all stages" resets; Next actions in V4 order with Review deal. e2e `sales` pipeline test and `v4-deals` "next actions and stage counts follow the branch" (Vijayawada manager sees only Vijayawada; empty Closed lost column) |
| **Branch invoice** — create from both branches, correct address and issuer snapshot, branch filter never rewrites an invoice | ✅ | Issuer snapshot stored on the invoice (legal name, branch, address, phone, email, accent). Guntur violet `#6251DA`, Vijayawada teal `#137E89`, PDF addresses. Changing the branch address or the viewer's branch filter leaves issued invoices unchanged. Backend `test_invoice_rules`; e2e `v4-deals` "branch invoice: Vijayawada…" |
| **Courses and identity** — one course, several courses together, a later course for the same student; combine only compatible deals; no duplicate invoices | ✅ | Create-invoice dialog lists the learner's deals at the branch; only approved-fee + accepted-plan + uninvoiced + open ones can be ticked (others show why). Different person / branch refused; a course already invoiced refused. Two-course invoice → two admissions for one person; a later third course reuses the same person / student. Backend `test_multi_course_invoice_combines_only_compatible_deals`, `test_multi_course_allocation_split_tenders_and_line_caps`; e2e `v4-deals` "two courses on one invoice…" |
| **Payment scenarios** — full, partial / token then balance, multiple instalments; pending never collected; right receipt and allocation per verified payment | ✅ | Full and partial payments, ₹600 then ₹400 reaching the ₹1,000 token, 50/50 and 1,000/9,000/20,000 schedules; split checkout = one transaction per tender, allocated per course, no course over-paid. Pending claims have no receipt number and never count. Backend `test_payments.py`, `test_admissions.py`; e2e `finance`, `v4-deals` |
| **Finance consistency** — total, verified paid, balance, receipts, dues and reports agree; no repeated verification or duplicate creation | ✅ | Sample case below checked on the invoice document, invoice list, collections and the admission balance. Verification happens once (422 on repeat); one admission per course line (unique), manual create returns 409 if already admitted. Backend `test_sample_acceptance_case` |
| **Responsive + documents** — desktop and 360 / 390 px, action wrapping, dialogs, cards, invoice layout, actual print / PDF | ✅ | No horizontal scroll at 360 px on invoice, record payment, Lead 360 and pipeline (e2e `v4-deals` @mobile). Invoice tables stack as cards on phones. Print shows only the invoice (or receipt), A4 with colours; a real PDF was generated with Chromium and its text checked (issuer, lines, balance, receipts; no app chrome). e2e `v4-deals` "Print / Save PDF" |
| **Production behaviour** — roles and branch access enforced on the backend; reload persistence; unique document numbers; linked records | ✅ | Every rule is enforced by the API and PostgreSQL (roles, branch scope, triggers); records persist; numbers come from gap-free per-branch sequences (`TXN-GNT-00001`, `GNT-R-2627-00001` at verification only, `INV-GNT-2627-0001` + line `-L1`, `DP-00001`, `NIT-GNT-2026-000001`). Backend 205 tests incl. 403 / 404 cases |

**Sample acceptance case** — invoice ₹22,000; ₹5,000 claim pending → verified paid ₹0, balance ₹22,000; after verification → one receipt, paid ₹5,000, balance ₹17,000, consistent across the invoice, invoice list, collections and admission. Covered by backend `test_sample_acceptance_case` and e2e `v4-deals` "sample case", and present in the staging seed (Sana Begum, Vijayawada — pending, ready to verify).

## Lifecycle (handoff page 2)

| Step | Built |
|---|---|
| 1. Qualify and convert | Six-check review, Mark Qualified, Convert (courses, branch, owner, expected close); same person reused |
| 2. Accept delivery plan | Per course: service branch, mode, seat type, planned start, capacity review, student acceptance (`DP-00001`) |
| 3. Create invoice | One or more compatible courses; issuer snapshot; no admission created |
| 4. Record payment | Payment claim (`TXN-…`), allocated per course, one per tender; balance unchanged |
| 5. Verify payment | Evidence reviewed (+ cash check); receipt issued; each course reaching ₹1,000 verified is admitted, reusing one person / student |
| 6. Grant LMS access | Separate: LMS access screen is a read-only status list (no live LMS) |

## Intentional differences from V4

| Area | V4 | Built |
|---|---|---|
| Pipeline | One deal per course | One **person card per branch** with a shared stage; each course is still its own deal (Lead 360, invoice line, admission) |
| Payment plans | Full; 50/50 with day 10–15; 50/25/25 on day 0/10/15 | **Flexible 1–3 instalments** — any dates from today and any amounts adding up to the total (Full / 50/50 / 50/25/25 are quick fills); ₹1,000 token; due-soon and long-gap alerts |
| Admission trigger | Any verified payment on an eligible line | Once **₹1,000 is verified on the course** (or its whole amount, if smaller) |
| Fees | No fee step | Fee discussions with versions, offers (once per person), special closing approvals and the 70% advisory floor stay; the approved version is the invoice line price |
| Banner | "SAMPLE DATA — NO LIVE INTEGRATIONS" | Not shown (live system) |
| Contact actions | Simulated | Call opens `tel:`, WhatsApp `wa.me`, Email `mailto:` (no telephony / WhatsApp API integration) |

## Backend gaps and open decisions

| Item | State |
|---|---|
| Tax / GSTIN and bank details on invoices | Left off until approved values are provided |
| LMS provisioning and recovery (V4 "Review Recovery", "Safe retry") | Not built — read-only LMS status list until a real LMS exists |
| AI assistant suggestions | Rule-based fallback; LLM not connected |
| HDFC / WhatsApp / email / telephony integrations | Not connected (as in V4) |
| Header "Search anything ⌘K" | Header search finds persons; the all-records palette is not built |
| Independent cash check | A recorded tick; the verifier is not yet required to be a different person from the collector |
| Decisions to confirm | Demos / fees only after conversion; chip counts all-time; conversion keeps an existing card's owner; promises per invoice ([BACKLOG.md](BACKLOG.md) D8–D11) |

## Delivery estimate

| Remaining | Size |
|---|---|
| Deploy to the AWS test server as the review URL (backup, migrations 017–022, frontend build, smoke test) | S (under a day), on the go-ahead |
| Changes from the review and the decisions above | S–M, depending on feedback |
| Tax / bank details on the invoice template, once values are approved | S |
| LMS provisioning, integrations | Separate projects |
