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
├── e2e/                Playwright specs per group (auth-leads, sales, finance, academics, operations, management) + helpers.ts
└── vite.config.ts      /api proxy → 127.0.0.1:5050
```

## 3. Screens → API

| Screen (route) | Main endpoints | Group |
|---|---|---|
| Login, change password, account (`/login`, `/change-password`, `/account`) | `/auth/*` | core |
| Leads, Lead 360 (`/leads`, `/leads/$leadId`) | `/leads*`, `/saved-views`, `/lead-imports`, `/persons`, `/staff` | leads |
| Counsellor workspace, Pipeline, Demos, Fee discussion, Discount approvals | `/leads/workspace`, `/pipeline`, `/demos*`, `/fee-discussions*`, `/special-closing-requests*` | sales |
| Invoices, Payments, Collections, Refunds | `/invoices*`, `/payments*`, `/correction-requests*`, `/collections/*`, `/payment-promises*`, `/refund-cases*` | finance |
| Admissions, New admission, Batches, Students / Student 360, Course Master | `/admissions*`, `/batches*`, `/curriculum-versions*`, `/students*`, `/documents*`, `/courses*`, `/payment-plans*` | academics |
| Tasks, Communications, Notifications, Placement & Alumni | `/tasks*`, `/communications*`, `/notifications*`, `/companies`, `/job-*`, `/alumni` | operations |
| Dashboard, Branch Manager, Reports, Target Master, Offer Master, Admin / Settings, AI Copilot, Ask Nipuna, More | `/dashboard*`, `/reports*`, `/targets*`, `/offers*`, `/users*`, `/settings`, `/integrations`, `/incidents`, `/audit-log`, `/ai/*` | management |

## 4. Definition of done (every screen)

- Real data from the API; no sample labels or simulated behaviour.
- Loading, error and empty states; mutations toast success / error and invalidate affected queries.
- Actions hidden for roles that can't use them; server 403 / 422 messages surface as toasts.
- List requests honour the branch switcher and paginate.
- Works at phone width (tables scroll inside their panel).
- Covered by a Playwright spec that passes against `nipunacrm-dev` and can be re-run.

## 5. Running and testing

The API runs against `nipunacrm-dev` (`APP_ENV=development`); `nipunacrm` is never touched by local development or tests. Setup, staging accounts, run and test commands: [DEVELOPMENT.md](DEVELOPMENT.md).

Current status (27 Sep 2026): every route is connected to the API; the e2e suite passes — 63 tests on desktop and phone width, re-runnable without reseeding.

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
- Task list link filters (`?lead_id=`, `?admission_id=`, …) for the Lead 360 / Student 360 task tabs.
- `flask create-dev-db` / `flask seed-dev` — dev replica and staging data.

## 8. Later

- Production build + reverse proxy config (nginx: `dist/` + `/api` → gunicorn).
- AI features on the chosen LLM (OpenAI / LangSmith keys are in `.env`, not used yet).
- File storage for documents in production and the other open decisions in [BACKLOG.md](BACKLOG.md).
