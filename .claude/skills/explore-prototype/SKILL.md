---
name: explore-prototype
description: Understand or verify how the Lovable Nipuna CRM prototype in prototype/ behaves — read its source and run it with Playwright to tour every screen and click through workflows. Use when comparing the database or APIs against the prototype, when a user asks how a screen or rule works, or when a new prototype version (zip / repo) arrives.
---

# Exploring the prototype (prototype/)

A frontend-only React (TanStack Start + Vite) prototype with synthetic data kept in browser memory. It is the product reference for the backend. Don't edit it — it syncs back to Lovable (see `prototype/AGENTS.md`).

## 1. Read the source first (fast, exact)

| File | What it holds |
|---|---|
| `src/lib/crm-store.tsx` | Data model (types), sample records, **workflow rules** (addLead, logFollowUp, scheduleDemo / reschedule / cancel / outcome, recordPayment, verifyPayment, requestCorrection, decideCorrection, allocate, recordFirstAttendance), derived maths (invoiceSummary, allocationCheck, taskCondition, periodRange) |
| `src/components/crm/workflows.tsx` | Forms and their validation: Leads (filters, saved views, bulk assign, New Lead / Add Another Course, CSV import review), Lead 360, Demos, Admissions, Students / Student 360, Invoices, Payments, Collections, Batches, Reports |
| `src/components/crm/screens.tsx` | Dashboards, Pipeline, Fee Discussion, Special Closing, Create Admission, Refunds, Tasks, Communications, AI Copilot / Ask Nipuna, Course / Offer / Target Master, Notifications, Placement, Admin, Login |
| `src/components/crm/crm-scope.tsx` | Prototype roles (Founder / CEO, Super Admin, `<Branch> <Role>` for Branch Manager, Sales, Front Office, Accounts, Academic Coordinator, Trainer, Placement Team, HR, Student) and branch locking |
| `src/routes/*.tsx` | One file per URL (`leads.$leadId.tsx` → `/leads/:leadId`) |
| `roadmap.md`, `.lovable/plan.md` | What changed in each prototype version |

Grep for rule text, e.g. `grep -n "Blocked:\|required\|never" src/lib/crm-store.tsx src/components/crm/workflows.tsx`.

## 2. Run it

```bash
cd prototype
npm install --no-audit --no-fund          # first time only (no bun on this machine); node_modules is gitignored
npx vite dev --port 5173 --host 127.0.0.1  # run in the background, then poll http://127.0.0.1:5173/ until 200
```
Stop it when done (`pkill -f "vite dev --port 5173"`).

## 3. Playwright setup (outside the repo)

Install Playwright in the session scratchpad (never into `prototype/package.json`):
```bash
PW=<scratchpad>/pw && mkdir -p $PW && cd $PW && npm init -y >/dev/null && npm i --no-audit --no-fund playwright
```
Launch with `channel: 'chrome'` (the installed Google Chrome) — the bundled Chromium build often doesn't match the installed Playwright version. Run the skill scripts with `NODE_PATH=$PW/node_modules node <script>`.

## 4. Tour every screen

```bash
NODE_PATH=$PW/node_modules ROLE="Founder / CEO" OUT=$PW/tour \
  node .claude/skills/explore-prototype/scripts/tour.js
```
Builds the route list from `src/routes/`, fills `$params` with sample IDs, and writes one full-page screenshot per route plus `tour.txt` (the page text) to `OUT`. Read `tour.txt`; open screenshots with the Read tool when layout matters. It reports page errors.

## 5. Click through workflows

Use `scripts/flow-helpers.js` in your own script:
```js
const { start } = require('<repo>/.claude/skills/explore-prototype/scripts/flow-helpers.js');
(async () => {
  const f = await start({ role: 'Guntur Accounts', path: '/payments' });
  await f.page.locator('tr', { hasText: 'GNT-R-2627-00002' }).getByRole('button', { name: 'Verify' }).click();
  console.log(await f.toasts());                    // sonner toast text since the last call
  await f.clickLink('/invoices/INV-GNT-2627-0001'); // client-side navigation keeps in-memory state
  console.log(await f.section('Correction requests'));
  await f.switchRole('Super Admin');                // uses the in-app role switcher
  await f.close();
})();
```
Rules that bite:
- **Data lives in memory.** `page.goto()` / reload resets every change; within a flow, navigate with `clickLink(href)` and switch roles with `switchRole()`.
- The first role comes from `sessionStorage` keys `nipuna-prototype-role` / `nipuna-prototype-branch` (set by `start()`).
- Results appear as toasts (`[data-sonner-toast]`), blocked actions as `Blocked: …` toasts or inline warnings.
- Sample clock is fixed: Saturday 26 Sep 2026, 12:00 IST.

## 6. New prototype version

1. Unzip into the scratchpad, compare with the current copy: `diff -rq <new> prototype -x node_modules`.
2. Read `roadmap.md` for the version notes; diff `crm-store.tsx`, `workflows.tsx`, `screens.tsx`.
3. Replace `prototype/` contents (keep `node_modules` if the lockfile didn't change), then tour + flows.

## 7. Turn findings into work

- Schema gaps → `db-migration` skill (new numbered migration, tests, `docs/DATABASE.md`).
- Endpoint changes → `docs/API.md` (see `build-api-step`), marking what's still to build.
- Tell the user which behaviours you **observed running** versus only read in code, and list anything you had to assume.
