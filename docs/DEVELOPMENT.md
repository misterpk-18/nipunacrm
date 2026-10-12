# Nipuna CRM — Development

Everything needed to build, run, test and ship the CRM, and where the project stands.

| Part | Covers |
|---|---|
| [Part A — Local development](#part-a--local-development) | Repository layout, `.env`, databases, staging accounts, running and testing |
| [Part B — Frontend](#part-b--frontend) | Frontend decisions, structure, screen → API map, V4 look, porting prototype changes |
| [Part C — Test deployment (AWS EC2)](#part-c--test-deployment-aws-ec2) | The EC2 test server (personal AWS account only): layout, redeploy, migrations, backups, stop / start |
| [Part D — V4 handoff: plan and review](#part-d--v4-handoff-plan-and-review) | The V4 UI handoff: status, acceptance results, deviations, remaining work |
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
| `ANTHROPIC_API_KEY`, `AI_MODEL` | Claude for the AI briefs, counselling brief and Ask Nipuna (`AI_MODEL` default `claude-opus-5-5`, Claude Opus 5.5). Unset = rule-based answers (the case today) |
| `OPENAI_API_KEY`, `LANGSMITH_*` | In `.env` but not read by the code |
| `LMS_BASE_URL`, `LMS_SERVICE_KEY` | The Nipuna LMS (local: `http://127.0.0.1:5060`); the key is the LMS's `CRM_SERVICE_KEY` — get it from the LMS owner, never commit or print it. Unset = events wait in `lms_outbox` |
| `LMS_TIMEOUT_SECONDS` | Optional, default 10 |
| `LMS_WEB_URL` | The LMS web app (dev `http://127.0.0.1:5174`; tests `http://lms-web.test`). Used only for the **Open in LMS** link on Waiting for batch; unset = the link is hidden with a hint. Add it to the server `.env` too |
| `LMS_PUSH_ON_COMMIT`, `LMS_PUSH_TIMEOUT_SECONDS` | Push a request's LMS events right after it commits (default on, `0` turns it off), with a 3 s timeout |
| `LMS_WHATSAPP_STATUS_EVENTS` | Default `0`. `1` = tell the LMS when a message it sent through `POST /lms/whatsapp` is Sent / Delivered / Read / Failed / Skipped (`WhatsappStatusUpdated` events, [API.md · Step 28](API.md#step-28--whatsapp-for-the-lms-round-6--dev-only)). Turn on only once the LMS has the handler, or every event fails with a Super Admin task. The same `LMS_SERVICE_KEY` also authenticates the LMS's calls to the CRM |
| `WHATSAPP_ENABLED`, `WHATSAPP_API_URL`, `WHATSAPP_API_KEY` | WhatsApp through Pinbot ([API.md · Step 25](API.md#step-25--whatsapp-messages-outbox--dev-only)). Nothing is sent unless it is `1` and both the URL (`https://partnersv1.pinbot.ai/v3/<number id>/messages`) and the key are set; the key stays in `.env`, never committed or printed. Default off: rows wait in `whatsapp_outbox` |
| `WHATSAPP_WEBHOOK_TOKEN` | The secret the provider sends (header `X-Webhook-Token` or `?token=`) to `POST /api/v1/webhooks/whatsapp` for delivery status and replies. Unset = the endpoint refuses everything |
| `WHATSAPP_TEST_NUMBERS` | Comma-separated numbers with country code. When set, only these are messaged; every other row is Skipped. Keep it set on dev: the staging data holds real numbers |
| `WHATSAPP_MAX_AGE_HOURS`, `WHATSAPP_TIMEOUT_SECONDS`, `WHATSAPP_PUSH_ON_COMMIT`, `WHATSAPP_PUSH_TIMEOUT_SECONDS`, `WHATSAPP_INVOICE_CHANNEL` | Optional: 24, 10, on, 3, "your Nipuna counsellor" (the wording after "review the invoice through") |

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

The seed (`backend/cli/seed.py`) creates 18 staff accounts, 8 courses (both branches) and 5 batches, 22 leads in both branches — new, **qualified but not converted** (Ravi Teja), converted deals at every pipeline stage (qualification checklist + Convert, db 019), demos, approved fee discussions, **accepted delivery plans**, invoices with their own 1–3 instalment schedules, payment claims and verified receipts, 7 admissions created on verification with batch allocations, a **two-course invoice paid with split tenders** giving two admissions for one person (Meera Joshi), the V4 **₹22,000 invoice with a ₹5,000 cash claim pending** (Sana Begum), an overdue instalment with an invoice promise, a long payment gap, a refund case, tasks, communications, a support case, companies and a job opening, this month's approved targets and an incident.

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

Other backend commands (from `backend/`): `flask --app app create-admin` (first admin on a fresh database), `flask --app app jobs list | run [name…]` (background jobs, incl. `first-attempt` for the 2 / 10 / 30-minute enquiry alerts), `flask --app app create-test-db`.

**The LMS link locally** ([API.md · Steps 22–23](API.md#step-22--lms-sync-outbox--dev-only)). Run the LMS on :5060 (`cd nipunalms/backend && APP_ENV=development ../venv/bin/flask --app app run --port 5060`, its own `nipunalms-dev` database) and set `LMS_BASE_URL` / `LMS_SERVICE_KEY` in `backend/.env`. How it works:

- **CRM → LMS:** every admission, course, branch and money change writes `lms_outbox` rows in the same transaction; they are pushed right after the request commits, and `flask lms worker` is the retry path (the LMS owner sees them in its Super Admin screen **CRM sync**, `/admin/crm-sync`).
- **LMS → CRM:** the status pull mirrors login, LMS status, enrolment, batches (with timetable, seats left and readiness), allocations, completion and certificates. While `academics_managed_in_lms` is on (dev), those academic screens are read-only in the CRM. The CRM holds no curriculum (db 043); the LMS keeps its own.
- The test suite runs with `academics_managed_in_lms` off (conftest) so the CRM's own academic rules stay covered; `tests/test_lms_pull.py` turns it on.
- Seed batches in the LMS never come through the pull: create batches in the LMS (Academic → Batches). On a dev database that still has the CRM's own batches, run `flask lms drop-crm-batches --yes` once, then `flask lms pull --full`.
- Local only: never point this at real student data until the service key, transport and retention are agreed.

```bash
APP_ENV=development flask --app app lms worker            # push every 10 s + pull every minute, until stopped (server: cron, --duration 55)
APP_ENV=development flask --app app lms backfill [--branches]   # events for everything that exists (re-runnable)
APP_ENV=development flask --app app lms deliver           # push what is due now
APP_ENV=development flask --app app lms outbox --failed   # counts by status / type, errors
APP_ENV=development flask --app app lms pull [--full]     # status pull now (--full: from the beginning)
APP_ENV=development flask --app app lms holds             # pulled records waiting to apply, and why
APP_ENV=development flask --app app lms finance-snapshot --force   # BranchFinanceSnapshot now (job: every 15 min)
APP_ENV=development flask --app app lms refresh 12        # one admission's LMS state now (the "Refresh from LMS" button)
APP_ENV=development flask --app app lms reconcile [--fix] # CRM ↔ LMS drift per admission; exits 1 while drift is left
```

The exchange with the LMS team (briefs, replies, joint test results) lives in the LMS repo's `nipuna crm-docs/` folder, not here.

### 5. Testing

| Suite | Command | Notes |
|---|---|---|
| Backend | `cd backend && ../venv/bin/pytest -q` | Rebuilds `nipunacrm_test`; each test runs in a rolled-back transaction |
| Frontend types | `cd frontend && npm run typecheck` | |
| Frontend unit | `cd frontend && npx vitest run src` | Plain `npm test` also picks up the Playwright specs in `e2e/` and fails; run it with `src` |
| Frontend lint | `cd frontend && npm run lint` | The repo carries thousands of older Prettier formatting errors; judge new files with `npx eslint <files> --rule 'prettier/prettier: off'` (0 errors; the `react-refresh/only-export-components` warnings match the older code) |
| Frontend build | `cd frontend && npm run build` | Type-check + production build into `dist/` |
| End-to-end | `cd frontend && npx playwright test` | Needs the API (dev DB) and Vite running; desktop + `@mobile` projects |

**Test notes (UX build).** Every payment by a mode other than cash now needs a proof file: in tests use `tests/helpers.py` `record_payment` (it sends a proof for every mode except CASH) or `with_proof(body)` to build the multipart request by hand. `test_operations.py::test_notification_rules` asserts the rule set with `>=` because several features add rules. New files: `test_journey.py`, `test_qualify_autotick.py`, `test_demo_slots.py`, `test_delivery_plan_ux.py`, `test_payment_ux.py`, `test_batch_waiting.py`, `test_lead360_readonly.py`. **Automatic WhatsApp round:** `test_whatsapp_auto_w1.py` (demo, admission, plan confirmation), `test_whatsapp_auto_w2.py` (instalment reminders), `test_whatsapp_auto_w3.py` (staff alerts, db 042). `TestingConfig` has `WHATSAPP_ENABLED=True`, so a test that expects the demo-reminder **task** fallback (`test_ai_jobs.py`) must patch `whatsapp.configured` to return False; with it on, the reminder is queued as messages instead. Run each agent's tests against its own test database with `TEST_DATABASE_URL=postgresql+psycopg://<user>@localhost:5432/<name>_test` so parallel runs don't drop each other's database.

E2E specs live in `frontend/e2e/` (`auth-leads`, `sales`, `finance`, `academics`, `operations`, `management`, `v4-shell`, `v4-deals`, `whatsapp`); `e2e/helpers.ts` has the staging users, `login()` and API setup helpers for the V4 flow (`qualifyAndConvert`, `approvedFee`, `acceptDeliveryPlan`, `createInvoice`, `recordPayment`, `verifyPayment`). `E2E_BASE_URL` points Playwright at another Vite port. Tests create their own records with unique phones/names, so they can be re-run without reseeding. Run one Playwright process at a time — parallel runs share `test-results/` (use `--output=<dir>` if you must run two).

#### A throwaway stack for e2e or a risky check

Other projects use neighbouring ports on the same machine (the LMS runs on :5060, and other dev servers may hold :5174 / :5181), so check a port with `lsof -iTCP:<port> -sTCP:LISTEN` before assuming it is free. To test screens without touching `nipunacrm-dev`:

```bash
export DEV_DATABASE_URL=postgresql+psycopg://<you>@localhost:5432/nipunacrm-scratch-dev   # any *-dev name can be rebuilt
cd backend && APP_ENV=development ../venv/bin/flask --app app create-dev-db --yes
APP_ENV=development ../venv/bin/flask --app app seed-dev        # stops at the batches step while the LMS owns academics: staff + courses exist, which is enough
APP_ENV=development ../venv/bin/flask --app app run --port 5051 &
cd ../frontend && VITE_API_TARGET=http://127.0.0.1:5051 npx vite --port 5190 --strictPort &
E2E_BASE_URL=http://localhost:5190 npx playwright test e2e/whatsapp.spec.ts --project=desktop
# afterwards: stop both servers and `dropdb nipunacrm-scratch-dev`
```

The seed password `Nipuna-staging-1` works on a freshly seeded database. It is rejected on the long-lived `nipunacrm-dev` (those accounts were created or changed some other way), so use a scratch database rather than guessing credentials.

#### Clearing test persons, leads and their records

The e2e specs and manual testing create persons and leads in `nipunacrm-dev` and nowhere else (the local `nipunacrm` holds no persons or leads). Back up first: `pg_dump -Fc nipunacrm-dev -f ~/nipuna-crm-backups/<name>.dump`. Everything that hangs off a person is one set of tables (find them with the foreign-key closure of `persons`, leaving out `users`, whose `person_id` is unused for staff): admissions and their curricula / allocations / fee changes / transfers, invoices, instalments and lines, payments and allocations, correction and refund cases, deliveries and demos, fee discussions, pipeline entries, leads and their activities / objections / qualification reviews, enquiries, communications, tasks, AI actions and insights, placement profiles and applications, `whatsapp_outbox`, `whatsapp_webhook_log`, `lead_imports`, `notifications`, and the LMS outbox tables (`lms_outbox`, `lms_sync_versions`, `lms_pull_holds`, which would otherwise point at records that no longer exist). Truncate those with `RESTART IDENTITY`, then `DELETE FROM persons` (PostgreSQL refuses `TRUNCATE persons` while `users` references it). Staff accounts, courses, branches, offers, batches, settings and the audit log stay. Row deletes are refused on ledgers (payments, receipts) by design, which is why this is a truncate; code counters such as `PER-GNT-00001` keep counting. The LMS dev database keeps its students for the deleted CRM records. To also reset staff and settings, rebuild instead: `flask create-dev-db --yes && flask seed-dev`.

### 6. Docs to keep up to date

All documentation is four files in `docs/`:

| File | Holds | Update when you… |
|---|---|---|
| [PRODUCT_GUIDE.md](PRODUCT_GUIDE.md) | Product behaviour (Part A), roles and permissions (Part B) | Change a business rule, role, screen access, approval or setting |
| [DATABASE.md](DATABASE.md) | Migrations and the rules the schema enforces | Add or change a migration (status table + section) |
| [API.md](API.md) | Architecture, conventions, every endpoint (Part A), execution flows (Part B) | Add or change an endpoint (endpoint table + "As built"; also `backend/api.http`) |
| DEVELOPMENT.md (this file) | Setup, LMS link and testing (A), frontend (B), deployment (C), V4 status (D), backlog (E) | Change setup or test commands, a screen or frontend convention, the server or deploy steps (C: "Applied so far"), or find a gap / make a product decision (E) |

Source documents (V4 handoff PDF, the AI use-cases spec, the LMS lead-to-learning guide) are not kept in `docs/`; the V4 handoff PDF can be restored from git.

### Staging accounts

Login accounts for testing. Locally they exist **only in the dev database `nipunacrm-dev`**, created by `flask --app app seed-dev` (re-created on every reseed); they are not in the local `nipunacrm`. They are also loaded into the **EC2 test server's** `nipunacrm` (https://15-252-72-136.sslip.io), see [Part C (deployment)](#database).

- URL: http://localhost:5173 (API on :5050 with `APP_ENV=development` — see [Part A (local development)](#4-running))
- Password for every account: **`Nipuna-staging-1`** — set by `seed-dev`, so it works on a freshly seeded database. On the long-lived `nipunacrm-dev` it was rejected in testing on 2026-10-06 (the accounts were created or changed another way); if login fails there, reseed or use a [scratch stack](#a-throwaway-stack-for-e2e-or-a-risky-check)

#### One account per role

| Role | Email | Branch | Lands on |
|---|---|---|---|
| Founder / CEO | `founder@nipuna.test` | All branches | Dashboard |
| Super Admin | `admin@nipuna.test` | All branches | Dashboard (+ Admin / Settings) |
| Branch Manager | `bm.gnt@nipuna.test` | Guntur | Branch Manager view |
| Sales (counsellor) | `sales.gnt@nipuna.test` | Guntur | Counsellor Workspace |
| Front Office | `fo.gnt@nipuna.test` | Guntur | Counsellor Workspace |
| Accounts | `accounts.gnt@nipuna.test` | Guntur | Dashboard |
| Trainer | `trainer.g1@nipuna.test` | Guntur | Dashboard |
| Placement | `placement.gnt@nipuna.test` | Guntur | Dashboard |
| HR | `hr.gnt@nipuna.test` | Guntur | Dashboard |

#### Vijayawada accounts

Same roles, same password: `bm.vij`, `sales.vij`, `fo.vij`, `accounts.vij`, `placement.vij`, `hr.vij` (all `@nipuna.test`). Trainers: `trainer.v1@nipuna.test`, `trainer.v2@nipuna.test`. Guntur also has a second trainer, `trainer.g2@nipuna.test`.

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
| Front Office queue (first attempts, post-demo decision) | My work → Today | `sales.gnt`, `fo.gnt` |
| Lead workbench: suggested action, Save outcome, reply draft | Bhavana Sri · `LD-00011` (Guntur, new enquiry) | `sales.gnt` |
| Ready-to-close checklist on a deal | Karthik Reddy · `LD-00012` (Vijayawada, fee discussion) | `sales.vij` |
| Batches offered to a lead (LMS timetable, Blocked reason) | Any Guntur Java Full Stack lead (batch `NIT-GNT-BAT-2026-000004`) | `sales.gnt` |
| Sales knowledge, course paths, AI controls, recovery lists, measures | More → Sales playbook | `bm.gnt` (also approves course paths) |

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
| Admissions, New admission, Batches, LMS access, Students / Student 360, Course Master | `/admissions*`, `/batches*`, `/students*`, `/documents*`, `/courses*`, `/payment-plans*` | academics |
| My work (Today / Queues / Handover), Lead workbench, Sales playbook (`/sales-playbook`) | `/my-work/*`, `/leads/{id}/workbench`, `/leads/{id}/outcome`, `/reply-draft`, `/messages`, `/sales-knowledge*`, `/course-paths*`, `/ai/controls*`, `/recovery-lists*`, `/reports/sales-playbook`, `/persons/{id}/course-suggestions` | playbook |
| My work, Workflow guide, Tasks, Communications, Notifications, Placement & Alumni | `/tasks*`, `/communications*`, `/notifications*`, `/companies`, `/job-*`, `/alumni` | operations |
| Dashboard (Overview / Performance), Branch Manager, Reports, Target Master, Offer Master, Admin / Settings, AI Copilot, Ask Nipuna, More | `/dashboard*` (incl. `/dashboard/overview`), `/reports*`, `/targets*`, `/offers*`, `/users*`, `/settings`, `/integrations`, `/incidents`, `/audit-log`, `/ai/*` | management |

### 3a. V4 look and shell

From the V4 handoff ([Part D (V4 plan)](#part-d--v4-handoff-plan-and-review), Phases 1 and 9). `prototype/` is no longer the visual reference; the published V4 UI is.

- **Theme tokens** (`src/styles.css`, `:root`): Open Sans (Google Fonts, `index.html`); `--primary #6251DA`, `--background #F8F9FC`, `--border #E7E9F0`, `--radius 0.75rem`, white sidebar; lead-chip and WhatsApp colours as `--lead-*` / `--whatsapp*`. A `.dark` token set exists for later. Cards (`.panel`, `.metric-card`): white, 1px border, 12px radius. Buttons 8px radius; tabs are underline tabs (`components/ui/tabs.tsx`); tables have a light header row and no uppercase.
- **Sidebar** (`auth/access.ts` `NAV_GROUPS`, gated with `allowed()`): Workspace (Overview, My work, AI assistant) · Sales (Leads, Deal pipeline, Demos & counselling) · Learning (Students, Admissions, Batches, LMS access) · Finance (Invoices, Payments & receipts, Collections, Refunds) · Operations (Tasks, Communications, Placement & alumni, Reports) · More (`MORE_ITEMS`: Persons, Counsellor Workspace, Branch Manager, Discount Approvals, Offer / Target / Course Master, Notifications, Sales playbook, Ask Nipuna, Admin / Settings) · Workflow guide pinned at the bottom with the signed-in person. Leads shows the new-enquiry count, Payments & receipts the claims awaiting verification. No "SAMPLE DATA" banner.
- **Header**: person search (sales roles), branch switcher ("All Branches", locked for single-branch users), Ask Nipuna (managers), notifications, account avatar menu.
- **Phone** (< 768px): bottom bar of five items from `mobileNavItems(roles)` — sales roles Home / Leads / Pipeline / Payments / AI; Accounts Home / Invoices / Payments / Collections / Tasks; trainers Home / Admissions / Batches / Tasks / Students; others Home / Tasks / Students / Alerts / More. The sidebar opens from the header. Checked at 360 and 390 px (no horizontal page scroll). `<DataTable stack>` turns a table into labelled cards on phones (opt-in).
- **Shared components** (`components/crm/ui.tsx`): `LeadChip({ value, label? })`, `PriorityChip({ priority, score? })` and `leadTone(value)` — dot + text in the lead colours (Hot / New / New Enquiry green, Warm amber, Cold blue, Waiting for Batch / Future Joining violet); `Status` renders lead priorities and "New Enquiry" as lead chips automatically. `KpiCard` (label, tinted icon, value, hint, link), `StatTile` (label + count, optional filter toggle), `Avatar`, `WhatsAppButton`; Button variant `whatsapp` (`#25D366` / `#083E20`). `PageHead` takes an `eyebrow` (defaults to the branch scope).
- **Overview** (`/dashboard`, `features/management/overview.tsx`): tabs Overview / Performance (`?tab=performance`). Overview: four KPI cards (open enquiries, admissions, verified collections, outstanding balance), verified collections per day for the last 7 days (net of reversals), admission pipeline bars with open opportunity value (the pipeline rule: approved fee, else the course's standard fee), "Your attention" tabs (follow-ups due, payment claims, admissions awaiting a batch — each shown only to roles that can open the screen) and branch pulse. Data: `GET /dashboard/overview` (`api/overview.ts`) plus the existing leads / payments / admissions lists. Performance holds every earlier KPI (incl. Long-gap plans), funnel, branch comparison, targets, approvals and the AI brief. `/branch-manager` keeps the performance layout.
- **Leads**: snapshot tiles (All enquiries / New enquiries / In counselling / Payment review) that set the lead status / stage filter; V4 table (lead, course / source, owner, stage, intake, follow-up, priority, call / WhatsApp); phone cards from `features/workspace/lead-parts.tsx`.
- **New screens** (`features/workspace/`): **LMS access** (`/lms-access`, roles as Admissions) — admissions with LMS and enrolment status, status tiles and filters, read-only (`api/lms.ts` over `GET /admissions`); **My work** (`/my-work`, all staff) — sales roles get three views: **Today** (the playbook's one ordered queue, `features/workspace/today.tsx`), **Queues** (the Counsellor Workspace tabs) and **Handover**; plus the user's open tasks. Roles without leads access see tasks only; `/counsellor` still works; **Workflow guide** (`/workflow-guide`, all staff) — the ten steps from Capture to LMS review, "record truth" definitions and where each step happens.

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

### 3c. Sales playbook screens (CRM AI v2.0)

| Screen | What it adds | Files |
|---|---|---|
| My work → Today / Handover | Ordered queue by tier (service deadlines → new / demos / replies → post-demo / follow-ups → future / reactivation), refreshed every minute; handover list with cover-task dialog | `features/workspace/today.tsx`, `my-work.tsx` |
| Lead 360 workbench | Right column: *What we know* (+ edit need), first-attempt clock and contact counters, suggested next action (Use / Edit / Ignore / Remind later), **Save outcome** (replaces the old follow-up form), Ready-to-close checklist, batches for the course, approved content; tabs Objections and the AI tab's counselling brief; reply-draft dialog that opens WhatsApp and records "Manually recorded" | `features/leads/workbench.tsx`, `lead-360.tsx` |
| Person 360 | *Useful next course* cards for students (Discussed / Ignore / Remind later; "Interest confirmed: add lead" pre-fills the new-lead dialog) | `features/persons/course-suggestions.tsx` |
| WhatsApp messages (`/whatsapp`, Operations) | Status tiles (Queued / Sent / Delivered / Read / Failed / Skipped, click to filter), banners when sending is off or limited to test numbers, search, category and status filters, a table of learner · template · message preview · status · branch, a detail dialog with the exact text, error or skip reason and timestamps, and Retry for Failed / Skipped (managers, Accounts, admins; a lost provider answer asks the user to confirm the learner did not receive it). Visible to the lead roles and Accounts | `features/operations/whatsapp-messages.tsx`, `whatsapp-shared.tsx`, `api/whatsapp.ts`, `routes/whatsapp.tsx` |
| Person 360 · WhatsApp tab | Overview and WhatsApp tabs; the WhatsApp tab has the consent card (status, who, when, source; Record / Update / Withdraw) and the conversation (what was sent with its status, the learner's replies) | `features/persons/whatsapp-tab.tsx`, `person-360.tsx` |
| Lead 360 · Send template | Beside the green wa.me button: pick one of the four marketing templates, the course (when the lead has none) and interest; consent status shown, Send disabled without Explicit Consent, with an inline Record consent; server rules shown as returned | `features/leads/send-template-dialog.tsx`, `lead-360.tsx` |
| Sales playbook (`/sales-playbook`, More) | Tabs: Knowledge & templates, Course paths, AI controls, Recovery lists, Measures | `features/management/sales-playbook.tsx`, `api/playbook.ts` |

These were checked by hand with Playwright (desktop and 390 px, no console errors); they have no e2e spec yet.

### 3d. Smooth lead → batch screens (UX build)

| Screen | What it adds | Files |
|---|---|---|
| Lead 360 · next-step bar | Sticky stepper + the one next action, Fix it, Continue to next step, trail after admission; reads `GET /leads/{id}/journey`; route `/leads/$leadId` search param `action` opens a dialog once; hover help `<Term name="…">` | `features/leads/next-step-bar.tsx`, `components/crm/term.tsx` |
| Quick-add lead | Name, Mobile, Course, Source; More details; phone lookup as you type | `features/leads/new-lead-dialog.tsx` |
| Qualification · follow-up chips | System ticks; `QualificationPanel` takes optional `onQualified` (default opens ConvertDialog); chips + `useStaffedInTwoHours` | `features/leads/qualification.tsx`, `follow-up-chips.tsx`, `workbench.tsx` (OutcomeForm) |
| Demo booking · outcome | `BookDemoDialog({ lead, onClose })` slot picker; `DemoOutcomeDue` and exported `OutcomeDialog` on My work | `features/sales/demo-booking.tsx`, `demos-page.tsx` |
| Pipeline card | Next step, blocker, days in stage, Do it. The link uses `search={{action}}` cast `as never` until the Lead 360 route declares `validateSearch` for `action` | `pipeline-board.tsx` |
| Fee discussion | Two-step screen, offer choice, live approval status, `FeeValidity({ validity })` | `features/sales/fee-validity.tsx`, `deal-panels.tsx` (`DeliveryPlanPanel`, props kept stable) |
| Record payment | `RecordPaymentDialog({ invoiceId, open, onOpenChange })`, `tokenFirstSplit`, `admitHint`; `ClaimReviewDialog` replaces the old VerifyDialog; `/payments` search param `verify`; `/invoices/$invoiceId` search param `next` (`record-payment`); `fetchProof` | `features/finance/record-payment.tsx`, `shared.tsx`, `api/payments.ts` |
| Waiting for batch (`/waiting-for-batch`, Learning) | Admitted students without a batch, delay chip, Open in LMS | `features/academics/waiting-for-batch.tsx`, `api/batch-waiting.ts`, nav entry in `auth/access.ts` |
| Person 360 · journey strip | One row per course, reads the journey per lead | `features/persons/journey-strip.tsx`, `api/person-journey.ts` |
| Lead 360 read-only | `rolesForPath` special-cases `/leads/<digits>` in `auth/access.ts`; Lead360 uses `readOnly = !hasRole(...SALES_SIDE)`; "Open lead" links on admission detail and the claim review | `features/academics/admission-detail.tsx`, `features/finance/shared.tsx` |

Backend: `services/journey.py`, `demo_slots.py`, `batch_waiting.py` (+ controller and route), route helper `lead_read_route` / `LEAD_READ_ROLES` in `routes/leads.py`, `services/whatsapp.queue(…, to_phone=…)`.

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

Every route is connected to the API. The e2e suite (incl. `v4-shell` and `v4-deals`) last passed in full on 29 Sep 2026 (V4); the LMS and playbook screens added since are covered by backend tests and manual Playwright checks only.

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

- e2e specs for the LMS and playbook screens.
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
| URL | **https://15-252-72-136.sslip.io** (sslip.io maps the dashed IP to the address; HTTP redirects to HTTPS) |
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
| `ubuntu` crontab | `flask --app app jobs run` every minute → `/srv/nipuna/jobs.log` (this runs **every registered job**, so the new `fee-expiry` and `batch-delay-alerts` need no extra line; `batch-delay-alerts` is working-day based, so `flask --app app jobs run batch-delay-alerts` hourly is also enough). Once the LMS link is live, add `flask --app app lms worker --duration 55` every minute too (delivery every 10 s, pull every minute) |

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

Applied so far: `001` to `039`, `042`, `043`, `044` and `045` (applied 10 Oct 2026; the pre-V4 backup is `/srv/nipuna/backups/nipunacrm-before-v4-2026-10-10.dump`). `040` and `041` are not used.

**Applied on 10 Oct 2026** (notes on what each file does and what the server still needs, e.g. LMS or WhatsApp settings):

- **017–025 (V4):** 019–022 rewrite the pipeline, invoice and payment triggers and backfill existing rows (one-line invoices, payment allocations, transaction numbers; pending receipts lose their receipt numbers until verified). Rehearsed on a copy of the local main database; 023–025 only relax admin role checks.
- **026–030, 032 (LMS link):** useful only once the LMS is reachable from the server, with `LMS_BASE_URL` / `LMS_SERVICE_KEY` in the server `.env` and the `lms worker` cron line. Then `flask lms backfill` and `flask lms pull --full`. 028 sets `academics_managed_in_lms` on.
- **034 (WhatsApp phases 2–4):** adds `application_code` to placement applications, `persons.whatsapp_consent*` (everyone starts at Not Recorded: record or import consent before marketing templates reach anyone) and `whatsapp_webhook_log`. Set `WHATSAPP_WEBHOOK_TOKEN`, give Pinbot the public URL `https://<server>/api/v1/webhooks/whatsapp` with that token, then read `whatsapp_webhook_log` after the first real callbacks to confirm the format.
- **033 (WhatsApp outbox):** adds `whatsapp_outbox`. On the server set `WHATSAPP_API_URL`, `WHATSAPP_API_KEY` and (until go-live) `WHATSAPP_TEST_NUMBERS` in `.env`, switch `WHATSAPP_ENABLED=1`, and add `flask jobs run whatsapp-send` to the every-minute cron. Messages are queued even while it is off; when it is switched on, only those still under `WHATSAPP_MAX_AGE_HOURS` old are sent and older ones are Skipped.
- **042 (staff WhatsApp alerts):** adds `whatsapp_outbox.recipient_user_id` and turns `whatsapp_staff_alerts_enabled` on by default (040 and 041 are not used). Staff need a number in `users.phone`; test numbers still gate every send.
- **035–039 (UX build):** 035 lets a qualification tick be made by the system; 036 and 038 add notification rules; 037 adds the preferred batch, acceptance method and confirmation request to delivery plans; 038 adds `whatsapp_staff_alerts_enabled` (false); 039 adds `working_days_between()` and the four batch-delay settings. On the server add `LMS_WEB_URL` to `.env`. The `fee-expiry` and `batch-delay-alerts` jobs run from the existing every-minute cron. The two new WhatsApp templates (`nipuna_delivery_plan_confirm_v1`, `nipuna_staff_payment_status_v1`, both Utility) need Pinbot approval before sending is switched on, and so do the 12 added by the automatic WhatsApp round ([list](#templates-to-submit-to-pinbot)).
- **031 (playbook):** seeds the six reply templates as Approved (attributed to the first Founder / Super Admin, who exists on the server) and five course paths as Draft; adds the `first-attempt` job's rules.

All files replay from scratch against `nipunacrm-dev` with a schema diff of 0. The staging seed on the server predates V4; reload it only if asked (`create-dev-db` refuses non-dev names, so it would be a manual rebuild).

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
| LMS link | Migrations applied, but `LMS_BASE_URL` / `LMS_SERVICE_KEY` are not in the server `.env`, so the LMS jobs skip; no LMS reachable from the server |
| WhatsApp | Switched on 10 Oct 2026 with `WHATSAPP_TEST_NUMBERS` set (only those numbers are messaged). Not set: `WHATSAPP_WEBHOOK_TOKEN`, so delivery callbacks and replies do not arrive. Templates without Pinbot approval fail with `(#132001)` |

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

The V4 UI handoff (`Nipuna-CRM-UI-V4-Developer-Handoff-2026-09-29.pdf`, in git history). **Built on `nipunacrm-dev` on 29 Sep 2026**; only the AWS review deploy is outstanding (on the go-ahead, see [Part C](#new-migrations)). Results against the handoff checklist: [V4 developer response](#v4-developer-response).

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

**Taken from V4:** multi-course invoices with per-course payment allocation, the per-course delivery plan, receipt numbers issued only at verification, the full visual redesign and the Open Sans font. **Kept as our own design:** see [Intentional differences from V4](#intentional-differences-from-v4). **Left out:** the "SAMPLE DATA" banner and anything V4 only simulates.

Decisions made while building, kept for the record (open ones are D8–D11 in [Part E](#part-e--backlog)):

- A new enquiry for a person who already has an open card **stays in Leads** until it is converted.
- **Re-issue:** an invoice no longer supersedes an earlier one automatically; cancel the unpaid invoice first (its courses become invoiceable again).
- The **receipt numbers** that pending / failed payments had been given at recording were cleared by 022 (they were never receipts); verified ones kept theirs.
- An automatic admission the database refuses (e.g. offer already used) is **skipped with a Branch Manager task** and stays on the eligibility review.

### V4 developer response

Response to the V4 handoff PDF (`Nipuna-CRM-UI-V4-Developer-Handoff-2026-09-29.pdf`, in git history) ("Requested developer response": review URL, completed checks, backend gaps, delivery estimate). Build plan and phase status: [Part D (V4 plan)](#part-d--v4-handoff-plan-and-review).

| | |
|---|---|
| **Review URL** | Deployed to the AWS test server on 10 Oct 2026 (migrations 017–039, 042, 043; see [Part C (deployment)](#part-c--test-deployment-aws-ec2)). The URL changes whenever the instance is restarted. |
| **Built** | 29 Sep 2026 — live CRM (Flask API + PostgreSQL + React), not a demo: real permissions, branch scoping, persistence and document numbers |
| **Tests** | At handoff: backend 205 passed · end-to-end 83 passed (3 device-specific skips), 0 failed, on desktop (1440 px) and phone (Pixel 7; 360 px checks) against a freshly seeded database. Backend now: 266 |

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
| 6. Grant LMS access | Separate: every admission is sent to the Nipuna LMS, which creates the login and enrolment (dev); the LMS access screen shows the mirrored status |

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
| LMS provisioning and recovery (V4 "Review Recovery", "Safe retry") | Built since, as the LMS link (dev): outbox with retries, status pull, refresh button, drift check ([API.md · Steps 22–23](API.md#step-22--lms-sync-outbox--dev-only)) |
| AI assistant suggestions | Claude when `ANTHROPIC_API_KEY` is set; rule-based without (no key configured yet) |
| HDFC / email / telephony integrations | Not connected (as in V4). WhatsApp: template messages go out (see the row above); inbound messages and the WhatsApp inbox are not connected |
| WhatsApp | All four phases built (dev) — 20 approved templates, 19 with an event (benefit request has none: no such record in the CRM), the outbox and sender, delivery-status and reply callbacks, the message list / retry / consent / marketing endpoints and screens ([API.md · Step 25](API.md#step-25--whatsapp-messages-outbox--dev-only)). **Not done:** the provider's real callback format is unverified (the log shows it after the first callbacks); marketing consent is empty for existing people; no bulk campaigns (marketing is one lead at a time by design); WhatsApp is not yet running on the AWS test server |
| Header "Search anything ⌘K" | Header search finds persons; the all-records palette is not built |
| Independent cash check | A recorded tick; the verifier is not yet required to be a different person from the collector |
| Decisions to confirm | Demos / fees only after conversion; chip counts all-time; conversion keeps an existing card's owner; promises per invoice ([Part E (backlog)](#part-e--backlog) D8–D11) |

#### Delivery estimate

| Remaining | Size |
|---|---|
| Deploy to the AWS test server as the review URL (backup, migrations 017–039, frontend build, smoke test) | S (under a day), on the go-ahead |
| Changes from the review and the decisions above | S–M, depending on feedback |
| Tax / bank details on the invoice template, once values are approved | S |
| Email / telephony / HDFC integrations; inbound WhatsApp | Separate projects |

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
| D5 | LLM for AI features | The code calls Claude when `ANTHROPIC_API_KEY` is set (briefs, counselling brief, Ask Nipuna); no key is configured, so answers are rule-based. Decide the key / model (`AI_MODEL`) and budget. The OpenAI / LangSmith keys in `.env` are unused |
| D6 | Production hosting | Plan: nginx serving `frontend/dist` and proxying `/api` to gunicorn on one origin |
| D7 | Offer once per person — what counts as "used" | Built: used = an admission applies the offer (discount or complimentary); counted per person across all versions of the offer; a cancelled admission releases it. Confirm cancellation should release it, and whether a still-open fee discussion or issued invoice should also reserve the offer |
| D8 | V4 open questions (defaults built — confirm) | (1) A lead gets demos / fee discussions only after qualify + convert; (2) Admitted / Closed-lost chip counts are all-time per branch; (3) tax / GSTIN / bank details are left off invoices until approved values are provided |
| D9 | V4 · conversion owner | Converting onto an existing card keeps that card's owner; the owner in the dialog applies to a new card only. Confirm, or let conversion reassign the card |
| D10 | V4 · independent cash check | Recorded as a tick at verification; should the verifier also have to be someone other than the collector for cash? |
| D11 | V4 · promises to pay | Moved to the invoice (one promise per invoice, shared by its courses). Confirm per-invoice rather than per-course promises |
| D13 | LMS · instalments on multi-course invoices | Instalments are per invoice, so each admission on a two-course invoice carries the same schedule (flagged `installments_scope: "invoice"`). Confirm the LMS shows it as the invoice's, or decide a per-course split |
| D15 | CRM AI playbook · assumptions (built — confirm) | (1) Converted leads count as contacted for the first-attempt clock (older records have no logged call); (2) alerts only for enquiries captured in the last 2 days; (3) "fee shared, learner silent" = no contact for 3 days; (4) recoverable lost reasons = timing, location, fee too high (+ any due reactivation date); (5) the six spec templates are seeded as Approved, the course paths as Draft; (6) recovery tasks go to the lead owner, else the Sales team queue |
| D16 | CRM AI playbook · release 2 | Automatic acknowledgement / reminders / unanswered sequences need a live WhatsApp provider (opt-in, 24-hour window, approved templates, delivery webhooks). `ai_branch_controls` refuses Approved automatic until then |
| D17 | LMS · batch readiness values | The CRM stores the LMS's readiness as free text and treats only `Blocked` as not public (LMS Q3). Confirm no other readiness value should hide a batch from sales |
| D18 | WhatsApp · new templates | `nipuna_delivery_plan_confirm_v1` ("Reply YES to confirm this plan"; params customer_name, branch_name, delivery_plan_no, course_name, learning_mode, start_window) and `nipuna_staff_payment_status_v1` (staff alert) await Pinbot approval. Until then plan acceptance is recorded by hand (In person / On a call) and the staff alert switch `whatsapp_staff_alerts_enabled` is now on by default (db 042). Every template to submit is listed in [Templates to submit to Pinbot](#templates-to-submit-to-pinbot) |
| D19 | LMS · preferred batch | The CRM now sends optional `admission.preferred_batch_code` on `AdmissionQualified`. The LMS has to read it (ask in the LMS repo's `nipuna crm-docs/CRM_ROUND4_BATCH_PREFERENCE.md`); unknown keys are ignored today. The delivery plan is frozen once the deal is admitted, so the preference must be set before admission |
| D20 | UX build follow-ups | `pipeline_stalled_days` has no seed row (default 7 in code; add one to make it editable in Settings); the pipeline card link casts `search` until Lead 360 declares `validateSearch` for `action`; `batch-delay-alerts` runs only while academics are managed in the LMS (the CRM's own `batch-allocation` job covers CRM-run academics); the new screens have no e2e spec beyond the updated `sales.spec.ts` "books a demo" |

#### Templates to submit to Pinbot

All Utility, language `en`, none yet approved by Pinbot (the code in `backend/services/whatsapp_templates.py` is the source of the exact wording and value order; sending to real numbers waits for approval). Values are `{{1}}`, `{{2}}` … in the order of the parameter list.

| Template | Round | Parameters (in order) | Body |
|---|---|---|---|
| `nipuna_delivery_plan_confirm_v1` | earlier | customer_name, branch_name, delivery_plan_no, course_name, learning_mode, start_window | Hello {{1}}, Nipuna Technologies, {{2}}, has prepared your delivery plan {{3}} for {{4}}. Learning mode: {{5}}. Planned start window: {{6}}. Please reply YES to confirm this plan. Batch allocation and admission confirmation are separate updates. |
| `nipuna_staff_payment_status_v1` | earlier | staff_name, transaction_no, learner_name, payment_amount, outcome, outcome_detail | Hello {{1}}, Accounts at Nipuna Technologies has reviewed payment claim {{2}} for {{3}} of INR {{4}}. Outcome: {{5}}. {{6}} Please open the CRM to see the details and follow up with the learner. |
| `nipuna_demo_booked_u_v1` | W1 | customer_name, course_name, branch_name, demo_time, demo_venue, trainer_name | Hello {{1}}, your demo session for {{2}} at Nipuna Technologies, {{3}}, is booked for {{4}}. Venue: {{5}}. Trainer: {{6}}. Please reach a few minutes early. Contact our counsellor if you need to change the time. |
| `nipuna_demo_rescheduled_u_v1` | W1 | customer_name, course_name, branch_name, demo_time, demo_venue, trainer_name | Hello {{1}}, your demo session for {{2}} at Nipuna Technologies, {{3}}, has been moved to {{4}}. Venue: {{5}}. Trainer: {{6}}. Your earlier time no longer applies. |
| `nipuna_demo_cancelled_u_v1` | W1 | customer_name, course_name, branch_name, demo_time | Hello {{1}}, your demo session for {{2}} at Nipuna Technologies, {{3}}, planned for {{4}}, has been cancelled. Our counsellor will contact you to arrange another time if you wish. |
| `nipuna_demo_reminder_u_v1` | W1 | customer_name, branch_name, course_name, starts_in, demo_time, demo_venue, trainer_name | Hello {{1}}, a reminder from Nipuna Technologies, {{2}}: your demo session for {{3}} starts in {{4}}, at {{5}}. Venue: {{6}}. Trainer: {{7}}. |
| `nipuna_staff_demo_reminder_v1` | W1 | staff_name, learner_name, course_name, starts_in, demo_time, demo_venue | Hello {{1}}, a reminder from the Nipuna CRM: you take the {{3}} demo for {{2}} in {{4}}, at {{5}}. Venue: {{6}}. |
| `nipuna_admission_confirmed_u_v1` | W1 | customer_name, branch_name, admission_no, course_name, learning_mode, start_date | Hello {{1}}, your admission at Nipuna Technologies, {{2}}, is confirmed. Admission number: {{3}}. Course: {{4}}. Learning mode: {{5}}. Planned start: {{6}}. Our academic team will share your batch and class details separately. |
| `nipuna_instalment_due_u_v1` | W2 | customer_name, branch_name, invoice_no, installment_no, amount_due, due_date, invoice_channel | Hello {{1}}, this is a friendly reminder from Nipuna Technologies, {{2}}. Instalment {{4}} of invoice {{3}} (INR {{5}}) is due on {{6}}. To pay, please contact {{7}}. If you have already paid, please ignore this message. |
| `nipuna_instalment_overdue_u_v1` | W2 | customer_name, branch_name, invoice_no, installment_no, amount_due, due_date, invoice_channel | Hello {{1}}, Nipuna Technologies, {{2}}, has not yet received instalment {{4}} of invoice {{3}} (INR {{5}}), which was due on {{6}}. Please make the payment at the earliest by contacting {{7}}. If you have already paid, please share the details with us so we can update your account. |
| `nipuna_staff_lead_assigned_v1` | W3 | staff_name, learner_name, course_name, branch_name, response_note | Hello {{1}}, a new lead has been assigned to you at Nipuna Technologies: {{2}} for {{3}} at the {{4}} branch. {{5}} Please open the CRM to follow up. |
| `nipuna_staff_leads_assigned_v1` | W3 | staff_name, lead_count, branch_name | Hello {{1}}, {{2}} new leads have been assigned to you at Nipuna Technologies ({{3}}). Please open the CRM, My leads, to start following them up. |
| `nipuna_staff_approval_waiting_v1` | W3 | staff_name, request_code, learner_name, requested_extra, branch_name | Hello {{1}}, special closing request {{2}} for {{3}} of INR {{4}} at the {{5}} branch is waiting for your approval at Nipuna Technologies. Please open the CRM to decide it. |
| `nipuna_staff_payment_to_verify_v1` | W3 | staff_name, transaction_no, learner_name, payment_amount, payment_mode, reference | Hello {{1}}, payment claim {{2}} from {{3}} of INR {{4}} by {{5}} (reference {{6}}) is waiting for verification at Nipuna Technologies. Please open the CRM to verify it. |

**The nine LMS templates (round 6).** Sent by the LMS through `POST /lms/whatsapp`. Their drafts, with buttons and sample values, are in the LMS repo `docs/whatsapp-templates/` (replace `LMS_HOST` in each button before submitting); the CRM's copy, which must match what Pinbot approves, is `LMS_TEMPLATES` in `whatsapp_templates.py`: `nipuna_lms_password_reset_code_auth_v1` (Authentication, Copy code), `nipuna_lms_student_activation_link_u_v1`, `nipuna_lms_staff_account_invite_u_v1` (URL button with the token), `nipuna_lms_class_reminder_u_v1`, `nipuna_lms_class_cancelled_u_v1`, `nipuna_lms_class_rescheduled_u_v1`, `nipuna_lms_result_published_u_v1`, `nipuna_lms_certificate_issued_u_v1` (URL button with the certificate number), `nipuna_lms_batch_change_agreement_u_v1`. If Pinbot approves a different wording, update both copies.

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
- Role checks that differ from the prototype wording: approve extra demo is Branch Manager only (db 043 merged the Academic Coordinator role into Branch Manager); `/concession-limits` and `/offers` are admin / BM only, so counsellors can't see their limits or pick offers for complimentary courses.

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
- "Open LMS" link and "Open class link", collecting branch on admissions, email resend, channel status chips, support-period extensions (endpoint exists, not exposed).
