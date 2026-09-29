# Nipuna CRM — Backlog

Decisions waiting on the product owner, and API gaps found while connecting the frontend (26–27 Sep 2026). Every gap below has a frontend workaround today; none blocks use. When one is done, move it to the "As built" notes in [API_PLAN.md](API_PLAN.md) and delete it here.

---

## 1. Decisions needed

| # | Question | Today |
|---|---|---|
| D1 | Should counsellors move a lead to **Payment Pending Verification** by hand? | The API allows it once the lead has a course (per the prototype and API_PLAN); the frontend never offers it — only recording a payment sets it |
| D2 | File storage for documents / CVs / certificates in production (S3, local disk, other)? | Local disk (`UPLOAD_DIR`) |
| D3 | Real shift hours per branch | Mon–Sat 09:00–19:00 placeholder drives all SLA deadlines |
| D4 | Password policy / MFA at launch | 10-char minimum, lockout after 5 failures |
| D5 | LLM for AI features | Rule-based fallback; OpenAI + LangSmith keys are in `.env` for later (code reads `ANTHROPIC_API_KEY` today) |
| D6 | Production hosting | Plan: nginx serving `frontend/dist` and proxying `/api` to gunicorn on one origin |
| D7 | Offer once per person — what counts as "used" | Built: used = an admission applies the offer (discount or complimentary); counted per person across all versions of the offer; a cancelled admission releases it. Confirm cancellation should release it, and whether a still-open fee discussion or issued invoice should also reserve the offer |
| D8 | V4 open questions (defaults built — confirm) | (1) A lead gets demos / fee discussions only after qualify + convert; (2) Admitted / Closed-lost chip counts are all-time per branch; (3) LMS access is a read-only list until a real LMS exists; (4) tax / GSTIN / bank details are left off invoices until approved values are provided |
| D9 | V4 · conversion owner | Converting onto an existing card keeps that card's owner; the owner in the dialog applies to a new card only. Confirm, or let conversion reassign the card |
| D10 | V4 · independent cash check | Recorded as a tick at verification; should the verifier also have to be someone other than the collector for cash? |
| D11 | V4 · promises to pay | Moved to the invoice (one promise per invoice, shared by its courses). Confirm per-invoice rather than per-course promises |

## 2. API gaps

### Missing endpoints / filters

| Area | Gap | Frontend workaround |
|---|---|---|
| Collections | No endpoint to set / clear **contact hold** on dues | Shown and filterable, not editable |
| Placement | No list of placement profiles | "Profiles ready / consent recorded" metrics replaced by application metrics; profiles picked via students |
| Leads | No `person_id` filter on `GET /leads` | Student 360 finds a person's opportunities by phone search (`lead_status=All`). Person 360 uses `GET /persons/{id}/overview` instead |
| Fees | No company-wide list of fee discussions | Fee screen without a lead shows lead search + leads in the fee stage |
| Workspace | `GET /leads/workspace` counts only the user's own leads | Managers' tab counts use one `GET /leads?queue=…&per_page=1` per queue |
| Dashboard | Company view has no funnel | Fetched from `/reports/funnel` |
| Pipeline | Lead-level assign / follow-up (`/leads/{id}/assign`, `/follow-up`) don't update the person's card | Use the card's settings on the Pipeline screen (it updates the card and every open course) |
| Workspace | The Counsellor Workspace / My work still lists open leads (courses), not pipeline cards | A person with two courses shows twice there |
| Convert dialog | No `person_id` filter on `GET /leads`, so "existing open deals" are found by phone search | Good enough for the warning; the API returns existing deals as `existing` anyway |
| Demos | No way to record a past demo; list row lacks `extra_demo_approved_by` | Outcome only after start time; extra-demo button inferred from "attended demos" |

### Responses that return bare IDs (extra requests to show names)

| Endpoint | Missing |
|---|---|
| Batch allocations, `GET /batches/{id}/allocation-check` | learner name, allocated by |
| `GET /communications` | person name |
| `GET /tasks/{id}` | `linked_record` code, `created_by`; admission link lacks `person_id` |
| `POST /ai/next-best-action` | lead name / code / stage |
| `GET /job-openings` | placement owner name |
| Payment promises, refund cases | names for `recorded_by`, `decided_by`, `payout_executed_by`, `created_by` |
| `GET /payments` rows | `reversed_by_payment_id` (only on detail) — "Request correction" may show on a corrected receipt; the server refuses it |
| `GET /invoices` rows | next due date, due position, admission code |

### Inconsistencies

- `GET /admin/sessions`: unpaginated and always `current: false`.
- `GET /collections/ageing`: empty bands return `balance: 0` (number) instead of `"0.00"`.
- `POST /batches` with `curriculum_version_id: null` skips the "use the published version" default (omit the field instead).
- Role checks that differ from the prototype wording: refund payout / reconcile are Accounts-only (not admins); approve extra demo is Academic Coordinator / Branch Manager only; `/concession-limits` and `/offers` are admin / BM only, so counsellors can't see their limits or pick offers for complimentary courses.

### Code vs plan (found while rewriting API_FLOWS.md)

- `GET /branches/{id}` and `/branches/{id}/shifts` only need login and `get_branch` has no branch-scope check (plan: admins; §2: out-of-scope single reads → 404). Decide whether branch details are meant to be visible to everyone.
- Recovery-account access: the `RECOVERY_ACCESS` audit row is written inside the request transaction, so it's rolled back when the request fails (≥ 400); only the log line survives, although `routes/decorators.py` says failed requests are audited too.
- Empty-PATCH check is duplicated: `controllers/common.require_changes()` vs inline copies in `controllers/users.update_user` and `controllers/masters._require_changes`.
- Locking an account after 5 failed logins also resets `failed_login_attempts` to 0 (undocumented until now).

### Seed data

- Notifications only exist for Accounts users until events occur.
- No offers are seeded, so complimentary courses can't be exercised on a fresh seed.

## 3. Prototype features without an API (left out of the frontend)

- Dashboard tiles: outstanding (verified basis), dues recovery, captured leads, top courses by net verified.
- Report sections: course enrolment & revenue drill-down, source / campaign with record links, trainer batches, upcoming / overdue dues.
- Admin: AI configuration, retention, backup / recovery status.
- LMS "Open LMS" / live sync, "Open class link", collecting branch on admissions, email resend, channel status chips, support-period extensions (endpoint exists, not exposed).
