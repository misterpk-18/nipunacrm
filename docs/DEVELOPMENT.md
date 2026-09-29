# Nipuna CRM — Development Guide

How to set up, run and test the CRM locally. Architecture and conventions: [API_PLAN.md](API_PLAN.md) (backend), [FRONTEND_PLAN.md](FRONTEND_PLAN.md) (frontend), [DB_PHASES.md](DB_PHASES.md) (schema).

---

## 1. Repository layout

```
nipuna-crm/
├── backend/      Flask API (routes → controllers → services → repositories → models), pytest suite, CLI
├── frontend/     React SPA (Vite + TanStack Router/Query), Playwright e2e tests
├── db/           Numbered SQL migrations — the source of truth for the schema
├── prototype/    Lovable prototype — reference only for layout and wording; it will keep changing
├── docs/         All project documentation (this folder)
└── venv/         Python virtualenv
```

## 2. Configuration (`backend/.env`)

| Variable | Purpose |
|---|---|
| `APP_ENV` | `development` (uses the dev database), `test`, `production` |
| `DATABASE_URL` | Main database `nipunacrm`; production config |
| `DEV_DATABASE_URL` | Dev replica `nipunacrm-dev` with staging data; used when `APP_ENV=development` |
| `TEST_DATABASE_URL` | Optional; defaults to `DATABASE_URL` + `_test` (`nipunacrm_test`) |
| `SECRET_KEY`, `LOG_LEVEL`, `UPLOAD_DIR` | App settings |
| `OPENAI_API_KEY`, `LANGSMITH_*` | Reserved for future AI work — not read by the code yet |

`backend/.env.example` lists the same variables without secrets.

## 3. Databases

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

### Staging accounts

Also in [STAGING_ACCOUNTS.md](STAGING_ACCOUNTS.md).

All use the password **`Nipuna-staging-1`**, domain `@nipuna.test`:

| Role | Guntur (branch 1) | Vijayawada (branch 2) |
|---|---|---|
| Founder / CEO | `founder` (company-wide) | |
| Super Admin | `admin` (company-wide) | |
| Branch Manager | `bm.gnt` | `bm.vij` |
| Sales (counsellor) | `sales.gnt` | `sales.vij` |
| Front Office | `fo.gnt` | `fo.vij` |
| Accounts | `accounts.gnt` | `accounts.vij` |
| Academic Coordinator | `coordinator.gnt` | `coordinator.vij` |
| Trainer | `trainer.g1`, `trainer.g2` | `trainer.v1`, `trainer.v2` |
| Placement | `placement.gnt` | `placement.vij` |
| HR | `hr.gnt` | `hr.vij` |

## 4. Running

```bash
# API on :5050 (macOS AirPlay occupies :5000)
cd backend && source ../venv/bin/activate
APP_ENV=development flask --app app run --port 5050

# Frontend on :5173 (proxies /api → 127.0.0.1:5050; override with VITE_API_TARGET)
cd frontend && npm install && npm run dev
```

Open http://localhost:5173 and sign in with a staging account.

Other backend commands (from `backend/`): `flask --app app create-admin` (first admin on a fresh database), `flask --app app jobs list | run [name…]` (background jobs), `flask --app app create-test-db`.

## 5. Testing

| Suite | Command | Notes |
|---|---|---|
| Backend | `cd backend && ../venv/bin/pytest -q` | Rebuilds `nipunacrm_test`; each test runs in a rolled-back transaction |
| Frontend types | `cd frontend && npm run typecheck` | |
| Frontend build | `cd frontend && npm run build` | Type-check + production build into `dist/` |
| End-to-end | `cd frontend && npx playwright test` | Needs the API (dev DB) and Vite running; desktop + `@mobile` projects |

E2E specs live in `frontend/e2e/` (`auth-leads`, `sales`, `finance`, `academics`, `operations`, `management`, `v4-shell`, `v4-deals`); `e2e/helpers.ts` has the staging users, `login()` and API setup helpers for the V4 flow (`qualifyAndConvert`, `approvedFee`, `acceptDeliveryPlan`, `createInvoice`, `recordPayment`, `verifyPayment`). `E2E_BASE_URL` points Playwright at another Vite port. Tests create their own records with unique phones/names, so they can be re-run without reseeding. Run one Playwright process at a time — parallel runs share `test-results/` (use `--output=<dir>` if you must run two).

## 6. Docs to keep up to date

| When you… | Update |
|---|---|
| Add or change a migration | [DB_PHASES.md](DB_PHASES.md) (status table + section) |
| Add or change an endpoint | [API_PLAN.md](API_PLAN.md) (endpoint table + "As built"), `backend/api.http` |
| Change a screen or frontend convention | [FRONTEND_PLAN.md](FRONTEND_PLAN.md) |
| Find a gap or make a product decision | [BACKLOG.md](BACKLOG.md) |
| Change setup, environments or test commands | this file |
| Change the server, deploy steps, or apply a migration on it | [DEPLOYMENT.md](DEPLOYMENT.md) ("Applied so far" list) |
