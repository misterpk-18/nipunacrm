# Nipuna CRM — Development

Everything needed to build, run, test and ship the CRM, and where the project stands.

| Part | Covers |
|---|---|
| [Part A — Local development](#part-a--local-development) | Repository layout, `.env`, databases, staging accounts, running and testing |
| [Part B — Frontend](#part-b--frontend) | Frontend decisions, structure, screen → API map, V4 look, porting prototype changes |
| [Part C — Test deployment (AWS EC2)](#part-c--test-deployment-aws-ec2) | The EC2 test server (personal AWS account only): layout, redeploy, migrations, backups, stop / start |
| [Part D — V4 handoff: plan and review](#part-d--v4-handoff-plan-and-review) | The V4 UI handoff: phases, acceptance results, deviations, remaining work |
| [Part E — Backlog](#part-e--backlog) | Open product decisions and API gaps |

---

## Part A — Local development

How to set up, run and test the CRM locally. Architecture and conventions: [API.md · Part A (build plan)](API.md#part-a--build-plan-and-endpoints) (backend), [Part B (frontend)](#part-b--frontend) (frontend), [DATABASE.md](DATABASE.md) (schema).

---

### 1. Repository layout

```
nipuna-crm/
├── backend/      Flask API (routes → controllers → services → repositories → models), pytest suite, CLI
├── frontend/     React SPA (Vite + TanStack Router/Query), Playwright e2e tests
├── db/           Numbered SQL migrations — the source of truth for the schema
├── prototype/    Lovable prototype — reference only for layout and wording; it will keep changing
├── docs/         All project documentation (this folder)
└── venv/         Python virtualenv
```

### 2. Configuration (`backend/.env`)

| Variable | Purpose |
|---|---|
| `APP_ENV` | `development` (uses the dev database), `test`, `production` |
| `DATABASE_URL` | Main database `nipunacrm`; production config |
| `DEV_DATABASE_URL` | Dev replica `nipunacrm-dev` with staging data; used when `APP_ENV=development` |
| `TEST_DATABASE_URL` | Optional; defaults to `DATABASE_URL` + `_test` (`nipunacrm_test`) |
| `SECRET_KEY`, `LOG_LEVEL`, `UPLOAD_DIR` | App settings |
| `OPENAI_API_KEY`, `LANGSMITH_*` | Reserved for future AI work — not read by the code yet |
| `LMS_BASE_URL`, `LMS_SERVICE_KEY` | Nipuna LMS the `lms-sync` job posts to (local: `http://127.0.0.1:5060`); the key is the LMS's `CRM_SERVICE_KEY` — get it from the LMS owner, never commit it. Unset = events wait in `lms_outbox` |
| `LMS_TIMEOUT_SECONDS` | Optional, default 10 |

`backend/.env.example` lists the same variables without secrets.

### 3. Databases

| Database | Used by | Rules |
|---|---|---|
| `nipunacrm` | Main database | Never used by local development or tests |
| `nipunacrm-dev` | Local API + frontend + e2e tests | Rebuildable replica with staging data |
| `nipunacrm_test` | pytest | Rebuilt from `db/*.sql` on every run |

Rebuild the dev replica and load staging data (from `backend/`, venv active):

```bash
flask --app app create-dev-db --yes     # drops and replays db/*.sql (refuses names not ending in -dev / _test)
flask --app app seed-dev                # staging data, created through the real API so every rule applies
```

The seed (`backend/cli/seed.py`) creates 20 staff accounts, 8 courses (both branches), curricula and 5 batches, 22 leads in both branches — new, **qualified but not converted** (Ravi Teja), converted deals at every pipeline stage (qualification checklist + Convert, db 019), demos, approved fee discussions, **accepted delivery plans**, invoices with their own 1–3 instalment schedules, payment claims and verified receipts, 7 admissions created on verification with batch allocations, a **two-course invoice paid with split tenders** giving two admissions for one person (Meera Joshi), the V4 **₹22,000 invoice with a ₹5,000 cash claim pending** (Sana Begum), an overdue instalment with an invoice promise, a long payment gap, a refund case, tasks, communications, a support case, companies and a job opening, this month's approved targets and an incident.

Logins, password and seeded walkthrough records: [Staging accounts](#staging-accounts) (below).

### 4. Running

```bash
# API on :5050 (macOS AirPlay occupies :5000)
cd backend && source ../venv/bin/activate
APP_ENV=development flask --app app run --port 5050

# Frontend on :5173 (proxies /api → 127.0.0.1:5050; override with VITE_API_TARGET)
cd frontend && npm install && npm run dev
```

Open http://localhost:5173 and sign in with a staging account.

Other backend commands (from `backend/`): `flask --app app create-admin` (first admin on a fresh database), `flask --app app jobs list | run [name…]` (background jobs), `flask --app app create-test-db`.

**LMS sync locally** (db 026, [API.md · Step 22](API.md#step-22--lms-sync-outbox--dev-only)): run the LMS on :5060 (`cd nipunalms/backend && APP_ENV=development ../venv/bin/flask --app app run --port 5060`, its own `nipunalms-dev` database), set `LMS_BASE_URL` / `LMS_SERVICE_KEY` in `backend/.env`, then:

```bash
APP_ENV=development flask --app app lms backfill          # events for everything that exists (re-runnable)
APP_ENV=development flask --app app lms deliver --loop    # or: flask jobs run lms-sync (cron)
APP_ENV=development flask --app app lms outbox --failed   # counts by status / type, errors
APP_ENV=development flask --app app lms pull              # status pull (or: flask jobs run lms-status-pull, every 5 min)
APP_ENV=development flask --app app lms holds             # pulled records waiting to apply, and why
APP_ENV=development flask --app app lms backfill --branches   # BranchUpserted for every branch (db 029)
APP_ENV=development flask --app app lms finance-snapshot --force   # BranchFinanceSnapshot now (job: every 15 min)
```

**Round 2 (db 027–028):** the CRM mirrors the LMS's academic state (login, LMS status, enrolment, curriculum, batches, allocations, completion, certificates) and its academic screens are read-only while `academics_managed_in_lms` is on. On a dev database that still has the CRM's own batches, run `flask --app app lms drop-crm-batches --yes` once (deletes the CRM's own batches and every allocation; refuses anything but `-dev` / `_test` databases), then `flask --app app lms pull`. Create batches in the LMS (Academic → Batches): seed batches never come through the pull. The test suite runs with `academics_managed_in_lms` off (conftest) so the CRM's own academic rules stay covered; `tests/test_lms_pull.py` turns it on.

Every payment verification, admission change, course edit and money change now writes outbox rows; the LMS owner checks them in the LMS Super Admin screen **CRM sync** (`/admin/crm-sync`). Local only: never point this at real student data until the service key, transport and retention are agreed.

### 5. Testing

| Suite | Command | Notes |
|---|---|---|
| Backend | `cd backend && ../venv/bin/pytest -q` | Rebuilds `nipunacrm_test`; each test runs in a rolled-back transaction |
| Frontend types | `cd frontend && npm run typecheck` | |
| Frontend build | `cd frontend && npm run build` | Type-check + production build into `dist/` |
| End-to-end | `cd frontend && npx playwright test` | Needs the API (dev DB) and Vite running; desktop + `@mobile` projects |

E2E specs live in `frontend/e2e/` (`auth-leads`, `sales`, `finance`, `academics`, `operations`, `management`, `v4-shell`, `v4-deals`); `e2e/helpers.ts` has the staging users, `login()` and API setup helpers for the V4 flow (`qualifyAndConvert`, `approvedFee`, `acceptDeliveryPlan`, `createInvoice`, `recordPayment`, `verifyPayment`). `E2E_BASE_URL` points Playwright at another Vite port. Tests create their own records with unique phones/names, so they can be re-run without reseeding. Run one Playwright process at a time — parallel runs share `test-results/` (use `--output=<dir>` if you must run two).

### 6. Docs to keep up to date

All documentation is four files in `docs/`:

| File | Holds | Update when you… |
|---|---|---|
| [PRODUCT_GUIDE.md](PRODUCT_GUIDE.md) | Product behaviour (Part A), roles and permissions (Part B) | Change a business rule, role, screen access, approval or setting |
| [DATABASE.md](DATABASE.md) | Migrations and the rules the schema enforces | Add or change a migration (status table + section) |
| [API.md](API.md) | Architecture, conventions, every endpoint (Part A), execution flows (Part B) | Add or change an endpoint (endpoint table + "As built"; also `backend/api.http`) |
| DEVELOPMENT.md (this file) | Setup and testing (A), frontend (B), deployment (C), V4 status (D), backlog (E) | Change setup or test commands, a screen or frontend convention, the server or deploy steps (C: "Applied so far"), or find a gap / make a product decision (E) |

The V4 handoff PDF (`Nipuna-CRM-UI-V4-Developer-Handoff-2026-09-29.pdf`) is the source for Part D; it is no longer in `docs/` but can be restored from git.

### Staging accounts

Login accounts for testing. Locally they exist **only in the dev database `nipunacrm-dev`**, created by `flask --app app seed-dev` (re-created on every reseed); they are not in the local `nipunacrm`. They are also loaded into the **EC2 test server's** `nipunacrm` (https://13-201-78-226.sslip.io), see [Part C (deployment)](#database).

- URL: http://localhost:5173 (API on :5050 with `APP_ENV=development` — see [Part A (local development)](#4-running))
- Password for every account: **`Nipuna-staging-1`**

#### One account per role

| Role | Email | Branch | Lands on |
|---|---|---|---|
| Founder / CEO | `founder@nipuna.test` | All branches | Dashboard |
| Super Admin | `admin@nipuna.test` | All branches | Dashboard (+ Admin / Settings) |
| Branch Manager | `bm.gnt@nipuna.test` | Guntur | Branch Manager view |
| Sales (counsellor) | `sales.gnt@nipuna.test` | Guntur | Counsellor Workspace |
| Front Office | `fo.gnt@nipuna.test` | Guntur | Counsellor Workspace |
| Accounts | `accounts.gnt@nipuna.test` | Guntur | Dashboard |
| Academic Coordinator | `coordinator.gnt@nipuna.test` | Guntur | Dashboard |
| Trainer | `trainer.g1@nipuna.test` | Guntur | Dashboard |
| Placement | `placement.gnt@nipuna.test` | Guntur | Dashboard |
| HR | `hr.gnt@nipuna.test` | Guntur | Dashboard |

#### Vijayawada accounts

Same roles, same password: `bm.vij`, `sales.vij`, `fo.vij`, `accounts.vij`, `coordinator.vij`, `placement.vij`, `hr.vij` (all `@nipuna.test`). Trainers: `trainer.v1@nipuna.test`, `trainer.v2@nipuna.test`. Guntur also has a second trainer, `trainer.g2@nipuna.test`.

#### Notes

- There is no Student account: the role exists, but the CRM has no student-facing screens.
- Display names match the prototype, e.g. `sales.gnt` is "Counsellor A (GNT)", `fo.gnt` is "Front Office B (GNT)".
- The e2e tests use these accounts (`frontend/e2e/helpers.ts`) — don't change their passwords or deactivate them.
- Five failed logins lock an account for 15 minutes; a reseed resets everything.
- Never reuse this password or these accounts outside the dev database and the EC2 test server. On the server they must go before any real data does.

#### V4 walkthrough (seeded records)

| Scenario | Record | Sign in as |
|---|---|---|
| Qualified lead, ready to convert | Ravi Teja (Vijayawada, Leads) | `fo.vij` / `bm.vij` |
| Deals at every stage, Next actions | Deal pipeline, either branch | `sales.gnt`, `sales.vij`, `bm.*` |
| Delivery plan accepted, ready to invoice | Karthik Reddy (Vijayawada) — "Prepare the invoice" | `sales.vij` |
| Two courses on one invoice, split tenders, two admissions for one person | Meera Joshi · `INV-GNT-2627-0005` | `sales.gnt`, `accounts.gnt` |
| Sample case: ₹22,000 invoice with a ₹5,000 cash claim pending | Sana Begum · `INV-VIJ-2627-0004` — verify it on Payments & receipts | `accounts.vij` |
| Overdue instalment with a promise to pay | Divya Sree · `INV-GNT-2627-0002` (Collections) | `accounts.gnt` |
| Long payment gap | Charan Teja (Performance tab → Long-gap plans) | `accounts.vij` |

---

## Part B — Frontend

React single-page app in `frontend/`, connected to the Flask API (`backend/`, see [API.md · Part A (build plan)](API.md#part-a--build-plan-and-endpoints)). The Lovable prototype in `prototype/` stays as the **reference** for layout and wording; it will keep changing, and changes are ported screen by screen (see "Porting prototype changes").

---

### 1. Decisions

| Decision | Choice | Why |
|---|---|---|
| App type | SPA in `frontend/` (not Flask templates) | The prototype is already React; its components and screens carry over |
| Framework | Vite + React 19 + TanStack Router (file routes, SPA) + TanStack Query | Same libraries as the prototype, without TanStack Start / SSR (every screen is behind a login; no SEO) |
| UI kit | shadcn/Radix components, Tailwind 4 and the theme copied from the prototype | Same look as the prototype |
| API origin / CORS | Vite dev server proxies `/api` → Flask (:5050). Production: reverse proxy serves `dist/` and `/api` on one origin | No `flask-cors` needed |
| Auth | Bearer session token from `/auth/login`, kept in memory + `sessionStorage` | Server enforces idle timeout, max session, revocation; a tab close ends the session |
| Fresh auth | Client catches `FRESH_AUTH_REQUIRED`, prompts for the password (`/auth/reauthenticate`) and retries once | Sensitive admin actions work without special handling per screen |
| Role gating | `src/auth/access.ts` mirrors the backend role checks (probed against the API); nav + route guard use it | UI convenience only — the API is the enforcement |
| Branch scope | Header switcher (locked when the user has one branch); list requests send `branch_id` | Mirrors the prototype's branch scope |
| Forms | react-hook-form; server `error.details` mapped onto fields | The backend returns per-field validation errors |
| Money / dates | Money stays a string (`money()`, `sumMoney()` in paise); datetimes sent with `+05:30`; displayed in IST | Matches API conventions |
| Testing | Playwright against the dev stack (`nipunacrm-dev`), one spec per module group | Tests exercise real triggers and permissions |

### 2. Structure

```
frontend/
├── src/
│   ├── api/            client.ts (fetch, errors, auth hooks) · types.ts · reference.ts (lookups, branches, courses, staff)
│   │                   one file per module: leads.ts, demos.ts, fees.ts, payments.ts, …
│   ├── auth/           auth.tsx (session, branch scope, fresh-auth dialog) · access.ts (role → screens)
│   ├── components/ui/  shadcn components (copied from the prototype)
│   ├── components/crm/ app-shell.tsx · ui.tsx (PageHead, DataTable, QueryView, ConfirmAction, …) · forms.tsx
│   ├── features/       screen components per group: leads/, sales/, finance/, academics/, operations/, management/
│   ├── lib/            format.ts · mutation.ts (useApiMutation)
│   └── routes/         thin route files, same paths as the prototype
├── e2e/                Playwright specs per group (auth-leads, sales, finance, academics, operations, management, v4-shell) + helpers.ts
└── vite.config.ts      /api proxy → 127.0.0.1:5050
```

### 3. Screens → API

| Screen (route) | Main endpoints | Group |
|---|---|---|
| Login, change password, account (`/login`, `/change-password`, `/account`) | `/auth/*` | core |
| Persons, Person 360 (`/persons`, `/persons/$personId`) | `/persons`, `/persons/{id}/overview` | leads |
| Leads, Lead 360 (`/leads`, `/leads/$leadId`) | `/leads*` (Active leads by default; `lead_status` filter), `/saved-views`, `/lead-imports`, `/persons`, `/staff`, `/pipeline-entries/{id}` | leads |
| Counsellor workspace, Pipeline, Demos, Fee discussion, Discount approvals | `/leads/workspace`, `/pipeline` (person cards), `/pipeline-entries*`, `/demos*`, `/fee-discussions*`, `/special-closing-requests*` | sales |
| Invoices, Payments, Collections, Refunds | `/invoices*`, `/payments*`, `/correction-requests*`, `/collections/*`, `/payment-promises*`, `/refund-cases*` | finance |
| Admissions, New admission, Batches, LMS access, Students / Student 360, Course Master | `/admissions*`, `/batches*`, `/curriculum-versions*`, `/students*`, `/documents*`, `/courses*`, `/payment-plans*` | academics |
| My work, Workflow guide, Tasks, Communications, Notifications, Placement & Alumni | `/tasks*`, `/communications*`, `/notifications*`, `/companies`, `/job-*`, `/alumni` | operations |
| Dashboard (Overview / Performance), Branch Manager, Reports, Target Master, Offer Master, Admin / Settings, AI Copilot, Ask Nipuna, More | `/dashboard*` (incl. `/dashboard/overview`), `/reports*`, `/targets*`, `/offers*`, `/users*`, `/settings`, `/integrations`, `/incidents`, `/audit-log`, `/ai/*` | management |

### 3a. V4 look and shell

From the V4 handoff ([Part D (V4 plan)](#part-d--v4-handoff-plan-and-review), Phases 1 and 9). `prototype/` is no longer the visual reference; the published V4 UI is.

- **Theme tokens** (`src/styles.css`, `:root`): Open Sans (Google Fonts, `index.html`); `--primary #6251DA`, `--background #F8F9FC`, `--border #E7E9F0`, `--radius 0.75rem`, white sidebar; lead-chip and WhatsApp colours as `--lead-*` / `--whatsapp*`. A `.dark` token set exists for later. Cards (`.panel`, `.metric-card`): white, 1px border, 12px radius. Buttons 8px radius; tabs are underline tabs (`components/ui/tabs.tsx`); tables have a light header row and no uppercase.
- **Sidebar** (`auth/access.ts` `NAV_GROUPS`, gated with `allowed()`): Workspace (Overview, My work, AI assistant) · Sales (Leads, Deal pipeline, Demos & counselling) · Learning (Students, Admissions, Batches, LMS access) · Finance (Invoices, Payments & receipts, Collections, Refunds) · Operations (Tasks, Communications, Placement & alumni, Reports) · More (`MORE_ITEMS`: Persons, Counsellor Workspace, Branch Manager, Discount Approvals, Offer / Target / Course Master, Notifications, Ask Nipuna, Admin / Settings) · Workflow guide pinned at the bottom with the signed-in person. Leads shows the new-enquiry count, Payments & receipts the claims awaiting verification. No "SAMPLE DATA" banner.
- **Header**: person search (sales roles), branch switcher ("All Branches", locked for single-branch users), Ask Nipuna (managers), notifications, account avatar menu.
- **Phone** (< 768px): bottom bar of five items from `mobileNavItems(roles)` — sales roles Home / Leads / Pipeline / Payments / AI; Accounts Home / Invoices / Payments / Collections / Tasks; coordinators and trainers Home / Admissions / Batches / Tasks / Students; others Home / Tasks / Students / Alerts / More. The sidebar opens from the header. Checked at 360 and 390 px (no horizontal page scroll). `<DataTable stack>` turns a table into labelled cards on phones (opt-in).
- **Shared components** (`components/crm/ui.tsx`): `LeadChip({ value, label? })`, `PriorityChip({ priority, score? })` and `leadTone(value)` — dot + text in the lead colours (Hot / New / New Enquiry green, Warm amber, Cold blue, Waiting for Batch / Future Joining violet); `Status` renders lead priorities and "New Enquiry" as lead chips automatically. `KpiCard` (label, tinted icon, value, hint, link), `StatTile` (label + count, optional filter toggle), `Avatar`, `WhatsAppButton`; Button variant `whatsapp` (`#25D366` / `#083E20`). `PageHead` takes an `eyebrow` (defaults to the branch scope).
- **Overview** (`/dashboard`, `features/management/overview.tsx`): tabs Overview / Performance (`?tab=performance`). Overview: four KPI cards (open enquiries, admissions, verified collections, outstanding balance), verified collections per day for the last 7 days (net of reversals), admission pipeline bars with open opportunity value (the pipeline rule: approved fee, else the course's standard fee), "Your attention" tabs (follow-ups due, payment claims, admissions awaiting a batch — each shown only to roles that can open the screen) and branch pulse. Data: `GET /dashboard/overview` (`api/overview.ts`) plus the existing leads / payments / admissions lists. Performance holds every earlier KPI (incl. Long-gap plans), funnel, branch comparison, targets, approvals and the AI brief. `/branch-manager` keeps the performance layout.
- **Leads**: snapshot tiles (All enquiries / New enquiries / In counselling / Payment review) that set the lead status / stage filter; V4 table (lead, course / source, owner, stage, intake, follow-up, priority, call / WhatsApp); phone cards from `features/workspace/lead-parts.tsx`.
- **New screens** (`features/workspace/`): **LMS access** (`/lms-access`, roles as Admissions) — admissions with curriculum, LMS and enrolment status, status tiles and filters, read-only (`api/lms.ts` over `GET /admissions`); **My work** (`/my-work`, all staff) — the Counsellor Workspace queues (own leads for counsellors, branch scope for managers) plus the user's open tasks; roles without leads access see tasks only; `/counsellor` still works; **Workflow guide** (`/workflow-guide`, all staff) — the ten steps from Capture to LMS review, "record truth" definitions and where each step happens.

### 3b. V4 deals, invoices and receipts

From the V4 handoff, Phases 2–8 ([Part D (V4 plan)](#part-d--v4-handoff-plan-and-review); API step 21 in [API.md · Part A (build plan)](API.md#part-a--build-plan-and-endpoints)).

| Screen | What changed | Files |
|---|---|---|
| Lead 360 | Action row: phone number, Call, WhatsApp (green), Email, **Convert to deal** (disabled until qualified), wraps on phones. Right column: **Qualification checklist** (six check tiles showing reviewer and time, Mark Qualified) until converted; then **Confirm delivery plan** (service branch, mode, seat type, planned start, capacity review, student acceptance, reopen) and **Commercial and invoice** (standard fee, agreed charge, plan, Create invoice / View invoice). Stage, demo and fee actions appear only for deals | `features/leads/lead-360.tsx`, `features/leads/qualification.tsx`, `features/sales/deal-panels.tsx` |
| Convert dialog | Courses (the lead's course locked in), branch, owner, expected close, person reuse note, existing open deals warning | `features/leads/qualification.tsx` |
| Deal pipeline | Header stats (open opportunities, open value, admitted); seven stage chips (`?stage=`, "Show all stages"); columns Counselling · Demo · Fee discussion · Payment review (+ Admitted / Closed lost when chosen); cards with value, delivery-plan status, owner avatar, expected close, course invoices; list view; **Next actions** with Review deal links; card dialog also sets expected close | `features/sales/pipeline-board.tsx`, `pipeline-card-dialogs.tsx`, `routes/pipeline.tsx` |
| Fee discussion | Versions are price only (no plan / schedule editor); Create invoice opens the shared dialog; the accepted-plan block is gone | `features/sales/fee-discussion.tsx` |
| Create invoice dialog | Issuer preview (branch address, accent), bill-to, eligible courses (ineligible ones show why), 1–3 instalment editor with Full / 50/50 / 50/25/25 presets, total; opens the invoice | `features/finance/create-invoice.tsx` |
| Invoices | V4 register (invoice / student, courses, plan split, amount, paid, pending, balance, status); **invoice page** renders the branch document (`InvoiceDocument`: issuer snapshot, bill-to, course lines, terms, totals, instalment cards, verified receipts; Guntur violet / Vijayawada teal via `--doc-accent`), Print / Save PDF, courses table with per-course balances and admissions, per-course admission readiness | `features/finance/invoices-list.tsx`, `invoice-detail.tsx` |
| Payments & receipts | Tabs Transactions · **Record payment** · Advances · Corrections. `/payments?invoice=<id>&tab=record` preselects the invoice. Record: allocate per course line, single or split tenders, proof, notes. Ledger shows `TXN-…` with the receipt (or "No receipt until verified") and the allocation. **Verify** opens a dialog with the evidence-reviewed and cash-check ticks; the toast names the receipt and any admissions created. Receipt dialog prints a receipt or a "Payment claim" (no receipt number) | `features/finance/payments-page.tsx`, `record-payment.tsx`, `shared.tsx` |
| New Admission | Eligibility review over `GET /admissions/eligibility` with a manual Create admission fallback | `features/academics/new-admission.tsx` |
| Collections | Dues rows show the invoice's courses and how many are admitted; promises are per invoice (also before admission) | `features/finance/collections-page.tsx` |

**Print:** `@media print` in `styles.css` shows only the invoice document (`.print-only-doc` / `.invoice-doc-wrap`) or an open dialog's document (receipts), A4 with backgrounds. The e2e spec `v4-deals.spec.ts` checks the printed page and generates a real PDF with Chromium.

### 4. Definition of done (every screen)

- Real data from the API; no sample labels or simulated behaviour.
- Loading, error and empty states; mutations toast success / error and invalidate affected queries.
- Actions hidden for roles that can't use them; server 403 / 422 messages surface as toasts.
- List requests honour the branch switcher and paginate.
- Works at phone width (tables scroll inside their panel).
- Covered by a Playwright spec that passes against `nipunacrm-dev` and can be re-run.

### 5. Running and testing

The API runs against `nipunacrm-dev` (`APP_ENV=development`); `nipunacrm` is never touched by local development or tests. Setup, staging accounts, run and test commands: [Part A (local development)](#part-a--local-development).

Current status (29 Sep 2026, V4): every route is connected to the API; the e2e suite (incl. `v4-shell` and `v4-deals`) passes on desktop and phone width against a freshly seeded dev database.

Commands: [Part A §5 Testing](#5-testing). `npm run dev` (Vite, HMR on :5173) also regenerates `src/routeTree.gen.ts`.

### 6. Porting prototype changes

The prototype will keep changing. When a new version arrives:

1. Replace `prototype/` and diff `src/components/crm/screens.tsx`, `workflows.tsx` and `src/lib/crm-store.tsx` against the previous version.
2. For each changed screen, update the matching `frontend/src/features/<group>/` component (layout, wording, columns).
3. New behaviour the API doesn't support yet → add it to [API.md · Part A (build plan)](API.md#part-a--build-plan-and-endpoints) first (backend step + migration if needed), then wire the screen.
4. Update the e2e spec for that screen and re-run against a freshly seeded dev database.

### 7. Backend additions made for the frontend

Gaps still open are listed in [Part E (backlog)](#part-e--backlog).

- `GET /staff` — staff directory for pickers (non-admins can't call `/users`).
- `GET /dashboard/overview` — V4 Overview figures (KPI cards, 7-day verified collections, pipeline bars, attention counts, branch pulse); all staff, branch-scoped.
- Task list link filters (`?lead_id=`, `?admission_id=`, …) for the Lead 360 / Student 360 task tabs.
- `flask create-dev-db` / `flask seed-dev` — dev replica and staging data.

### 8. Later

- Production build + reverse proxy config (nginx: `dist/` + `/api` → gunicorn).
- AI features on the chosen LLM (OpenAI / LangSmith keys are in `.env`, not used yet).
- File storage for documents in production and the other open decisions in [Part E (backlog)](#part-e--backlog).

---

## Part C — Test deployment (AWS EC2)

How the test server is built, how to redeploy to it, and how to run it day to day. It is a single EC2 instance: nginx serves the built frontend and proxies `/api` to Flask (gunicorn), and Postgres runs on the same machine. Local setup is in [Part A (local development)](#part-a--local-development).

> ### ⚠️ Always check the AWS account first
>
> The test server lives in **Manoj's personal AWS account `307857432997`**, never in the ConveGenius company account (`801257650467`).
>
> **Before every AWS command** (launch, stop, start, security group change, anything), confirm the account:
>
> ```bash
> aws sts get-caller-identity --profile nipuna --query Account --output text
> # must print: 307857432997
> ```
>
> If it prints anything else, **stop**. Don't run the command.
>
> - Always pass `--profile nipuna` (the personal account; keys come from `backend/.env`).
> - The company key is kept under `--profile convegenius` only. The `[default]` profile is intentionally empty, so a command without `--profile` fails instead of hitting the company account.
> - The personal keys go into the profile without being printed:
>   ```bash
>   aws configure --profile nipuna   # region ap-south-1, output json
>   ```

---

### 1. The server

| Item | Value |
|---|---|
| AWS account | `307857432997` (personal), profile `nipuna` |
| Region / zone | `ap-south-1` (Mumbai) / `ap-south-1b` |
| Instance | `i-0f56f0778b34411e7`, Name `nipuna-crm-test`, **t3.micro** (2 vCPU, 1 GB RAM + 2 GB swap) |
| OS | Ubuntu 24.04 LTS, timezone Asia/Kolkata |
| Disk | 20 GB gp3 |
| Public address | Auto-assigned public IPv4, **no Elastic IP**, so it **changes on every stop/start** (see section 5) |
| URL | **https://13-201-78-226.sslip.io** (sslip.io maps the dashed IP to the address; HTTP redirects to HTTPS) |
| TLS certificate | Let's Encrypt via certbot (nginx plugin), registered without an email, auto-renewed by `certbot.timer`. It is tied to the hostname, so it has to be re-issued when the IP changes |
| Security group | `sg-02132530c3cbda43c` (`nipuna-crm-test`): 22 from the developer's IP only, 80 and 443 from anywhere. 5432 is not open |
| SSH key | `~/.ssh/nipuna-crm-test` (AWS key pair `nipuna-crm-test`) |
| Approx. cost | ~$0.019/hour, ~$13.70/month running all the time (instance + disk + public IPv4), before GST |

```bash
IP=$(aws ec2 describe-instances --profile nipuna --instance-ids i-0f56f0778b34411e7 \
     --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)
ssh -i ~/.ssh/nipuna-crm-test ubuntu@$IP
open https://${IP//./-}.sslip.io
```

#### Layout on the server

| Path / unit | What |
|---|---|
| `/srv/nipuna/backend` | Flask app (no tests, no local `.env`) |
| `/srv/nipuna/backend/.env` | Server-only config: `APP_ENV=production`, `DATABASE_URL`, `SECRET_KEY`, `UPLOAD_DIR`. Generated on the server, never copied from a laptop, mode 600 |
| `/srv/nipuna/backend/uploads` | Uploaded documents, payment proofs, CVs |
| `/srv/nipuna/db` | SQL migrations |
| `/srv/nipuna/frontend` | Built frontend (`frontend/dist` contents) |
| `/srv/nipuna/venv` | Python 3.12 venv (`requirements.txt` + gunicorn) |
| `nipuna.service` (systemd) | gunicorn, 2 workers, `127.0.0.1:5050`, restarts automatically |
| `/etc/nginx/sites-available/nipuna` | Port 443 (certbot-managed TLS, port 80 redirects): static frontend with SPA fallback to `index.html`, `/api/` → `127.0.0.1:5050`, 10 MB upload limit |
| `ubuntu` crontab | `flask --app app jobs run` every minute → `/srv/nipuna/jobs.log` |

#### Database

- **PostgreSQL 18** (PGDG repo, the same major version as local development), listening on `127.0.0.1:5432` only.
- **One database: `nipunacrm`** (production), owned by role `nipuna`. The password is only in the server's `.env`.
- Built from `db/*.sql` in order. There is no `nipunacrm-dev` on the server.
- Holds the first Founder / CEO login (`flask create-admin`, a real email) **plus the staging test data** (the 20 accounts in [Staging accounts](#staging-accounts), 8 courses, 20 leads, 5 admissions). The data was loaded on 27 Sep 2026 at the owner's request by running the seeder class directly, because `flask seed-dev` refuses any database not named `*-dev` or that already has users:
  ```bash
  cd /srv/nipuna/backend && APP_ENV=production ../venv/bin/python -c \
    "from app import create_app; from cli.seed import Seeder; app = create_app(); app.app_context().push(); Seeder().run()"
  ```
  The pre-seed backup is `/srv/nipuna/backups/nipunacrm-before-seed-2026-09-27-2321.dump`. Don't run it again: the accounts already exist, so a second run fails.
- ⚠️ The staging password is in the repo and the site is public, so anyone with the URL can log in as `founder@nipuna.test`. Fine for fictional test data only. Before any real data goes in, restore the backup or deactivate these accounts.

---

### 2. Redeploy code

Run from the repo root on your laptop. **Check the account first** (see the box at the top), then:

```bash
IP=<current public IP>
KEY="ssh -i $HOME/.ssh/nipuna-crm-test"

# 1. Build the frontend locally — the 1 GB server does not build it
(cd frontend && npm run build)

# 2. Upload (never the local .env, caches, uploads or tests)
rsync -az --delete -e "$KEY" --exclude '.env' --exclude '__pycache__' --exclude '.pytest_cache' \
  --exclude 'uploads/' --exclude 'tests/' --exclude 'api.http' backend db ubuntu@$IP:/srv/nipuna/
rsync -az --delete -e "$KEY" frontend/dist/ ubuntu@$IP:/srv/nipuna/frontend/

# 3. If requirements.txt changed
$KEY ubuntu@$IP '/srv/nipuna/venv/bin/pip install -q -r /srv/nipuna/backend/requirements.txt'

# 4. Restart the API
$KEY ubuntu@$IP 'sudo systemctl restart nipuna && systemctl is-active nipuna'
```

#### New migrations

There is no migrations table, so **apply only the new files, once each, in order**. Take a backup first (section 4). Replaying an old file will fail or duplicate data.

```bash
$KEY ubuntu@$IP 'cd /srv/nipuna && set -a && . backend/.env && set +a &&
  psql "${DATABASE_URL/+psycopg/}" -v ON_ERROR_STOP=1 --single-transaction -f db/017_<name>.sql'
```

Applied so far: `001` to `016`.

**Pending for the V4 review deploy (not applied yet — only on the user's go-ahead):** `017` to `025`, in order, each with `--single-transaction`. Take a `pg_dump` backup first (section 4): 019–022 rewrite the pipeline, invoice and payment triggers and backfill existing rows (one-line invoices, payment allocations, transaction numbers; pending receipts lose their receipt numbers until verified). 017–022 were rehearsed on a copy of the local main database (023–025 only relax admin role checks) and replayed from scratch against `nipunacrm-dev` (schema diff 0). The staging seed on the server predates V4; reload it only if asked (`create-dev-db` refuses non-dev names, so it would be a manual rebuild).

---

### 3. Check it works

```bash
URL=https://${IP//./-}.sslip.io
curl -s -o /dev/null -w "%{http_code}\n" $URL/          # 200
curl -s -o /dev/null -w "%{http_code}\n" $URL/leads     # 200 (SPA deep link)
$KEY ubuntu@$IP 'sudo certbot certificates'              # certificate + expiry
$KEY ubuntu@$IP 'sudo journalctl -u nipuna -n 50 --no-pager'  # API logs
$KEY ubuntu@$IP 'tail -20 /srv/nipuna/jobs.log'              # background jobs
$KEY ubuntu@$IP 'free -h; df -h /'                           # memory / disk
```

---

### 4. Backups

The database lives on the instance disk. It survives stop/start but is **lost if the instance is terminated**.

```bash
# Dump to your laptop
$KEY ubuntu@$IP 'cd /srv/nipuna && set -a && . backend/.env && set +a && pg_dump -Fc "${DATABASE_URL/+psycopg/}"' \
  > nipunacrm-$(date +%F).dump
```

For a whole-disk copy, take an EBS snapshot (check the account first).

---

### 5. Stop, start and IP changes

Stop the instance when it isn't needed. While stopped, only the disk is billed (~$1.80/month).

```bash
aws sts get-caller-identity --profile nipuna --query Account --output text   # must be 307857432997
aws ec2 stop-instances  --profile nipuna --instance-ids i-0f56f0778b34411e7
aws ec2 start-instances --profile nipuna --instance-ids i-0f56f0778b34411e7
```

- **The public IP changes after every start, and with it the HTTPS hostname.** Look up the new IP (section 1), then issue a certificate for the new name:
  ```bash
  NEW=${IP//./-}.sslip.io
  $KEY ubuntu@$IP "sudo sed -i 's/[0-9-]*\.sslip\.io/$NEW/g' /etc/nginx/sites-available/nipuna &&
    sudo certbot --nginx -d $NEW --non-interactive --agree-tos --register-unsafely-without-email --redirect"
  ```
  Delete the old certificate afterwards with `sudo certbot delete --cert-name <old-name>`. Share the new URL `https://$NEW`.
- **SSH is limited to one IP.** If your own IP changes, SSH times out. Update the rule:
  ```bash
  aws ec2 authorize-security-group-ingress --profile nipuna --group-id sg-02132530c3cbda43c \
    --protocol tcp --port 22 --cidr $(curl -s https://checkip.amazonaws.com)/32
  ```
  Remove the old IP's rule afterwards with `revoke-security-group-ingress`.

---

### 6. Not set up yet

| Gap | Note |
|---|---|
| AI Copilot | No `ANTHROPIC_API_KEY` in the server `.env`, so the rule-based fallback is used |
| Fixed address | No Elastic IP or domain, so the URL and certificate change on restart. For a stable address: own domain + Elastic IP, then the same certbot command |
| Automated backups | Manual `pg_dump` only |

---

### 7. Building a new server from scratch

This is how the current one was built (27 Sep 2026). Check the account first.

1. Import the key pair `nipuna-crm-test` from `~/.ssh/nipuna-crm-test.pub`. Create security group `nipuna-crm-test` in the default VPC with 22 from your IP and 80 from `0.0.0.0/0`.
2. Launch a t3.micro from the Ubuntu 24.04 AMI (SSM parameter `/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id`), 20 GB gp3, `--associate-public-ip-address`, tags `Name=nipuna-crm-test`, `project=nipuna-crm`.
3. On the server: add a 2 GB swapfile, set the timezone to Asia/Kolkata, install `python3-venv nginx rsync`, and install `postgresql-18` from the PGDG repo (`/usr/share/postgresql-common/pgdg/apt.postgresql.org.sh`).
4. Create role `nipuna` (random password) and database `nipunacrm OWNER nipuna`. Write `backend/.env` on the server with a random `SECRET_KEY`.
5. Upload code (section 2), apply every `db/*.sql` in order with `--single-transaction`, and create the venv with `requirements.txt` + `gunicorn`.
6. Install `nipuna.service`, the nginx site (remove `sites-enabled/default`) and the jobs crontab line.
7. HTTPS: open 443 in the security group, set `server_name <dashed-ip>.sslip.io` in the nginx site, install `certbot python3-certbot-nginx`, then run the `certbot --nginx ... --redirect` command from section 5.
8. `APP_ENV=production flask --app app create-admin --role FOUNDER_CEO` for the first login. Share the password privately, and change it after the first login.

---

## Part D — V4 handoff: plan and review

Plan for bringing the app in line with the V4 handoff PDF (`Nipuna-CRM-UI-V4-Developer-Handoff-2026-09-29.pdf`, in git history).
Status: **built on `nipunacrm-dev` (29 Sep 2026) — Phases 1–9 done, Phase 10 done except the AWS review deploy**
(waiting for the go-ahead; see [Part C (deployment)](#part-c--test-deployment-aws-ec2)). Migrations 019–025; nothing committed. The main `nipunacrm`
database, commits and AWS deploys happen only when asked. Results against the handoff checklist: [V4 developer response](#v4-developer-response).

| Phase | Status | Where |
|---|---|---|
| 1. Look and shell | ✅ | Part B §3a |
| 2. Qualify and convert | ✅ db 019 | API step 21 · DATABASE.md 019 |
| 3. Pipeline screen | ✅ | API step 21 · Part B §3b |
| 4. Delivery plan per course | ✅ db 020 | DATABASE.md 020 |
| 5. Multi-course invoice, per-course payments | ✅ db 021 | DATABASE.md 021 |
| 6. Payments and receipts | ✅ db 022 | DATABASE.md 022 |
| 7. Automatic admission | ✅ (service, on verification; db 021 per-line rule) | API step 21 |
| 8. Branch invoice templates | ✅ print / PDF checked | Part B §3b |
| 9. New screens | ✅ | Part B §3a |
| 10. Acceptance and handover | ✅ tests, seed, docs, review · ⏳ AWS deploy | V4 developer response (below) |

### What we take from V4, and where we differ on purpose

**Taken from V4:** multi-course invoices with per-course payment allocation, the per-course delivery plan, receipt
numbers issued only at verification, the full visual redesign, and the Open Sans font.

**Kept as our own design** (intentional deviations — tell the V4 reviewer): see [Intentional differences from V4](#intentional-differences-from-v4) below.

**Left out:** the "SAMPLE DATA" banner (demo only) and anything V4 simulates (contact actions, AI, LMS provisioning).

### Phases

Each phase ends with a working app, backend tests, e2e tests and updated docs.
Sizes are relative: S ≈ a day, M ≈ 2–3 days, L ≈ a week.

#### 1. Look and shell (L)

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

#### 2. Qualify and convert (M · DB 019)

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

#### 3. Pipeline screen (M)

- **Seven stage chips:** Counselling, Demo scheduled, Demo attended, Fee discussion, Payment review, Admitted, Closed
  lost. Counts are for the selected branch; clicking a chip filters the board; "Show all stages" clears it.
- **Board columns:** Counselling | Demo | Fee discussion | Payment review, plus Admitted and Lost columns when those
  chips are chosen. List view as well.
- **Cards:** person, courses, value (sum of approved or standard fees), delivery-plan status, owner, expected close.
- **Header:** open opportunities, open value, number admitted.
- **Next actions** (`GET /pipeline/next-actions`, per branch), each with a "Review deal" link: review payment evidence,
  record demo outcome, confirm delivery plan, prepare invoice, follow up balance.

#### 4. Delivery plan per course (M · DB)

- **Fields:** `DP-00001` code, service branch, mode, seat type (Confirmed Seat / Future Plan, kept from today), planned
  start date, capacity review (checked / waiting), "student acceptance captured" tick, accepted by and when.
- **Replaces** today's accept-plan on the fee discussion; existing data is migrated.

#### 5. Multi-course invoice with per-course payments (L+ · DB — biggest and riskiest phase)

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

#### 6. Payments and receipts (M · DB)

- **Record payment:** gets a `TXN-GNT-00001` number; Payments opens with the invoice preselected (`/payments?invoice=`).
- **Verify:** the receipt number `GNT-R-2627-00001` is issued only here. Two confirmations: evidence reviewed, and an
  independent check for cash.
- **Receipt:** printable document. A pending payment shows as a "Payment claim" with no receipt number.

#### 7. Automatic admission (M · DB)

- **When:** on verification, each course line with an accepted delivery plan and at least ₹1,000 verified (or its
  whole amount, if smaller) gets its admission — once, reusing the person / student.
- **New Admission** becomes an eligibility review screen. Complimentary courses stay manual.

#### 8. Branch invoice templates (M)

- **Colours:** Guntur violet `#6251DA`, Vijayawada teal `#137E89`.
- **Contents:** issuer block, bill-to, course lines, payment terms, totals, verified paid, balance, instalment cards,
  verified receipts.
- **Print:** print preview that saves to PDF; real PDF output is checked.
- **Mobile:** tables become stacked cards.
- **Tax and bank details:** only once approved values are provided.

#### 9. New screens (S–M)

- **LMS access:** admissions with their LMS status, read-only.
- **My work:** the counsellor's queue plus their tasks.
- **Workflow guide:** static page.

#### 10. Acceptance and handover (M)

- Backend tests, e2e tests and seed update; every item in the PDF's acceptance checklist, including the sample case:
  ₹22,000 invoice → ₹5,000 pending shows ₹0 paid and ₹22,000 balance → after verification one receipt, ₹5,000 paid,
  ₹17,000 balance.
- Docs updated, deployment to the AWS test server as the review URL, and a gap report.

### Build order

1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10. Phase 1 is independent and can run alongside Phases 2 and 3.

### Decisions made while building (confirm — also in [Part E (backlog)](#part-e--backlog) D8–D11)

- A new enquiry for a person who already has an open card **stays in Leads** until it is converted (017 used to put it on the card straight away).
- Converting onto an existing card **keeps that card's owner**; the dialog's owner applies to a new card.
- **Re-issue:** an invoice no longer supersedes an earlier one automatically; cancel the unpaid invoice first (its courses become invoiceable again).
- **Promises to pay** belong to the invoice (all its courses), and work before admission.
- The **receipt numbers** that pending / failed payments had been given at recording were cleared by 022 (they were never receipts); verified ones kept theirs.
- An automatic admission the database refuses (e.g. offer already used) is **skipped with a Branch Manager task** and stays on the eligibility review.

### Open questions (recommended default used unless decided otherwise)

1. **Before conversion:** can a lead get a demo or fee discussion before it is converted? Default: **no** — booking a
   demo or starting fees on an unconverted lead asks to qualify and convert first, matching V4's order.
2. **Admitted / Closed-lost chip counts:** all-time per branch, or this period only? Default: **all-time**, as in V4.
3. **LMS access:** default **read-only list**; V4's provisioning and recovery flow waits for a real LMS.
4. **Tax, GSTIN and bank details on invoices:** default **left off** until approved.

---

### V4 developer response

Response to the V4 handoff PDF (`Nipuna-CRM-UI-V4-Developer-Handoff-2026-09-29.pdf`, in git history) ("Requested developer response": review URL, completed checks, backend gaps, delivery estimate). Build plan and phase status: [Part D (V4 plan)](#part-d--v4-handoff-plan-and-review).

| | |
|---|---|
| **Review URL** | Not deployed yet. The build runs on the development database (`nipunacrm-dev`); the AWS test server gets it on the go-ahead (migrations 017–025, see [Part C (deployment)](#part-c--test-deployment-aws-ec2)). |
| **Built** | 29 Sep 2026 — live CRM (Flask API + PostgreSQL + React), not a demo: real permissions, branch scoping, persistence and document numbers |
| **Tests** | Backend 205 passed · end-to-end 83 passed (3 device-specific skips), 0 failed, on desktop (1440 px) and phone (Pixel 7; 360 px checks) against a freshly seeded database |

#### Acceptance checklist (handoff page 4)

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

#### Lifecycle (handoff page 2)

| Step | Built |
|---|---|
| 1. Qualify and convert | Six-check review, Mark Qualified, Convert (courses, branch, owner, expected close); same person reused |
| 2. Accept delivery plan | Per course: service branch, mode, seat type, planned start, capacity review, student acceptance (`DP-00001`) |
| 3. Create invoice | One or more compatible courses; issuer snapshot; no admission created |
| 4. Record payment | Payment claim (`TXN-…`), allocated per course, one per tender; balance unchanged |
| 5. Verify payment | Evidence reviewed (+ cash check); receipt issued; each course reaching ₹1,000 verified is admitted, reusing one person / student |
| 6. Grant LMS access | Separate: LMS access screen is a read-only status list (no live LMS) |

#### Intentional differences from V4

| Area | V4 | Built |
|---|---|---|
| Pipeline | One deal per course | One **person card per branch** with a shared stage; each course is still its own deal (Lead 360, invoice line, admission) |
| Payment plans | Full; 50/50 with day 10–15; 50/25/25 on day 0/10/15 | **Flexible 1–3 instalments** — any dates from today and any amounts adding up to the total (Full / 50/50 / 50/25/25 are quick fills); ₹1,000 token; due-soon and long-gap alerts |
| Admission trigger | Any verified payment on an eligible line | Once **₹1,000 is verified on the course** (or its whole amount, if smaller) |
| Fees | No fee step | Fee discussions with versions, offers (once per person), special closing approvals and the 70% advisory floor stay; the approved version is the invoice line price |
| Banner | "SAMPLE DATA — NO LIVE INTEGRATIONS" | Not shown (live system) |
| Contact actions | Simulated | Call opens `tel:`, WhatsApp `wa.me`, Email `mailto:` (no telephony / WhatsApp API integration) |

#### Backend gaps and open decisions

| Item | State |
|---|---|
| Tax / GSTIN and bank details on invoices | Left off until approved values are provided |
| LMS provisioning and recovery (V4 "Review Recovery", "Safe retry") | Not built — read-only LMS status list until a real LMS exists |
| AI assistant suggestions | Rule-based fallback; LLM not connected |
| HDFC / WhatsApp / email / telephony integrations | Not connected (as in V4) |
| Header "Search anything ⌘K" | Header search finds persons; the all-records palette is not built |
| Independent cash check | A recorded tick; the verifier is not yet required to be a different person from the collector |
| Decisions to confirm | Demos / fees only after conversion; chip counts all-time; conversion keeps an existing card's owner; promises per invoice ([Part E (backlog)](#part-e--backlog) D8–D11) |

#### Delivery estimate

| Remaining | Size |
|---|---|
| Deploy to the AWS test server as the review URL (backup, migrations 017–025, frontend build, smoke test) | S (under a day), on the go-ahead |
| Changes from the review and the decisions above | S–M, depending on feedback |
| Tax / bank details on the invoice template, once values are approved | S |
| LMS provisioning, integrations | Separate projects |

---

## Part E — Backlog

Decisions waiting on the product owner, and API gaps found while connecting the frontend (26–27 Sep 2026). Every gap below has a frontend workaround today; none blocks use. When one is done, move it to the "As built" notes in [API.md · Part A (build plan)](API.md#part-a--build-plan-and-endpoints) and delete it here.

---

### 1. Decisions needed

| # | Question | Today |
|---|---|---|
| D1 | Should counsellors move a lead to **Payment Pending Verification** by hand? | The API allows it once the lead has a course (per the prototype and API.md); the frontend never offers it — only recording a payment sets it |
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
| D12 | LMS · student activation link | The LMS returns a one-time activation token for each new student login; the CRM discards it (only `activation_token_issued` is kept) and never logs it. Decide: the CRM sends the link by WhatsApp / email (template + task), or activation stays supervised in the LMS (coordinator reissues) |
| D13 | LMS · instalments on multi-course invoices | Instalments are per invoice, so each admission on a two-course invoice carries the same schedule (flagged `installments_scope: "invoice"`). Confirm the LMS shows it as the invoice's, or decide a per-course split |
| D14 | LMS · status pull | `flask lms status-check` only calls it. Round 2: a job storing `persons.lms_user_id`, `admissions.lms_status` / academics / batches / certificates, and `PATCH /admissions` no longer accepting `lms_status` from staff |

### 2. API gaps

#### Missing endpoints / filters

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

#### Responses that return bare IDs (extra requests to show names)

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

#### Inconsistencies

- `GET /admin/sessions`: unpaginated and always `current: false`.
- `GET /collections/ageing`: empty bands return `balance: 0` (number) instead of `"0.00"`.
- `POST /batches` with `curriculum_version_id: null` skips the "use the published version" default (omit the field instead).
- Role checks that differ from the prototype wording: approve extra demo is Academic Coordinator / Branch Manager only; `/concession-limits` and `/offers` are admin / BM only, so counsellors can't see their limits or pick offers for complimentary courses.

#### Code vs plan (found while rewriting the API execution flows)

- `GET /branches/{id}` and `/branches/{id}/shifts` only need login and `get_branch` has no branch-scope check (plan: admins; §2: out-of-scope single reads → 404). Decide whether branch details are meant to be visible to everyone.
- Recovery-account access: the `RECOVERY_ACCESS` audit row is written inside the request transaction, so it's rolled back when the request fails (≥ 400); only the log line survives, although `routes/decorators.py` says failed requests are audited too.
- Empty-PATCH check is duplicated: `controllers/common.require_changes()` vs inline copies in `controllers/users.update_user` and `controllers/masters._require_changes`.
- Locking an account after 5 failed logins also resets `failed_login_attempts` to 0 (undocumented until now).

#### Seed data

- Notifications only exist for Accounts users until events occur.
- No offers are seeded, so complimentary courses can't be exercised on a fresh seed.

### 3. Prototype features without an API (left out of the frontend)

- Dashboard tiles: outstanding (verified basis), dues recovery, captured leads, top courses by net verified.
- Report sections: course enrolment & revenue drill-down, source / campaign with record links, trainer batches, upcoming / overdue dues.
- Admin: AI configuration, retention, backup / recovery status.
- LMS "Open LMS" / live sync, "Open class link", collecting branch on admissions, email resend, channel status chips, support-period extensions (endpoint exists, not exposed).
