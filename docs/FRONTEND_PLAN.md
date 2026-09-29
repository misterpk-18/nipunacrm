# Nipuna CRM — Frontend Plan

React single-page app in `frontend/`, connected to the Flask API (`backend/`, see [API_PLAN.md](API_PLAN.md)). The Lovable prototype in `prototype/` stays as the **reference** for layout and wording; it will keep changing, and changes are ported screen by screen (see "Porting prototype changes").

---

## 1. Decisions

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

## 2. Structure

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

## 3. Screens → API

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

## 3a. V4 look and shell

From the V4 handoff ([V4_PLAN.md](V4_PLAN.md), Phases 1 and 9). `prototype/` is no longer the visual reference; the published V4 UI is.

- **Theme tokens** (`src/styles.css`, `:root`): Open Sans (Google Fonts, `index.html`); `--primary #6251DA`, `--background #F8F9FC`, `--border #E7E9F0`, `--radius 0.75rem`, white sidebar; lead-chip and WhatsApp colours as `--lead-*` / `--whatsapp*`. A `.dark` token set exists for later. Cards (`.panel`, `.metric-card`): white, 1px border, 12px radius. Buttons 8px radius; tabs are underline tabs (`components/ui/tabs.tsx`); tables have a light header row and no uppercase.
- **Sidebar** (`auth/access.ts` `NAV_GROUPS`, gated with `allowed()`): Workspace (Overview, My work, AI assistant) · Sales (Leads, Deal pipeline, Demos & counselling) · Learning (Students, Admissions, Batches, LMS access) · Finance (Invoices, Payments & receipts, Collections, Refunds) · Operations (Tasks, Communications, Placement & alumni, Reports) · More (`MORE_ITEMS`: Persons, Counsellor Workspace, Branch Manager, Discount Approvals, Offer / Target / Course Master, Notifications, Ask Nipuna, Admin / Settings) · Workflow guide pinned at the bottom with the signed-in person. Leads shows the new-enquiry count, Payments & receipts the claims awaiting verification. No "SAMPLE DATA" banner.
- **Header**: person search (sales roles), branch switcher ("All Branches", locked for single-branch users), Ask Nipuna (managers), notifications, account avatar menu.
- **Phone** (< 768px): bottom bar of five items from `mobileNavItems(roles)` — sales roles Home / Leads / Pipeline / Payments / AI; Accounts Home / Invoices / Payments / Collections / Tasks; coordinators and trainers Home / Admissions / Batches / Tasks / Students; others Home / Tasks / Students / Alerts / More. The sidebar opens from the header. Checked at 360 and 390 px (no horizontal page scroll). `<DataTable stack>` turns a table into labelled cards on phones (opt-in).
- **Shared components** (`components/crm/ui.tsx`): `LeadChip({ value, label? })`, `PriorityChip({ priority, score? })` and `leadTone(value)` — dot + text in the lead colours (Hot / New / New Enquiry green, Warm amber, Cold blue, Waiting for Batch / Future Joining violet); `Status` renders lead priorities and "New Enquiry" as lead chips automatically. `KpiCard` (label, tinted icon, value, hint, link), `StatTile` (label + count, optional filter toggle), `Avatar`, `WhatsAppButton`; Button variant `whatsapp` (`#25D366` / `#083E20`). `PageHead` takes an `eyebrow` (defaults to the branch scope).
- **Overview** (`/dashboard`, `features/management/overview.tsx`): tabs Overview / Performance (`?tab=performance`). Overview: four KPI cards (open enquiries, admissions, verified collections, outstanding balance), verified collections per day for the last 7 days (net of reversals), admission pipeline bars with open opportunity value (the pipeline rule: approved fee, else the course's standard fee), "Your attention" tabs (follow-ups due, payment claims, admissions awaiting a batch — each shown only to roles that can open the screen) and branch pulse. Data: `GET /dashboard/overview` (`api/overview.ts`) plus the existing leads / payments / admissions lists. Performance holds every earlier KPI (incl. Long-gap plans), funnel, branch comparison, targets, approvals and the AI brief. `/branch-manager` keeps the performance layout.
- **Leads**: snapshot tiles (All enquiries / New enquiries / In counselling / Payment review) that set the lead status / stage filter; V4 table (lead, course / source, owner, stage, intake, follow-up, priority, call / WhatsApp); phone cards from `features/workspace/lead-parts.tsx`.
- **New screens** (`features/workspace/`): **LMS access** (`/lms-access`, roles as Admissions) — admissions with curriculum, LMS and enrolment status, status tiles and filters, read-only (`api/lms.ts` over `GET /admissions`); **My work** (`/my-work`, all staff) — the Counsellor Workspace queues (own leads for counsellors, branch scope for managers) plus the user's open tasks; roles without leads access see tasks only; `/counsellor` still works; **Workflow guide** (`/workflow-guide`, all staff) — the ten steps from Capture to LMS review, "record truth" definitions and where each step happens.

## 3b. V4 deals, invoices and receipts

From the V4 handoff, Phases 2–8 ([V4_PLAN.md](V4_PLAN.md); API step 21 in [API_PLAN.md](API_PLAN.md)).

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

## 4. Definition of done (every screen)

- Real data from the API; no sample labels or simulated behaviour.
- Loading, error and empty states; mutations toast success / error and invalidate affected queries.
- Actions hidden for roles that can't use them; server 403 / 422 messages surface as toasts.
- List requests honour the branch switcher and paginate.
- Works at phone width (tables scroll inside their panel).
- Covered by a Playwright spec that passes against `nipunacrm-dev` and can be re-run.

## 5. Running and testing

The API runs against `nipunacrm-dev` (`APP_ENV=development`); `nipunacrm` is never touched by local development or tests. Setup, staging accounts, run and test commands: [DEVELOPMENT.md](DEVELOPMENT.md).

Current status (29 Sep 2026, V4): every route is connected to the API; the e2e suite (incl. `v4-shell` and `v4-deals`) passes on desktop and phone width against a freshly seeded dev database.

| Command (from `frontend/`) | What it does |
|---|---|
| `npm run dev` | Dev server with HMR on :5173; regenerates `src/routeTree.gen.ts` |
| `npm run build` / `npm run typecheck` | Production build / type-check |
| `npx playwright test` | E2E against the running dev stack (desktop + `@mobile`) |

## 6. Porting prototype changes

The prototype will keep changing. When a new version arrives:

1. Replace `prototype/` and diff `src/components/crm/screens.tsx`, `workflows.tsx` and `src/lib/crm-store.tsx` against the previous version.
2. For each changed screen, update the matching `frontend/src/features/<group>/` component (layout, wording, columns).
3. New behaviour the API doesn't support yet → add it to [API_PLAN.md](API_PLAN.md) first (backend step + migration if needed), then wire the screen.
4. Update the e2e spec for that screen and re-run against a freshly seeded dev database.

## 7. Backend additions made for the frontend

Gaps still open are listed in [BACKLOG.md](BACKLOG.md).


- `GET /staff` — staff directory for pickers (non-admins can't call `/users`).
- `GET /dashboard/overview` — V4 Overview figures (KPI cards, 7-day verified collections, pipeline bars, attention counts, branch pulse); all staff, branch-scoped.
- Task list link filters (`?lead_id=`, `?admission_id=`, …) for the Lead 360 / Student 360 task tabs.
- `flask create-dev-db` / `flask seed-dev` — dev replica and staging data.

## 8. Later

- Production build + reverse proxy config (nginx: `dist/` + `/api` → gunicorn).
- AI features on the chosen LLM (OpenAI / LangSmith keys are in `.env`, not used yet).
- File storage for documents in production and the other open decisions in [BACKLOG.md](BACKLOG.md).
