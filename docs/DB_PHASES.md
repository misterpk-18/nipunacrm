# Nipuna CRM — Database Build Phases

Tables are created in dependency order: a table is only built once everything it references exists.
Derived from the prototype at https://nipuna-crm-frozen-demo.nipunatech.chatgpt.site/ (sample data only).

**Core flow:** Enquiry/Lead → Counselling → Demo → Fee discussion (offer versions) → Special closing approval → Admission → Payments (verified ledger) → Collections → Batch/LMS → Placement

Every record is branch-scoped (NIT-GNT Guntur, NIT-VIJ Vijayawada). One canonical **Person** can have many leads and admissions.

Migration files live in `db/` and are applied in numeric order, each in its own transaction (009 must commit before 010):

```bash
psql -d nipunacrm -v ON_ERROR_STOP=1 -1 -f db/<file>.sql
```

The dev replica (`nipunacrm-dev`) and the pytest database (`nipunacrm_test`) are rebuilt from the same files — see [DEVELOPMENT.md](DEVELOPMENT.md#3-databases).

| Phase | Status | Migration |
|---|---|---|
| 0 — Foundation | ✅ Done | `001_courses.sql`, `002_phase0_foundation.sql` |
| 1 — People & sales pipeline | ✅ Done | `003_phase1_people_pipeline.sql` |
| 2 — Commercials | ✅ Done | `004_phase2_commercials.sql` |
| 3 — Admission & money | ✅ Done | `005_phase3_admission_money.sql` |
| 4 — Academics | ✅ Done | `006_phase4_academics.sql` |
| 5 — Operations | ✅ Done | `007_phase5_operations.sql` |
| 6 — Management & extras | ✅ Done | `008_phase6_management.sql` |
| Prototype alignment | ✅ Done | `009_prototype_alignment_enums.sql`, `010_prototype_alignment.sql` |
| Auth support | ✅ Done | `011_auth.sql` — forced password change, failed-login lockout |
| Prototype v1.1 | ✅ Done | `012_prototype_v1_1.sql` — invoices, correction requests, demo reminders, imports, saved views |
| Demo course optional | ✅ Done | `013_demo_course_optional.sql` — `demos.course_id` nullable |
| Intake → genuine sync | ✅ Done | `014_lead_intake_sync_genuine.sql` — lead Invalid-Spam / Test excludes its enquiries from Genuine Enquiries |
| Offer once per person | ✅ Done | `015_offer_once_per_person.sql` — a person can use each offer only once |
| Complimentary rules | ✅ Done | `016_complimentary_rules.sql` — one complimentary course per offer per admission; never a course the person already has |

Phases 0–3 cover the complete sales-to-cash flow and are the MVP. Phases 4–6 can follow as their screens are built.

> **Read the "Prototype alignment" section at the end.** A full review of the prototype changed several earlier decisions (roles, payments before admission, advisory floor, fee changes). Where a phase section below disagrees with it, the alignment section wins.

---

## Phase 0 — Foundation ✅

| Table | Purpose |
|---|---|
| `branches` | NIT-GNT, NIT-VIJ; code, name, city, receipt prefix (`GNT`, `VIJ`) |
| `roles` | Super Admin, Branch Manager, Counsellor, Admissions, Accounts, Academic Coordinator, Placement Team, Trainer |
| `users` | Staff logins; role, home branch (NULL = company-wide), case-insensitive unique email |
| `user_branches` | Extra branches a user can work in besides their home branch |
| `courses` | Standalone courses and combos (`is_combo`), standard fee, status |
| `course_branches` | Which branches offer each course (FK to `branches.branch_code`) |
| `combo_courses` | Component courses inside a combo; `is_bonus` marks the "+1" in a 3+1 combo |
| `lead_sources`, `contact_channels`, `entry_methods`, `payment_modes`, `lost_reasons` | Admin-editable dropdown values |
| `audit_log` | Append-only change history (UPDATE/DELETE blocked by trigger) |

Shared: `set_updated_at()` trigger keeps `updated_at` current on every table that has it.

## Phase 1 — People & sales pipeline ✅

| Table | Purpose |
|---|---|
| `number_sequences` | Counters behind readable codes; `next_number(key)` is concurrency-safe and gap-free (moved here from Phase 3) |
| `persons` | Canonical person; `person_code` auto-generated per branch (`PER-GNT-00001`). Phone indexed but not unique (siblings may share) |
| `leads` | Enquiry; `lead_code` auto-generated (`LD-00001`): person, course (optional), branch, source, channel, entry method, intake status, assigned user, stage, next follow-up, AI priority, lost reason / competitor / reactivation date |
| `lead_activities` | Timeline: calls, WhatsApp, notes, stage changes. Stage changes are logged automatically by trigger |
| `demos` | Lead, course, branch, time, duration (default 45 min), mode, trainer, status, reminder timestamps (confirmation / 24h / 1h), feedback, rating |

Lead stages: New Enquiry → Counselling → Demo Scheduled → Demo Attended → Fee Discussion / Payment Awaited → Payment Pending Verification → Admitted / Lost - closed

Rules enforced by the database:
- Moving a lead to `Lost - closed` requires `lost_reason_id`.
- A person can have only one open lead per course per branch (a new one is allowed after Admitted / Lost).
- Every stage change writes a `lead_activities` row. The app should run `SET LOCAL app.current_user_id = '<id>'` per transaction so it is attributed to the user.

## Phase 2 — Commercials ✅

| Table | Purpose |
|---|---|
| `offers` | Offer Master: `offer_code` + `version` (editing an Active offer = new version row); benefit (amount / percent / complimentary course), stacking, qualifying payment rule, validity dates |
| `offer_branches`, `offer_courses` | Scope when the offer isn't for all branches / all courses |
| `offer_complimentary_courses` | Free course with a minimum final fee (e.g. Advanced Excel when fee ≥ ₹15,000) |
| `payment_plans` + `payment_plan_installments` | Plan templates as % of fee with due days after admission. Seeded: Full Payment (100% on day 0) |
| `concession_limits` | Max extra concession each role can approve. Seeded: Branch Manager = lower of 5% or ₹1,000; Super Admin = unlimited. Roles without a row can't approve |
| `fee_discussions` | One negotiation per lead + course; `discussion_code` auto-generated (`FD-00001`); milestone; invoice number |
| `fee_discussion_versions` | v1, v2, v3…: standard fee, offer + offer discount, extra concession, final payable, floor, plan, valid until |
| `special_closing_requests` | Extra concession approval; `scr_code` auto-generated (`SCR-00001`); 5-minute decision target |

Rules enforced by the database:
- An offer can only be `Active` with an approver and start/end dates.
- Fee versions: `version_no` auto-increments; floor defaults to 70% of standard fee; validity defaults to 7 days or offer end, whichever is first.
- `final_payable` must equal standard fee − offer discount − extra concession, and can't go below the floor.
- Amounts on a saved version can't be edited (status can) — make a new version instead.
- Special closing: no self-approval; approver's role limit is checked; rejection needs a reason; `decided_at` is stamped automatically; only one pending request per version.

## Phase 3 — Admission & money ✅

| Table / view | Purpose |
|---|---|
| `admissions` | `admission_code` auto-generated per branch per year (`NIT-GNT-2026-000001`): person, lead, accepted fee version, course, original vs service branch, delivery mode, final fee, plan, counsellor, enrolment / curriculum / handover / LMS status, cancellation, `first_verified_payment_at` |
| `installments` | Generated automatically from the payment plan when the admission is created (rounding goes to the last installment) |
| `payments` | Immutable ledger. Receipts per collecting branch per financial year (`GNT-R-2627-00001`); reversals get `GNT-RV-2627-00001` |
| `payment_promises` | Collections promise-to-pay (Pending / Kept / Broken / Cancelled) |
| `refund_cases` | `NIT-RF-00001`: registration → financial decision → payout → reconciliation, each recorded separately |
| `refund_case_receipts` | Receipts a refund case relates to |
| `admission_balances` (view) | Final fee, verified paid, pending verification, waived, refunded, outstanding |
| `installment_dues` (view) | Per installment: covered / balance (verified money applied oldest-first), due position, days overdue, age band, contact hold |

Also added: role `FOUNDER_CEO` (company-wide, unlimited concession), function `fy_code(date)` → `'2627'`.

Rules enforced by the database:
- Admission `final_fee` must match the accepted fee version; fee, plan and admission date are frozen afterwards. Plan installments must add up to 100%.
- Creating an admission marks the fee discussion `Converted`.
- Payments can't be edited or deleted. Only verification changes, once: Pending Verification → Verified / Failed. Corrections are Reversal rows (exact negative of a Verified payment, one per payment).
- A payment mode that needs a reference (UPI, card, cheque) can't be saved without one. Payments can't exceed the outstanding amount (pending included).
- First verified payment stamps `first_verified_payment_at` ("New Paid Admission" date) and moves the lead to `Admitted`.
- Pending Verification money is excluded from verified totals and puts the student on contact hold.
- Cancelling an admission needs who, when and why.
- Refund / waiver decisions: Founder / CEO or Super Admin only; refund can't exceed verified payments. Payout can't be done by the decider, can't exceed the approved amount, and `Completed` requires reconciliation.

Ageing bands: 1–3 · 4–7 · 8–15 · 16–30 · 31–60 · 61–90 · 91+ days

## Phase 4 — Academics ✅

| Table / view | Purpose |
|---|---|
| `batches` | `batch_code` auto-generated per branch (`GNT-B-0001`): course (standalone only), branch, mode, trainer, schedule, dates, capacity, status, LMS course id |
| `batch_allocations` | Admission → batch. Combo admissions get one active allocation per component course. `joining_date` = first confirmed regular class (demos excluded) |
| `admission_transfers` | Service-branch history; inserting a transfer moves `admissions.service_branch_id` (original branch never changes) |
| `document_types` | Seeded: Identity proof (mandatory), Photograph, Address proof, Education certificate |
| `documents` | Uploaded files (path to storage), review status, reviewer, rejection reason |
| `certificates` | One live certificate per admission per course; number on issue per service branch + FY (`GNT-C-2627-00001`) |
| `batch_occupancy` (view) | Capacity, allocated, seats left per batch |
| `document_checklist` (view) | Each admitted person × each mandatory document type → Not Uploaded / Review Required / Verified / Rejected |

Also added: `persons.lms_user_id` (unique — one LMS identity per person), `persons.lms_provisioned_at`, `admissions.lms_last_synced_at`, `admissions.lms_last_activity_at`.

Rules enforced by the database:
- Batches can't be created for combo courses. An allocation's batch course must be the admission's course or one of its combo components.
- One active allocation per admission per course; batch capacity can't be exceeded; no allocations to cancelled admissions or completed/cancelled batches.
- Changing batch = close the allocation (`Moved` / `Withdrawn` / `Completed`, with `ended_at`) and create a new one; closed allocations can't be reopened.
- First allocation moves enrolment `Awaiting Batch Allocation` → `Scheduled`; first joining date moves it to `In Progress`.
- Transfers take `from_branch` from the admission's current service branch and must go to a different branch.
- Documents: one live file per person per type (re-upload only after rejection); rejection needs a reason; review time stamped automatically.
- Certificates: issuing assigns the number and time; issued/revoked certificates can't be re-issued (create a new one); revoking needs who, when and why.

## Phase 5 — Operations ✅

| Table / view | Purpose |
|---|---|
| `branch_channels` | Each branch's WhatsApp number / email / phone line; Manual or API |
| `communications` | Unified inbox: every message and call, direction, delivery status, failure reason, retry link, person/lead match, response SLA |
| `task_types` | Seeded: Call, Follow-up, Demo, Fee Discussion, Approval, Payment Verification, Collections, Document Review, Academic, Refund Case, General |
| `tasks` | Work queue: type, branch, owner (NULL = unassigned), team role, workflow status, original + revised deadline, one linked record (lead / demo / fee discussion / SCR / admission / payment / refund case / document / communication), `dedupe_key` for system tasks |
| `notification_rules` | Event → recipient role, warn / escalate minutes, escalation role. Seeded: SCR pending → Branch Manager (warn 4m, escalate 5m → Founder / CEO); payment pending verification → Accounts (warn 25m, escalate 30m → Branch Manager) |
| `notifications` | Separate timestamps for delivered, read, acknowledged, action completed; warn / escalate times; escalation chain; external WhatsApp / email status |
| `task_board` (view) | Due date (revised or original), overdue, due today, unassigned, linked record code |
| `communication_inbox` (view) | Queue (Match Review / Failed / Missed Calls / Awaiting Reply / Manual Activity) and SLA state (Within SLA / At Risk / Breached / Met / Met Late) |
| `notifications_due_for_escalation` (view) | Action-required notifications past escalation time and not yet escalated — the worker polls this |

Also added: `lead_activities.communication_id` links a timeline entry to its inbox item.

Rules enforced by the database:
- Task statuses are workflow only; Overdue / Unassigned are derived in `task_board`.
- A task links to at most one record. `original_due_at` never changes; a revised deadline needs a reason; Waiting/Blocked needs a reason; Cancelled needs a reason; Completed stamps who and when. Completed / Cancelled tasks can't be reopened.
- `dedupe_key` stops system jobs creating the same task twice.
- Inbox: a Matched item must have a person; Failed needs a reason; an item needing a response needs a due time.
- Notifications are deduplicated by event + linked record + recipient + purpose. Acknowledging marks it read; action completion only on action-required notifications. Rule thresholds fill warn / escalate times; escalations are category Escalation with no further timers.

Not in the database (app / worker jobs): creating tasks and notifications from events, sending reminders, collections escalation (Day −3 … Day 30, broken promises), staffed-hours SLA calculation.

## Phase 6 — Management & extras ✅

| Table / view | Purpose |
|---|---|
| `app_settings` | Admin-editable key/value settings (timezone, alumni support months, refund targets, SLA at-risk minutes) |
| `branch_shifts`, `holidays` | Staffed hours per branch per weekday, and holidays (branch or all). Seeded placeholder: Mon–Sat 09:00–19:00 |
| `target_versions`, `target_lines` | Target Master: version (`TM-2026-10-v1`) with a period, approved as a whole; one line per branch plus Company (NULL branch); NULL measure = Not Set |
| `support_extensions` | Alumni support extensions beyond the standard period |
| `companies`, `job_openings` | Employers and openings (`JOB-00001`): title, type, mode, location, skills, CTC, source, last verified, owner, status |
| `placement_profiles` | One per person: readiness, CV + review, skills, preferences, referral consent, evidence status |
| `job_applications`, `application_events` | Pipeline Applied → Shortlisted → Interview Scheduled → Interview Attended → Selected → Offer Received → Offer Accepted → Joined (+ Rejected / Withdrawn / Offer Declined); timeline incl. interview no-shows |
| `integration_status` | Seeded from prototype: WhatsApp (Manual), Email, Telephony, HDFC, LMS (Planned), Scheduled report email (Configured) |
| `incidents` | Incident register (`IR-00001`): severity, owner, status, resolution, backup reference |
| `scheduled_reports` | Report schedules: frequency, time, period, recipients, format, last delivery |
| `target_achievement` (view) | Approved targets vs actual verified collections (collecting branch, payment date) and paid admissions (original branch, first verified payment date), with % |
| `alumni` (view) | People with at least one authorised completion; alumni since, also-active flag, support until / active |

Also added: `add_staffed_minutes(branch_id, start, minutes)` → deadline in staffed time (skips closed hours, off days, holidays); `admissions.academic_completed_at`, `completion_authorised_by`, `support_until`.

Rules enforced by the database:
- Approving a target version needs an approver; it automatically supersedes any overlapping approved version (history kept). Only one approved version can cover a day. Lines are locked once the version leaves Draft; superseded versions can't be re-approved.
- Marking an admission `Completed` needs `completion_authorised_by`; it stamps completion time and `support_until` (+6 months from `app_settings`).
- Support extensions: Founder / CEO or Super Admin only; must be later than the current end; updates `admissions.support_until`.
- Placement: applications need explicit referral consent and an Open job; one application per profile per job; every stage change is logged; `Joined` needs a joined date; a no-show is an event, not a closure.
- Incidents: resolving stamps `resolved_at`. Scheduled reports need at least one recipient.

## Prototype alignment (009–010) ✅

A full text review of the prototype found rules the phase-by-phase build had missed or contradicted. These migrations fix them.

### Changed decisions
| Area | Before | Now |
|---|---|---|
| Roles | One `users.role_id`; invented Counsellor / Admissions | `user_role_scopes`: many role + branch scopes per user, with expiry / revocation. Roles: Founder / CEO, Super Admin, Branch Manager, Sales, Front Office, Accounts, Academic Coordinator, Trainer, Placement Team, HR, Student. `user_has_role(user, roles[], branch)` for checks. `users.role_id`, `home_branch_id` and `user_branches` removed |
| Payments vs admission | Payment needed an admission | Payments belong to a **person**; they can be an unallocated advance, allocated to an accepted fee discussion, or to an admission. Each allocation link is set once |
| Admission | Could be created any time | Needs (1) an accepted confirmed delivery plan on the fee version and (2) a Verified payment allocated to that discussion. Creation links those payments, moves the lead to Admitted and the discussion to Converted |
| 70% floor | Hard block | Advisory. Below-floor approval needs Founder / CEO or Super Admin **plus** an independent approver on the special closing request |
| Extra concession | Could be saved as Approved directly | A version with extra concession (or below floor) is Approved only after a matching special closing request is Approved |
| Fee after admission | Frozen forever | `admission_fee_changes`: Founder / CEO or Super Admin approves (no self-approval), Accounts applies; installments are rebuilt; can't go below verified payments |
| Lookup values | Partly invented | Prototype values: sources, channels, entry methods, payment modes (Cheque is exception-only and needs an independent approver), intake status (New / Incomplete / Duplicate Review / Outreach Prospect) |
| Lead stages | Could move anywhere | Admitted is final; Payment Pending Verification can only go to Admitted or Lost |

### Added
| Table / view / function | Purpose |
|---|---|
| `enquiries` | Every enquiry (`ENQ-00001`) incl. repeats; lead keeps `original_source_id` / `original_channel_id` / `original_entry_method_id` / `original_enquiry_id`; `is_genuine` for "Genuine Enquiries" |
| `leads.ai_score`, priority "Waiting for Batch / Future Joining" | "Hot · 92" |
| `demos.demo_type`, `extra_demo_approved_by`, `commercial_follow_up_due_at` | Standard ≤ 45 min, Practical ≤ 60; 3rd demo after 2 attended needs Academic Coordinator / Branch Manager; follow-up due 2 staffed hours after attendance |
| `fee_discussions` delivery plan fields, `fee_shared_at` | Accepted confirmed delivery plan (version, mode, seat type, planned start); "Fee Shared" milestone |
| `special_closing_requests` counteroffer + independent approval | Approve / Counteroffer / Reject; decision due = 5 **staffed** minutes; approver limit = highest across their scopes |
| `payment_plan_installments.due_days_min/max` | Due-date windows; seeded Two Instalments (50% Day 0 + 50% Day 10–15, default 12) and Three Instalments (50/25/25 Day 0/10/15) |
| Complimentary admissions | `admissions.complimentary_of_admission_id`, `offer_id`, `access_until`; `offer_complimentary_courses.access_period_days`; needs an active offer, fee threshold and a verified qualifying payment |
| `admissions.seat_type`, `planned_start_date`, record / finance / academic owners | Confirmed Seat vs Future Plan |
| `batch_allocation_queue` (view) | Allocate-by (confirmed: 1 working day and before first class; future: 48h before start) and escalate-at (24h before start) |
| `curriculum_versions`, `admission_curricula` | "Published v2026.1"; `Mapped` needs a mapping |
| `support_cases`, `support_case_types` | General support cases (`SUP-00001`), optionally linked to a refund case |
| `ai_insights`, `ai_queries`, `ai_feedback` | Briefs, priority explanations, suggested messages, Ask Nipuna Q&A with sources / scope / freshness; feedback Helpful / Incorrect / Not Useful / Missing Context |
| `user_sessions`, `active_sessions` (view) | 30-min idle timeout, 12-hour max, fresh-auth flag |
| `deletion_requests` | Sensitive deletion needs an independent approver |
| `report_runs`, `scheduled_reports.schedule_day` | Cutoff / refresh / completeness log; weekly and monthly schedules |
| `unallocated_advances` (view), `admission_balances.payment_completion` | Unpaid / Part Paid / Paid |
| `persons.preferred_language` | English / Telugu |
| Refund targets | `decision_due_at` = 7 working days, `payout_due_at` = 18 working days after approval |
| `add_working_days()`, `working_day_end()`, `business_tz()` | Working-day helpers |
| Tasks | Can link to support cases and enquiries |

## Prototype v1.1 alignment (012) ✅

Source: the Lovable project's code (`prototype/`), checked by running it with Playwright.

### Changed decisions
| Area | Before | Now |
|---|---|---|
| Invoice | `fee_discussions.invoice_number` | `invoices` table (`INV-GNT-2627-0001`, per collecting branch + FY), issued from an **Approved** fee version; carries Day 0, agreed due days, terms, plan. Re-issuing before any payment supersedes the old invoice; invoices are immutable except status and a fee-change revision |
| Instalments | Built per admission at admission time | Built per **invoice** when it's issued (Day 0 + agreed days or plan defaults), so dues exist before the admission (`installments.invoice_id`; `admission_id` removed) |
| Payment allocation | To a fee discussion or an admission | To an **invoice** (`payments.invoice_id`; NULL = unallocated advance). `admission_id` is filled automatically. Cap = invoice billed amount |
| Admission | From an accepted fee version + verified payment on the discussion | From an **invoice** (`admissions.invoice_id`): accepted plan on the invoice's version + a verified payment on the invoice. Records `first_qualifying_payment_id`. Parties, fee and plan come from the invoice |
| Reversals | Inserted directly | Only through `payment_correction_requests`: requested by Accounts / Founder / Super Admin for a Verified, un-reversed receipt; decided by a *distinct* Founder / CEO or Super Admin; approval appends the reversal (`REV-GNT-2627-00001`, verified by the approver) |
| Fee change | Updated admission + instalments | Also revises the invoice amount (`original_billed_amount`, `revised_at`) |
| Batch allocation | Any branch; curriculum not checked | Same service branch only; curriculum must be Mapped (and match the batch's curriculum version); Paused / Completed / Cancelled enrolments blocked |
| Demo reminders | Three timestamp columns | `demo_reminders` rows (Booking confirmation / 24h / 1h) created on booking, **Skipped** if already past, **Superseded** on reschedule, **Cleared** on cancel, **Not needed** after attendance / no-show |

### Added
| Table / column / view | Purpose |
|---|---|
| `invoices`, `invoice_balances` (view) | Invoice register: billed, verified paid, pending (never counted), waived, outstanding, completion, state |
| `payment_correction_requests` | `CR-GNT-0001`; one pending per receipt; links the reversal it produced |
| `demo_reminders`; `demos.demo_code` (`DM-GNT-0001`), `trainer_feedback`, `outcome`, `recommended_course_id`, `commercial_owner_id`, `next_follow_up_at`, `cancel_reason`, `reschedule_reason` | Demo scheduling, outcomes and reminders (`feedback` → `student_feedback`, `next_step` → `next_action`) |
| `lead_imports`, `lead_import_rows` | CSV import review: row validation issues, Ready / Duplicate Review / Invalid / Imported, created lead |
| `saved_views` | Lead list saved filters (5 shared views seeded) |
| `leads.campaign`, `leads.remarks`, `persons.whatsapp_number` | Lead capture fields |
| `lead_activities.purpose`, `lead_activities.demo_id` | Follow-up log (purpose + response) and demo timeline entries |
| `batches.curriculum_version_id`, `location`, `min_students`; `batch_occupancy.is_full` | Batch workspace |
| `payments.proof_file_path` | Payment proof |
| `tasks.invoice_id`, `tasks.correction_request_id` | Task links |
| Lookups | Source `Meta Ads`, entry method `CSV import`, intake statuses `Invalid-Spam`, `Test` |
| Views rebuilt | `installment_dues` (invoice level, includes pre-admission invoices), `unallocated_advances` |

## Demo course optional (013) ✅

| Change | Why |
|---|---|
| `demos.course_id` is nullable (NULL = no course chosen at booking) | A lead can attend a demo before deciding on a course. Booking uses the course passed in, else the lead's course, else none. `recommended_course_id` still records the course suggested after the demo |

## Lead intake → genuine enquiries (014) ✅

| Change | Why |
|---|---|
| `trg_leads_sync_enquiry_genuine` (AFTER UPDATE OF `leads.intake_status`) → `sync_lead_intake_to_enquiries()` | Staff classify the lead, but the Genuine Enquiries count reads `enquiries`. Moving a lead into Invalid-Spam / Test sets `is_genuine = FALSE` on all its enquiries; moving it out sets `is_genuine = TRUE` (re-classified by staff); other status changes leave enquiries alone |
| Backfill | Enquiries of leads already in Invalid-Spam / Test with `is_genuine` NULL → FALSE |

## Offer once per person (015) ✅

A person can use each offer only once. "Using" an offer = an admission that applies it — as the offer on the admission's fee version (discount offers) or as the offer granting a complimentary admission. All versions of an offer (same `offer_code`) are the same offer.

| Added | Purpose |
|---|---|
| `person_offer_redemptions` (view) | Every non-cancelled admission that applied an offer: person, offer code / id, admission, `redemption_admission_id` (the paid admission for complimentary courses), used as Fee offer / Complimentary course |
| `check_offer_once_per_person()` + `trg_admissions_z_offer_once` (BEFORE INSERT on `admissions`, after `trg_admissions_before_insert`) | Refuses an admission whose offer the person already used on a different admission: "Offer X has already been used by this person (admission NIT-…); an offer can be used only once per person". Takes a per-person advisory lock so two concurrent admissions can't both use it |

Rules:
- The paid admission and the complimentary course(s) granted on top of it are one use.
- Cancelled admissions don't count — cancelling the admission that used an offer makes it available to that person again (assumption, to confirm).
- The API also hides used offers from the fee version picker and refuses them when saving a version or issuing an invoice, so the block normally shows before any payment.

## Complimentary rules (016) ✅

| Change | Why |
|---|---|
| `trg_admissions_zz_complimentary_rules` (BEFORE INSERT on `admissions`) → `check_complimentary_rules()` | An offer listing several complimentary courses gave all of them on one paid admission, and a free course could duplicate one the learner already had (found on PER-GNT-00082: two DIWALI freebies, one the same Data Science course she paid for) |
| Rule 1 | One complimentary admission per offer (same `offer_code`, any version) per paid admission |
| Rule 2 | The complimentary course can't be one the person already has a non-cancelled admission for |
| Order | `zz_` runs after `trg_admissions_z_offer_once`, so "offer already used" wins when both apply. Cancelled admissions don't count; existing rows are not changed |
